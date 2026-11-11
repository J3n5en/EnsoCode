import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface StoredSession {
  sessionId: string;
  sessionFile: string;
  cwd?: string;
  mtimeMs: number;
}

export interface RunLastEntry {
  sessionId: string;
  sessionFile: string;
}

function firstLine(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const read = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read).toString('utf8').split('\n', 1)[0] ?? '';
  } finally {
    closeSync(fd);
  }
}

export function readSessionHeader(file: string): { id?: string; cwd?: string } | null {
  try {
    const parsed = JSON.parse(firstLine(file)) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const entry = parsed as { type?: unknown; id?: unknown; cwd?: unknown };
    if (entry.type !== 'session') return null;
    return {
      ...(typeof entry.id === 'string' && entry.id ? { id: entry.id } : {}),
      ...(typeof entry.cwd === 'string' && entry.cwd ? { cwd: entry.cwd } : {}),
    };
  } catch {
    return null;
  }
}

export function listSessionFiles(sessionDir: string): StoredSession[] {
  if (!existsSync(sessionDir)) return [];
  const found: StoredSession[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(file);
        continue;
      }
      if (!name.endsWith('.jsonl')) continue;
      const header = readSessionHeader(file);
      if (!header?.id) continue;
      const resolved = path.resolve(file);
      const root = path.resolve(sessionDir);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) continue;
      found.push({
        sessionId: header.id,
        sessionFile: resolved,
        ...(header.cwd ? { cwd: header.cwd } : {}),
        mtimeMs: stat.mtimeMs,
      });
    }
  };
  walk(sessionDir);
  return found;
}

export function findSessionById(sessionDir: string, sessionId: string): StoredSession | null {
  return listSessionFiles(sessionDir).find((session) => session.sessionId === sessionId) ?? null;
}

export function findLatestSessionForCwd(sessionDir: string, cwd: string): StoredSession | null {
  const target = path.resolve(cwd);
  const matches = listSessionFiles(sessionDir).filter(
    (session) => session.cwd && path.resolve(session.cwd) === target
  );
  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return matches[0] ?? null;
}

export function readRunLast(file: string): Record<string, RunLastEntry> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, RunLastEntry> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Partial<RunLastEntry>;
      if (typeof entry.sessionId !== 'string' || typeof entry.sessionFile !== 'string') continue;
      out[key] = { sessionId: entry.sessionId, sessionFile: entry.sessionFile };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeRunLast(file: string, cwd: string, entry: RunLastEntry): void {
  const current = readRunLast(file);
  current[path.resolve(cwd)] = entry;
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`);
  renameSync(temp, file);
}
