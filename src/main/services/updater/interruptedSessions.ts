import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 更新重启时被打断的会话：重启前记下，重启后由 leader renderer 取走续跑 */
export const INTERRUPTED_SESSIONS_FILE = 'interrupted-by-update.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function recordInterruptedSessions(
  dir: string,
  sessionIds: readonly string[],
  now = Date.now()
): void {
  const file = path.join(dir, INTERRUPTED_SESSIONS_FILE);
  const unique = [...new Set(sessionIds)];
  if (unique.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  writeFileSync(file, JSON.stringify({ v: 1, at: now, sessionIds: unique }), { mode: 0o600 });
}

export function takeInterruptedSessions(dir: string, now = Date.now()): string[] {
  const file = path.join(dir, INTERRUPTED_SESSIONS_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  rmSync(file, { force: true });
  try {
    const record = JSON.parse(raw) as { at?: unknown; sessionIds?: unknown };
    if (typeof record.at !== 'number' || now - record.at > MAX_AGE_MS) return [];
    if (!Array.isArray(record.sessionIds)) return [];
    return record.sessionIds.filter((id): id is string => typeof id === 'string' && id !== '');
  } catch {
    return [];
  }
}
