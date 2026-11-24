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

function readSummary(dir: string): { title: string; updatedAt?: number } {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf-8')) as {
      session_summary?: unknown;
      updated_at?: unknown;
    };
    const title = typeof raw.session_summary === 'string' ? raw.session_summary : '';
    const updatedAt = typeof raw.updated_at === 'string' ? Date.parse(raw.updated_at) : undefined;
    return { title, updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined };
  } catch {
    return { title: '' };
  }
}

/** 解析 Grok CLI 的 chat_history.jsonl 为拉平消息 */
export function readGrokSession(filePath: string): { title: string; messages: SimpleMessage[] } {
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
    if (entry.synthetic_reason != null) continue;
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const text = unwrapUserQuery(textOfContent(entry.content).trim());
    if (!text) continue;
    const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined;
    messages.push({
      role: entry.type,
      text,
      timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
    });
  }
  const title =
    readSummary(path.dirname(filePath)).title ||
    messages.find((m) => m.role === 'user')?.text.slice(0, 40) ||
    '';
  return { title, messages };
}

/** 列出 Grok CLI 在某项目目录下的会话 */
export function listGrokSessions(
  projectPath: string,
  home = process.env.HOME ?? ''
): ScannedSession[] {
  const dir = path.join(home, '.grok', 'sessions', encodeURIComponent(projectPath));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: ScannedSession[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(dir, entry.name, 'chat_history.jsonl');
    const { title, messages } = readGrokSession(filePath);
    if (messages.length === 0) continue;
    const summary = readSummary(path.dirname(filePath));
    let updatedAt = summary.updatedAt ?? 0;
    if (!updatedAt) {
      try {
        updatedAt = fs.statSync(filePath).mtimeMs;
      } catch {}
    }
    sessions.push({
      path: filePath,
      title: summary.title || title,
      updatedAt,
      messageCount: messages.length,
    });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}
