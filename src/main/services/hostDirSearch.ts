import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import type { HostDirSearchResult } from '@shared/types';

const MAX_DEPTH = 6;
const MAX_SCAN = 4000;
const MAX_RESULTS = 20;
const SKIP_NAMES = new Set([
  'node_modules',
  'venv',
  'env',
  'dist',
  'build',
  'target',
  'out',
  'coverage',
  'vendor',
  '__pycache__',
]);

function displayPath(target: string, home: string): string {
  const relative = path.relative(home, target);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join('/')}`;
  }
  return target;
}

/** 0 段精确，1 段前缀，2 段包含，3 整路径包含；未命中返回 null。target 必须是相对 home 的路径，避免 home 自身段污染匹配 */
function matchRank(target: string, query: string): number | null {
  const needle = query.toLowerCase().replaceAll('\\', '/');
  let best: number | null = null;
  for (const segment of target.split('/')) {
    if (!segment) continue;
    const value = segment.toLowerCase();
    const rank =
      value === needle ? 0 : value.startsWith(needle) ? 1 : value.includes(needle) ? 2 : null;
    if (rank !== null && (best === null || rank < best)) best = rank;
  }
  if (best !== null) return best;
  return target.toLowerCase().includes(needle) ? 3 : null;
}

async function readEntries(dir: string): Promise<{ entries: Dirent[] } | { error: string }> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { entries };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** 在家目录下按关键词搜索子目录。空查询不扫描。单层读失败则跳过。 */
export async function searchHostDirs(
  query: string,
  home = homedir()
): Promise<HostDirSearchResult> {
  const host = hostname();
  const needle = query.trim();
  if (!needle) return { ok: true, host, results: [] };

  const root = path.resolve(home);
  // macOS ~/Library 受 TCC 保护，readdir 可能永久阻塞
  const library = process.platform === 'darwin' ? path.join(root, 'Library') : null;
  const hits: { path: string; depth: number; rank: number }[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let scanned = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const read = await readEntries(current.dir);
    if ('error' in read) {
      if (current.dir === root) return { ok: false, error: read.error };
      continue;
    }
    for (const entry of read.entries) {
      scanned += 1;
      if (scanned > MAX_SCAN) {
        queue.length = 0;
        break;
      }
      if (entry.name.startsWith('.') || SKIP_NAMES.has(entry.name) || !entry.isDirectory())
        continue;
      const full = path.join(current.dir, entry.name);
      if (full === library) continue;
      const depth = current.depth + 1;
      const relative = path.relative(root, full).split(path.sep).join('/');
      const rank = matchRank(relative, needle);
      if (rank !== null) hits.push({ path: full, depth, rank });
      if (depth < MAX_DEPTH) queue.push({ dir: full, depth });
    }
  }

  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.depth - b.depth ||
      a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }) ||
      a.path.localeCompare(b.path)
  );
  return {
    ok: true,
    host,
    results: hits.slice(0, MAX_RESULTS).map((hit) => ({
      path: hit.path,
      displayPath: displayPath(hit.path, root),
    })),
  };
}
