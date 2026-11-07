import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', 'target']);
const MAX_DIRS = 3000;
const MAX_DEPTH = 10;
const MAX_HINTS = 5;

const exists = (target: string) =>
  stat(target).then(
    () => true,
    () => false
  );

const listDir = (dir: string): Promise<Dirent[]> =>
  readdir(dir, { withFileTypes: true }).catch(() => []);

function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const current = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      previous = current;
    }
  }
  return row[right.length];
}

function similar(wanted: string, name: string): boolean {
  const a = wanted.toLowerCase();
  const b = name.toLowerCase();
  if (a === b) return true;
  if (a.length >= 3 && (b.includes(a) || a.includes(b)) && Math.abs(a.length - b.length) <= 3)
    return true;
  return distance(a, b) <= Math.max(1, Math.floor(a.length / 4));
}

/** 同名文件：在工作区内有界广度遍历，跳过隐藏和产物目录 */
async function findByName(root: string, name: string): Promise<string[]> {
  const found: string[] = [];
  let queue = [root];
  let visited = 0;
  for (let depth = 0; depth <= MAX_DEPTH && queue.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      if (++visited > MAX_DIRS) return found;
      for (const entry of await listDir(dir)) {
        const full = path.join(dir, entry.name);
        if (entry.name === name) found.push(full);
        if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
          next.push(full);
      }
      if (found.length >= MAX_HINTS) return found;
    }
    queue = next;
  }
  return found;
}

/** 不存在的路径：最近的现存上级里名字相近的项，加工作区内同名文件 */
export async function suggestPaths(requested: string, cwd: string): Promise<string[]> {
  const target = path.resolve(cwd, requested);
  let base = path.dirname(target);
  while (!(await exists(base))) {
    const parent = path.dirname(base);
    if (parent === base) return [];
    base = parent;
  }
  const remaining = path.relative(base, target).split(path.sep);
  const hints: string[] = [];
  for (const entry of await listDir(base)) {
    if (!similar(remaining[0], entry.name)) continue;
    const candidate = path.join(base, entry.name, ...remaining.slice(1));
    if (remaining.length === 1 || (await exists(candidate))) hints.push(candidate);
  }
  const within = (dir: string) => {
    const relative = path.relative(cwd, dir);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  hints.push(...(await findByName(within(target) ? cwd : base, path.basename(target))));
  return [...new Set(hints)]
    .slice(0, MAX_HINTS)
    .map((hint) => (within(hint) ? path.relative(cwd, hint) || '.' : hint));
}

const MISSING = /ENOENT|Path not found|no such file or directory/;

/** 本地 read/grep/find/ls：路径错误时在报错里附上相近路径，省一轮猜路径 */
export function withPathHints<T extends ToolDefinition>(definition: T, cwd: string): T {
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        return await definition.execute(toolCallId, params, signal, onUpdate, ctx);
      } catch (error) {
        const requested = (params as { path?: unknown } | undefined)?.path;
        if (!(error instanceof Error) || typeof requested !== 'string' || !requested) throw error;
        if (error.message.includes('EISDIR')) {
          throw new Error(
            `${error.message}\n${requested} is a directory: list it with ls, or read a file inside it.`
          );
        }
        if (!MISSING.test(error.message)) throw error;
        const hints = await suggestPaths(requested, ctx?.cwd || cwd).catch(() => []);
        if (hints.length === 0) throw error;
        throw new Error(`${error.message}\nSimilar existing paths: ${hints.join(', ')}`);
      }
    },
  };
}
