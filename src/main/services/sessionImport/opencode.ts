import fs from 'node:fs';
import path from 'node:path';
import type { SimpleMessage } from '@shared/types/sessionImport';
import type { ScannedSession } from './types';

const readJson = (filePath: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const listDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

const storageRootOf = (sessionFile: string): string =>
  path.dirname(path.dirname(path.dirname(sessionFile)));

const sessionIdOf = (sessionFile: string): string => path.basename(sessionFile, '.json');

function textPartsOf(storageRoot: string, messageId: string): string {
  const dir = path.join(storageRoot, 'part', messageId);
  return listDir(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readJson(path.join(dir, name)))
    .filter((part): part is Record<string, unknown> => part?.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('')
    .trim();
}

/** 从 session 元数据 json 读出拉平消息 */
export function readOpencodeSession(sessionFile: string): {
  title: string;
  messages: SimpleMessage[];
} {
  const session = readJson(sessionFile);
  const title = typeof session?.title === 'string' ? session.title : '';
  if (!session) return { title: '', messages: [] };
  const storageRoot = storageRootOf(sessionFile);
  const sessionId = typeof session.id === 'string' ? session.id : sessionIdOf(sessionFile);
  const messageDir = path.join(storageRoot, 'message', sessionId);
  const messages: SimpleMessage[] = [];
  const files = listDir(messageDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const filePath = path.join(messageDir, name);
      const data = readJson(filePath);
      const created =
        data && typeof data.time === 'object' && data.time
          ? Number((data.time as { created?: unknown }).created)
          : 0;
      return { filePath, data, created: Number.isFinite(created) ? created : 0 };
    })
    .sort((a, b) => a.created - b.created || a.filePath.localeCompare(b.filePath));
  for (const { data } of files) {
    if (!data || (data.role !== 'user' && data.role !== 'assistant')) continue;
    const text = textPartsOf(storageRoot, String(data.id ?? ''));
    if (!text) continue;
    messages.push({ role: data.role, text, timestamp: undefined });
  }
  return { title, messages };
}

/** 列出 OpenCode 在某项目 worktree 下的会话 */
export function listOpencodeSessions(
  projectPath: string,
  home = process.env.HOME ?? ''
): ScannedSession[] {
  const storage = path.join(home, '.local', 'share', 'opencode', 'storage');
  const projectIds = listDir(path.join(storage, 'project'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const data = readJson(path.join(storage, 'project', name));
      return data?.worktree === projectPath && typeof data.id === 'string' ? data.id : null;
    })
    .filter((id): id is string => Boolean(id));
  const sessions: ScannedSession[] = [];
  for (const projectId of projectIds) {
    const sessionDir = path.join(storage, 'session', projectId);
    for (const name of listDir(sessionDir).filter((n) => n.endsWith('.json'))) {
      const filePath = path.join(sessionDir, name);
      const meta = readJson(filePath);
      if (!meta || typeof meta.parentID === 'string') continue;
      const { title, messages } = readOpencodeSession(filePath);
      if (messages.length === 0) continue;
      const updated =
        meta.time && typeof meta.time === 'object'
          ? Number((meta.time as { updated?: unknown }).updated)
          : 0;
      sessions.push({
        path: filePath,
        title: typeof meta.title === 'string' ? meta.title : title,
        updatedAt: Number.isFinite(updated) ? updated : 0,
        messageCount: messages.length,
      });
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}
