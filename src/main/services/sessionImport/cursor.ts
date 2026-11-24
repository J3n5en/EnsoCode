import fs from 'node:fs';
import path from 'node:path';
import type { SimpleMessage } from '@shared/types/sessionImport';
import type { ScannedSession } from './types';

const parseLine = (line: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
};

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

function unwrapUserQuery(text: string): string {
  const match = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
  if (match?.[1]) return match[1].trim();
  return /^</.test(text) ? '' : text;
}

/** Cursor 把项目路径编码为目录名：去掉开头 /，其余 / 换成 - */
export function encodeCursorProjectDir(projectPath: string): string {
  return projectPath.replace(/^[\\/]+/, '').replaceAll(/[\\/]/g, '-');
}

/** 解析 Cursor agent-transcripts jsonl 为拉平消息 */
export function readCursorSession(filePath: string): { title: string; messages: SimpleMessage[] } {
  const messages: SimpleMessage[] = [];
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
    if (entry.role !== 'user' && entry.role !== 'assistant') continue;
    const message = entry.message as { content?: unknown } | undefined;
    const text = unwrapUserQuery(textOfContent(message?.content).trim());
    if (!text) continue;
    messages.push({ role: entry.role, text });
  }
  const title = messages.find((m) => m.role === 'user')?.text.slice(0, 40) || '';
  return { title, messages };
}

/** 列出 Cursor 在某项目目录下的会话 */
export function listCursorSessions(
  projectPath: string,
  home = process.env.HOME ?? ''
): ScannedSession[] {
  const dir = path.join(
    home,
    '.cursor',
    'projects',
    encodeCursorProjectDir(projectPath),
    'agent-transcripts'
  );
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: ScannedSession[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(dir, entry.name, `${entry.name}.jsonl`);
    const { title, messages } = readCursorSession(filePath);
    if (messages.length === 0) continue;
    let updatedAt = 0;
    try {
      updatedAt = fs.statSync(filePath).mtimeMs;
    } catch {}
    sessions.push({ path: filePath, title, updatedAt, messageCount: messages.length });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}
