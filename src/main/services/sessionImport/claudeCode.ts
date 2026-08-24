import fs from 'node:fs';
import path from 'node:path';
import type { ExternalSession, SimpleMessage } from '@shared/types/sessionImport';

/** Claude Code 把项目路径编码为目录名：非字母数字统一替换为 '-' */
export function encodeClaudeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

const parseLine = (line: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
};

/** 从 Claude Code 消息行提取纯文本（string 或 parts 数组两种形态） */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && (part as { type?: string }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : ''
    )
    .join('');
}

/** 解析单个 Claude Code 会话文件为拉平消息（跳过 sidechain、工具与空文本轮次） */
export function readClaudeSession(filePath: string): { title: string; messages: SimpleMessage[] } {
  const messages: SimpleMessage[] = [];
  let aiTitle = '';
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { title: '', messages: [] };
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (!entry) continue;
    if (entry.type === 'ai-title' && typeof entry.title === 'string') {
      aiTitle = entry.title;
      continue;
    }
    if (entry.isSidechain === true) continue;
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const text = textOfContent(message.content).trim();
    if (!text) continue;
    // Claude Code 会把工具结果等包装成 user 行；<system>/<local-command> 类噪声跳过
    if (message.role === 'user' && /^<[a-z-]+/.test(text)) continue;
    const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined;
    messages.push({ role: message.role, text, timestamp });
  }
  const title = aiTitle || messages.find((m) => m.role === 'user')?.text.slice(0, 40) || '';
  return { title, messages };
}

/** 列出 Claude Code 在某项目目录下的会话 */
export function listClaudeSessions(
  projectPath: string,
  home = process.env.HOME ?? ''
): ExternalSession[] {
  const dir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(projectPath));
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const sessions: ExternalSession[] = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    const { title, messages } = readClaudeSession(filePath);
    if (messages.length === 0) continue;
    let updatedAt = 0;
    try {
      updatedAt = fs.statSync(filePath).mtimeMs;
    } catch {}
    sessions.push({ path: filePath, title, updatedAt, messageCount: messages.length });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}
