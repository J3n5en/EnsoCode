/**
 * 秘书的 repo_diff：合并前核实"这个分支/PR 到底改了哪些文件、多大"。
 *
 * 与 repo_status 同一套边界：路径走 resolveRepoScope 收窄，命令一律只读
 * （`git diff` / `git rev-parse`），输出只有增删行数与路径这类 metadata，
 * 绝不带文件内容。
 *
 * 语义默认三点 diff（base...ref）：只数 merge-base 之后分支自己的变化，
 * 这正是 PR 审查要的口径，也避开了旧版 git 没有 `diff --merge-base` 的问题。
 */
import { type RepoStatusDeps, safeRef } from './repoStatus';

/** diff 文件清单最多列这么多条，总数与行数统计照实给 */
export const REPO_DIFF_FILE_MAX = 200;
export const REPO_DIFF_BASE_DEFAULT = 'origin/main';

export interface RepoDiffFile {
  /** name-status 的状态字母：A / M / D / R 等 */
  status: string;
  path: string;
  /** 二进制文件为 null */
  added: number | null;
  deleted: number | null;
  binary?: true;
  /** 重命名的原路径 */
  fromPath?: string;
}

export interface RepoDiffSummary {
  base: string;
  ref: string;
  /** true = 三点 diff（merge-base 语义）；false = 两点 diff */
  mergeBase: boolean;
  totalFiles: number;
  truncated: boolean;
  /** 全部文件的增/删行数合计（不含二进制） */
  added: number;
  deleted: number;
  /** 二进制文件数 */
  binary: number;
  files: RepoDiffFile[];
}

export type RepoDiffOutcome =
  | { ok: true; diff: RepoDiffSummary }
  | { ok: false; code: 'not-a-repo' | 'invalid-base' | 'invalid-ref' | 'diff-failed' };

export interface NameStatusEntry {
  status: string;
  path: string;
  fromPath?: string;
}

export interface NumstatEntry {
  added: number | null;
  deleted: number | null;
  path: string;
  fromPath?: string;
}

/**
 * `git diff --numstat -z`：每行 `<added>\t<deleted>\t<path>`，二进制是 `-`。
 * 重命名/复制条目的路径段为空，旧路径与新路径各占一个后续 token；
 * 归并成新路径一条，保证与 name-status 逐条对齐。
 * 注意不能用 token.trim() 判空：`0\t0\t` 是 rename 的有效 stats，不是空白。
 */
export function parseNumstatZ(stdout: string): NumstatEntry[] {
  const tokens = stdout.split('\0');
  const entries: NumstatEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const first = token.indexOf('\t');
    const second = first < 0 ? -1 : token.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    const parse = (value: string): number | null => {
      const parsed = Number(value);
      return value === '-' || !Number.isFinite(parsed) ? null : parsed;
    };
    const entry: NumstatEntry = {
      added: parse(token.slice(0, first)),
      deleted: parse(token.slice(first + 1, second)),
      path: token.slice(second + 1),
    };
    if (!entry.path) {
      // 路径段为空：rename/copy，旧/新路径各跟一个 token
      const fromPath = tokens[index + 1];
      const newPath = tokens[index + 2];
      index += 2;
      if (!newPath) continue;
      entry.fromPath = fromPath ?? '';
      entry.path = newPath;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * `git diff --name-status -z`：普通条目是 `<status>\t<path>` 一个 token；
 * 重命名/复制条目状态字母独占一个 token（不带 tab），旧路径、新路径再各跟一个 token。
 * 转成 path = 新路径、fromPath = 原路径，保证与 numstat 逐条对齐。
 */
export function parseNameStatusZ(stdout: string): NameStatusEntry[] {
  const tokens = stdout.split('\0');
  const entries: NameStatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const tab = token.indexOf('\t');
    if (tab < 0 && /^[RC]\d*$/u.test(token)) {
      const fromPath = tokens[index + 1];
      const newPath = tokens[index + 2];
      index += 2;
      if (!newPath) continue;
      const entry: NameStatusEntry = { status: token.slice(0, 1), path: newPath };
      if (fromPath) entry.fromPath = fromPath;
      entries.push(entry);
      continue;
    }
    if (tab < 0) continue;
    const rawStatus = token.slice(0, tab);
    const status = rawStatus.slice(0, 1);
    const entry: NameStatusEntry = { status, path: token.slice(tab + 1) };
    if (rawStatus.startsWith('R') || rawStatus.startsWith('C')) {
      // token 里的是原路径，紧跟的下一个 token 是新路径
      const newPath = tokens[index + 1];
      index += 1;
      if (newPath) {
        entry.fromPath = entry.path;
        entry.path = newPath;
      }
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * numstat 与 name-status 按同一文件顺序输出，逐条对齐；
 * 路径对不上时沿用 numstat 的行数与 name-status 同位的状态，不把半份对齐当成事实。
 */
export function mergeNumstatAndStatus(
  numstat: readonly NumstatEntry[],
  statuses: readonly NameStatusEntry[]
): RepoDiffFile[] {
  return numstat.map((entry, index) => {
    const statusEntry = statuses[index];
    const aligned = statusEntry && statusEntry.path === entry.path ? statusEntry : null;
    const file: RepoDiffFile = {
      status: aligned?.status ?? statuses[index]?.status ?? 'M',
      path: entry.path,
      added: entry.added,
      deleted: entry.deleted,
    };
    if (entry.added === null || entry.deleted === null) file.binary = true;
    const fromPath = aligned?.fromPath ?? entry.fromPath;
    if (fromPath) file.fromPath = fromPath;
    return file;
  });
}

export interface RepoDiffRequest {
  root: string;
  base?: string;
  ref?: string;
  /** 缺省 true：三点 diff（merge-base 语义）；false 用两点 diff */
  mergeBase?: boolean;
}

export async function readRepoDiff(
  deps: RepoStatusDeps,
  request: RepoDiffRequest
): Promise<RepoDiffOutcome> {
  const baseRaw = request.base ?? REPO_DIFF_BASE_DEFAULT;
  const refRaw = request.ref ?? 'HEAD';
  const base = safeRef(baseRaw);
  const ref = safeRef(refRaw);
  if (!base) return { ok: false, code: 'invalid-base' };
  if (!ref) return { ok: false, code: 'invalid-ref' };
  const mergeBase = request.mergeBase !== false;

  const topResult = await deps.git(request.root, ['rev-parse', '--show-toplevel']);
  const top = topResult.code === 0 ? topResult.stdout.trim() : '';
  if (!top) return { ok: false, code: 'not-a-repo' };

  const range = mergeBase ? `${base}...${ref}` : `${base}..${ref}`;
  const [numstat, nameStatus] = await Promise.all([
    deps.git(top, ['diff', '--numstat', '-z', range]),
    deps.git(top, ['diff', '--name-status', '-z', range]),
  ]);
  if (numstat.code !== 0 || nameStatus.code !== 0) return { ok: false, code: 'diff-failed' };

  const files = mergeNumstatAndStatus(
    parseNumstatZ(numstat.stdout),
    parseNameStatusZ(nameStatus.stdout)
  );
  return {
    ok: true,
    diff: {
      base,
      ref,
      mergeBase,
      totalFiles: files.length,
      truncated: files.length > REPO_DIFF_FILE_MAX,
      added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
      deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
      binary: files.filter((file) => file.binary).length,
      files: files.slice(0, REPO_DIFF_FILE_MAX),
    },
  };
}
