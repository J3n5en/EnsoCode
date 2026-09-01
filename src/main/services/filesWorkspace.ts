import {
  type FSWatcher,
  watch as fsWatch,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'target',
]);

export const MAX_FILE_BYTES = 2_000_000;
/** Files 面板编辑器上限：整文件 Shiki 会卡死 UI */
export const EDITOR_MAX_BYTES = 256_000;

export interface DirEntry {
  name: string;
  kind: 'file' | 'dir';
}

export function resolveUnderCwd(cwd: string, rel: string | undefined): string | null {
  const root = path.resolve(cwd);
  const target = rel == null || rel === '' || rel === '.' ? root : path.resolve(root, rel);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

export class RefCountWatchers {
  private readonly map = new Map<string, { n: number; stop: () => void }>();

  get size(): number {
    return this.map.size;
  }

  acquire(key: string, start: () => () => void): void {
    const existing = this.map.get(key);
    if (existing) {
      existing.n += 1;
      return;
    }
    this.map.set(key, { n: 1, stop: start() });
  }

  release(key: string): void {
    const existing = this.map.get(key);
    if (!existing) return;
    existing.n -= 1;
    if (existing.n > 0) return;
    existing.stop();
    this.map.delete(key);
  }

  releaseAll(match: (key: string) => boolean): void {
    for (const [key, entry] of [...this.map]) {
      if (!match(key)) continue;
      entry.stop();
      this.map.delete(key);
    }
  }
}

export function listLocalDir(abs: string): DirEntry[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DirEntry[] = [];
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      out.push({ name: entry.name, kind: 'dir' });
    } else if (entry.isFile()) {
      out.push({ name: entry.name, kind: 'file' });
    }
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export function readLocalFile(
  abs: string
): { ok: true; content: string } | { ok: false; error: 'too-large' | 'binary' | 'unavailable' } {
  try {
    const stat = statSync(abs);
    if (!stat.isFile()) return { ok: false, error: 'unavailable' };
    if (stat.size > EDITOR_MAX_BYTES) return { ok: false, error: 'too-large' };
    const buf = readFileSync(abs);
    if (buf.includes(0)) return { ok: false, error: 'binary' };
    return { ok: true, content: buf.toString('utf8') };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

export function writeLocalFile(abs: string, content: string): boolean {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return false;
  try {
    writeFileSync(abs, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function watchLocalFile(abs: string, onChange: () => void): () => void {
  let watcher: FSWatcher | null = null;
  try {
    watcher = fsWatch(abs, () => onChange());
  } catch {
    return () => undefined;
  }
  return () => {
    watcher?.close();
    watcher = null;
  };
}
