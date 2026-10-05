import { statSync } from 'node:fs';
import type { ProjectedMessage } from '@shared/types/agent';
import { projectParentHistoryAll, resolveParentHistoryFile } from '../sessionHistoryTail';

const CACHE_LIMIT = 16;
const cache = new Map<string, { stamp: string; messages: readonly ProjectedMessage[] }>();

/**
 * bot 会话 jsonl 的全量投影（下标与历史分页同一编号），按 mtime+size 缓存；
 * 路径必须落在 sessions 目录内。搜索与产物卡片共用。
 */
export async function readBotSessionMessages(
  sessionDir: string,
  sessionFile: string | undefined
): Promise<readonly ProjectedMessage[]> {
  const resolved = resolveParentHistoryFile(sessionDir, sessionFile);
  if (!resolved) throw new Error('session file outside sessions directory');
  const stat = statSync(resolved);
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const hit = cache.get(resolved);
  if (hit?.stamp === stamp) {
    cache.delete(resolved);
    cache.set(resolved, hit);
    return hit.messages;
  }
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const messages = projectParentHistoryAll(SessionManager.open(resolved, sessionDir).getBranch());
  cache.delete(resolved);
  cache.set(resolved, { stamp, messages });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return messages;
}

export interface BranchEntry {
  id: string;
  /** user 消息条目才有：消息时间（ms） */
  userAt?: number;
}

/** 当前分支的 entry 序列（回退校验目标、计算记忆水位与委派作废边界用） */
export async function readBotSessionBranch(
  sessionDir: string,
  sessionFile: string | undefined
): Promise<BranchEntry[]> {
  const resolved = resolveParentHistoryFile(sessionDir, sessionFile);
  if (!resolved) throw new Error('session file outside sessions directory');
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  return SessionManager.open(resolved, sessionDir)
    .getBranch()
    .map((entry) => {
      const message =
        entry.type === 'message' ? (entry.message as { role?: string; timestamp?: number }) : null;
      if (message?.role !== 'user') return { id: entry.id };
      const at =
        typeof message.timestamp === 'number' ? message.timestamp : Date.parse(entry.timestamp);
      return { id: entry.id, ...(Number.isFinite(at) ? { userAt: at } : {}) };
    });
}
