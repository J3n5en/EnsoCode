import { readdirSync } from 'node:fs';
import path from 'node:path';

export interface FileSearchResult {
  /** 相对 root 的路径 */
  relativePath: string;
  name: string;
}

/** 扫描时跳过的目录：依赖、构建产物、版本库 */
const IGNORED_DIRS = new Set([
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

const MAX_DEPTH = 8;
const MAX_FILES = 5000;

/** 递归列出 root 下的文件（相对路径），带目录忽略、深度与数量上限 */
export function listFiles(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || results.length >= MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_FILES) return;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        results.push(path.relative(root, path.join(dir, entry.name)));
      }
    }
  };
  walk(root, 0);
  return results;
}

/**
 * 子序列模糊评分：query 的字符须按序出现在 target 中，否则 0。
 * 连续命中与分隔符后命中加分，越靠前越高。
 */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let ti = 0;
  let lastHit = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx === -1) return 0;
    score += idx === lastHit + 1 ? 4 : 1;
    if (idx === 0 || t[idx - 1] === '/' || t[idx - 1] === '.' || t[idx - 1] === '-') score += 1;
    lastHit = idx;
    ti = idx + 1;
  }
  return score / (1 + t.length / 100);
}

/** 在 root 下按文件名/路径模糊搜索 */
export function searchFiles(root: string, query: string, maxResults = 10): FileSearchResult[] {
  const files = listFiles(root);
  const trimmed = query.trim();
  if (!trimmed) {
    return files
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, maxResults)
      .map((relativePath) => ({ relativePath, name: path.basename(relativePath) }));
  }
  return files
    .map((relativePath) => {
      const name = path.basename(relativePath);
      const score = Math.max(fuzzyScore(trimmed, name) * 2, fuzzyScore(trimmed, relativePath));
      return { relativePath, name, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ relativePath, name }) => ({ relativePath, name }));
}
