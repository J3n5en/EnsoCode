/**
 * 秘书的 repo_status：只读 git 事实，不写任何东西。
 *
 * 两条边界：
 * - 路径：只接受可见项目的检出目录，或同一仓库的 git worktree 根（用 git common dir 判定同仓）；
 * - 命令：一律 `git --no-optional-locks -C <root>`，带超时，子命令全是读操作。
 */
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
/** 未提交/未跟踪文件最多列这么多条，总数另给 */
export const REPO_STATUS_FILE_MAX = 50;
export const REPO_STATUS_COMMIT_DEFAULT = 10;
export const REPO_STATUS_COMMIT_MAX = 20;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitResult>;

export interface RepoStatusDeps {
  git: GitRunner;
  /** 解析真实路径；不存在或不可读返回 null */
  realpath(target: string): Promise<string | null>;
  exists(target: string): boolean;
}

export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', '-C', cwd, ...args],
      { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
  });

export const realRepoDeps: RepoStatusDeps = {
  git: runGit,
  async realpath(target) {
    try {
      return realpathSync(target);
    } catch {
      return null;
    }
  },
  exists: (target) => existsSync(target),
};

/** 可见项目的本机检出目录；ssh 项目在本机跑 git 只会得到错误 */
export interface RepoScopeCandidate {
  projectId: string;
  path: string;
}

export interface RepoScope {
  projectId: string;
  /** 请求路径解析出的仓库根（worktree 根或项目检出目录） */
  root: string;
}

async function gitOut(
  deps: RepoStatusDeps,
  cwd: string,
  args: readonly string[]
): Promise<string | null> {
  const result = await deps.git(cwd, args);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** `--git-common-dir` 可能是相对 cwd 的路径，统一成绝对路径再比 */
async function commonDir(deps: RepoStatusDeps, cwd: string): Promise<string | null> {
  const raw = await gitOut(deps, cwd, ['rev-parse', '--git-common-dir']);
  if (!raw) return null;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
}

async function topLevel(deps: RepoStatusDeps, cwd: string): Promise<string | null> {
  const raw = await gitOut(deps, cwd, ['rev-parse', '--show-toplevel']);
  return raw ? path.normalize(raw) : null;
}

/**
 * 把请求路径收窄到一个可见项目：
 * 1. 就是某个可见项目的检出目录 → 放行；
 * 2. 否则必须是它自己的 worktree 根，且与某个可见项目共享 git common dir。
 * 其余（任意目录、别的仓库、项目子目录、符号链接指向别处）一律拒绝。
 */
export async function resolveRepoScope(
  deps: RepoStatusDeps,
  candidates: readonly RepoScopeCandidate[],
  requested: string
): Promise<RepoScope | null> {
  if (!requested.trim()) return null;
  const target = await deps.realpath(requested);
  if (!target) return null;
  const projectRoots: Array<{ projectId: string; root: string }> = [];
  for (const candidate of candidates) {
    const projectRoot = await deps.realpath(candidate.path);
    if (!projectRoot) continue;
    // 检出目录本身：项目路径就是权威，不必先问 git（不是仓库时由采集阶段报 not-a-repo）
    if (projectRoot === target) return { projectId: candidate.projectId, root: target };
    projectRoots.push({ projectId: candidate.projectId, root: projectRoot });
  }
  // 其余只接受同仓 worktree 根：请求路径必须自己就是 worktree 顶，且 common dir 与可见项目一致
  const targetTop = await topLevel(deps, target);
  if (!targetTop || targetTop !== target) return null;
  const targetCommon = await commonDir(deps, targetTop);
  if (!targetCommon) return null;
  for (const candidate of projectRoots) {
    const projectCommon = await commonDir(deps, candidate.root);
    if (projectCommon && projectCommon === targetCommon) {
      return { projectId: candidate.projectId, root: targetTop };
    }
  }
  return null;
}

export interface RepoCommit {
  sha: string;
  subject: string;
  author: string;
  at: number;
}

export interface RepoChange {
  status: string;
  path: string;
}

export interface RepoWorktree {
  path: string;
  branch: string | null;
  head: string | null;
}

export interface RepoStatusSnapshot {
  root: string;
  branch: string | null;
  head: { sha: string; subject: string } | null;
  commits: RepoCommit[];
  base?: { ref: string; ahead: number; behind: number };
  contains?: { sha: string; inHead: boolean };
  changes: { total: number; files: RepoChange[] };
  operation: { merge: boolean; rebase: boolean };
  worktrees: RepoWorktree[];
}

export type RepoStatusOutcome =
  | { ok: true; snapshot: RepoStatusSnapshot }
  | { ok: false; code: 'out-of-scope' | 'not-a-repo' | 'invalid-base' | 'invalid-contains' };

const BASE_REF = /^[A-Za-z0-9._/-]{1,200}$/u;
const COMMIT_SHA = /^[0-9a-fA-F]{4,40}$/u;

/** 分支名与提交号会拼进 argv：只放行明确的字符集，且不允许以 - 开头 */
export function safeRef(value: string): string | null {
  const trimmed = value.trim();
  if (!BASE_REF.test(trimmed) || trimmed.startsWith('-') || trimmed.includes('..')) return null;
  return trimmed;
}

export function safeCommit(value: string): string | null {
  const trimmed = value.trim();
  return COMMIT_SHA.test(trimmed) ? trimmed.toLowerCase() : null;
}

const FIELD = '\u001f';

function parseCommits(stdout: string): RepoCommit[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [sha, author, at, subject] = line.split(FIELD);
      if (!sha) return [];
      const seconds = Number(at);
      return [
        {
          sha,
          author: author ?? '',
          at: Number.isFinite(seconds) ? seconds * 1000 : 0,
          subject: subject ?? '',
        },
      ];
    });
}

