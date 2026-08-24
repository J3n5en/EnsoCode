import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SimpleMessage } from '@shared/types/sessionImport';

/**
 * 把拉平消息写成 pi 可 resume 的 session jsonl（header + message entry 链）。
 * 格式对齐 pi SessionManager v3：entry 的 parentId 串成单链。
 * 返回写入的文件路径。
 */
export function writePiSession(cwd: string, messages: SimpleMessage[], sessionDir: string): string {
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, '-');
  const filePath = path.join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);

  const lines: string[] = [
    JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp, cwd }),
  ];
  let parentId: string | null = null;
  const usedIds = new Set<string>();
  for (const message of messages) {
    let id = randomUUID().slice(0, 8);
    while (usedIds.has(id)) id = randomUUID().slice(0, 8);
    usedIds.add(id);
    const messageTimestamp = message.timestamp ?? Date.now();
    const payload =
      message.role === 'user'
        ? { role: 'user', content: message.text, timestamp: messageTimestamp }
        : {
            role: 'assistant',
            content: [{ type: 'text', text: message.text }],
            api: 'anthropic-messages',
            provider: 'imported',
            model: 'imported',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            timestamp: messageTimestamp,
          };
    lines.push(
      JSON.stringify({
        type: 'message',
        id,
        parentId,
        timestamp: new Date(messageTimestamp).toISOString(),
        message: payload,
      })
    );
    parentId = id;
  }

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}
