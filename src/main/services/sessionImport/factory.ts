import fs from 'node:fs';
import path from 'node:path';
import type { SimpleMessage } from '@shared/types/sessionImport';
import { encodeClaudeProjectDir } from './claudeCode';
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

/** 解析 Factory 会话 jsonl 为拉平消息 */
export function readFactorySession(filePath: string): { title: string; messages: SimpleMessage[] } {
  const messages: SimpleMessage[] = [];
  let titled = '';
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
    if (entry.type === 'session_start' && typeof entry.title === 'string' && entry.title.trim()) {
      titled = entry.title.trim();
      continue;
    }
    if (entry.type !== 'message') continue;
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const text = textOfContent(message.content).trim();
    if (!text) continue;
    if (message.role === 'user' && /^<[a-z-]+/.test(text)) continue;
    const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined;
    messages.push({
      role: message.role,
      text,
      timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
    });
  }
  const title = titled || messages.find((m) => m.role === 'user')?.text.slice(0, 40) || '';
  return { title, messages };
}

/** 列出 Factory 在某项目目录下的会话 */
export function listFactorySessions(
  projectPath: string,
  home = process.env.HOME ?? ''
): ScannedSession[] {
  const dir = path.join(home, '.factory', 'sessions', encodeClaudeProjectDir(projectPath));
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const sessions: ScannedSession[] = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    const { title, messages } = readFactorySession(filePath);
    if (messages.length === 0) continue;
    let updatedAt = 0;
    try {
      updatedAt = fs.statSync(filePath).mtimeMs;
    } catch {}
    sessions.push({ path: filePath, title, updatedAt, messageCount: messages.length });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}