/**
 * `git status --porcelain=v1 -z`：每条以 NUL 分隔，重命名/复制条目的原路径紧跟其后。
 * 只取前 REPO_STATUS_FILE_MAX 条，总数照实给。
 */
export function parsePorcelainZ(stdout: string): { total: number; files: RepoChange[] } {
  const tokens = stdout.split('\0');
  const all: RepoChange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.length < 4) continue;
    const status = token.slice(0, 2);
    const filePath = token.slice(3);
    all.push({ status, path: filePath });
    // R / C 后面跟一条原路径，跳过它，别当成独立条目
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return { total: all.length, files: all.slice(0, REPO_STATUS_FILE_MAX) };
}

/** `git worktree list --porcelain`：空行分段，每段有 worktree / HEAD / branch */
export function parseWorktrees(stdout: string): RepoWorktree[] {
  const worktrees: RepoWorktree[] = [];
  for (const block of stdout.split('\n\n')) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    let worktreePath: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) worktreePath = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
      else if (line.startsWith('branch '))
        branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '');
    }
    if (worktreePath) worktrees.push({ path: worktreePath, branch, head });
  }
  return worktrees;
}

async function rebaseInProgress(deps: RepoStatusDeps, root: string): Promise<boolean> {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const raw = await gitOut(deps, root, ['rev-parse', '--git-path', name]);
    if (!raw) continue;
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
    if (deps.exists(resolved)) return true;
  }
  return false;
}

export interface RepoStatusRequest {
  root: string;
  limit: number;
  base?: string;
  contains?: string;
}

/**
 * 采集一份仓库状态。任一必需命令失败即视为不是可读仓库，避免把半份数据当成事实。
 */
export async function readRepoStatus(
  deps: RepoStatusDeps,
  request: RepoStatusRequest
): Promise<RepoStatusOutcome> {
  const { root } = request;
  const limit = Math.min(
    REPO_STATUS_COMMIT_MAX,
    Math.max(
      1,
      Math.floor(Number.isFinite(request.limit) ? request.limit : REPO_STATUS_COMMIT_DEFAULT)
    )
  );
  const baseRef = request.base === undefined ? null : safeRef(request.base);
  if (request.base !== undefined && !baseRef) return { ok: false, code: 'invalid-base' };
  const containsSha = request.contains === undefined ? null : safeCommit(request.contains);
  if (request.contains !== undefined && !containsSha)
    return { ok: false, code: 'invalid-contains' };

  const top = await topLevel(deps, root);
  if (!top) return { ok: false, code: 'not-a-repo' };

  const branchRaw = await gitOut(deps, top, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null;

  const headRaw = await gitOut(deps, top, ['log', '-1', `--format=%h${FIELD}%s`]);
  const head = headRaw
    ? (() => {
        const [sha, subject] = headRaw.split(FIELD);
        return sha ? { sha, subject: subject ?? '' } : null;
      })()
    : null;

  const commitsRaw = await gitOut(deps, top, [
    'log',
    `-n${limit}`,
    `--format=%h${FIELD}%an${FIELD}%at${FIELD}%s`,
  ]);
  const commits = commitsRaw ? parseCommits(commitsRaw) : [];

  const statusRaw = await deps.git(top, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=normal',
  ]);
  const changes =
    statusRaw.code === 0 ? parsePorcelainZ(statusRaw.stdout) : { total: 0, files: [] };

  let base: RepoStatusSnapshot['base'];
  if (baseRef) {
    const counts = await gitOut(deps, top, [
      'rev-list',
      '--left-right',
      '--count',
      `${baseRef}...HEAD`,
    ]);
    if (counts) {
      const [behind, ahead] = counts.split(/\s+/u).map((value) => Number(value));
      if (Number.isFinite(behind) && Number.isFinite(ahead)) base = { ref: baseRef, ahead, behind };
    }
  }

  // contains 走退出码：0 = 在 HEAD 里，1 = 不在，其他 = 参数或仓库问题
  const containsCheck = containsSha
    ? await deps.git(top, ['merge-base', '--is-ancestor', containsSha, 'HEAD'])
    : null;

  const mergeHead = await deps.git(top, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
  const worktreesRaw = await gitOut(deps, top, ['worktree', 'list', '--porcelain']);

  return {
    ok: true,
    snapshot: {
      root: top,
      branch,
      head,
      commits,
      ...(base ? { base } : {}),
      changes,
      operation: {
        merge: mergeHead.code === 0,
        rebase: await rebaseInProgress(deps, top),
      },
      worktrees: worktreesRaw ? parseWorktrees(worktreesRaw) : [],
      ...(containsCheck && containsSha
        ? { contains: { sha: containsSha, inHead: containsCheck.code === 0 } }
        : {}),
    },
  };
}
