/**
 * 会话级 git worktree 的纯操作层（零 electron 依赖，可独立测试）。
 *
 * 设计决策见 docs/plans/2026-08-22-enso-code-design.md「trust 与 isolation」：
 * 默认本地、opt-in 隔离、不做应用内 merge、删除保留分支。
 * 实现经验参照 EnsoAI WorktreeService（无提交仓库预检、分支冲突预检、强删兜底）。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionWorktree, WorktreeStatus } from '../../../shared/types/worktree';

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args[0]} failed: ${stderr.trim() || error.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function gitOk(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

/** 分支/目录名里可用的短会话标识 */
function shortId(conversationId: string): string {
  const cleaned = conversationId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return cleaned.slice(-8) || 'session';
}

export interface CreateWorktreeOptions {
  repoPath: string;
  conversationId: string;
  projectId: string;
  /** worktree 托管根目录（userData/worktrees） */
  root: string;
}

/** 从主工作树 HEAD 为会话创建隔离 worktree（新分支，命名自动避让冲突） */
export async function createSessionWorktree(
  options: CreateWorktreeOptions
): Promise<SessionWorktree> {
  const { repoPath, conversationId, projectId, root } = options;
  if (!(await gitOk(repoPath, 'rev-parse', '--is-inside-work-tree'))) {
    throw new Error(`not a git repository: ${repoPath}`);
  }
  if (!(await gitOk(repoPath, 'rev-parse', 'HEAD'))) {
    throw new Error('repository has no commits; create an initial commit first');
  }
  const baseCommit = await git(repoPath, 'rev-parse', 'HEAD');
  const currentBranch = await git(repoPath, 'branch', '--show-current');
  const baseBranch = currentBranch || null;

  const base = shortId(conversationId);
  // 分支冲突时追加时间戳避让（同会话重建/重复创建场景）
  let suffix = '';
  let branch = `enso/${base}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await git(repoPath, 'branch', '--list', branch);
    const dirTaken = existsSync(join(root, projectId, `${base}${suffix}`));
    if (!existing && !dirTaken) break;
    suffix = `-${Date.now().toString(36)}${attempt || ''}`;
    branch = `enso/${base}${suffix}`;
  }
  const path = join(root, projectId, `${base}${suffix}`);
  await mkdir(join(root, projectId), { recursive: true });
  await git(repoPath, 'worktree', 'add', '-b', branch, path, 'HEAD');

  return {
    conversationId,
    projectId,
    repoPath,
    path,
    branch,
    baseBranch,
    baseCommit,
    createdAt: Date.now(),
  };
}

/** worktree 轻量状态：存在性 / 未提交 / 领先 base 的提交数 */
export async function worktreeStatus(record: SessionWorktree): Promise<WorktreeStatus> {
  if (
    !existsSync(record.path) ||
    !(await gitOk(record.path, 'rev-parse', '--is-inside-work-tree'))
  ) {
    return { exists: false, dirty: false, ahead: 0 };
  }
  const porcelain = await git(record.path, 'status', '--porcelain');
  const dirty = porcelain.length > 0;
  // base 分支可能已被删，回退 baseCommit
  const base =
    record.baseBranch && (await gitOk(record.repoPath, 'rev-parse', '--verify', record.baseBranch))
      ? record.baseBranch
      : record.baseCommit;
  let ahead = 0;
  try {
    ahead = Number.parseInt(await git(record.path, 'rev-list', '--count', `${base}..HEAD`), 10);
  } catch {
    // base commit 被 GC 等极端情况：视为 0，不阻塞状态展示
  }
  return { exists: true, dirty, ahead: Number.isFinite(ahead) ? ahead : 0 };
}

/** 主工作树是否干净（Move to worktree 前置检查）。非 git 目录抛错。 */
export async function repoIsClean(repoPath: string): Promise<boolean> {
  await git(repoPath, 'rev-parse', '--is-inside-work-tree');
  const porcelain = await git(repoPath, 'status', '--porcelain');
  return porcelain.length === 0;
}

/**
 * 删除 worktree（强制，未提交改动由上层拦截确认）。分支保留。
 * 目录已被手动删除时仅清理 git 元数据。
 */
export async function removeSessionWorktree(record: SessionWorktree): Promise<void> {
  if (existsSync(record.path)) {
    try {
      await git(record.repoPath, 'worktree', 'remove', '--force', record.path);
    } catch {
      // git 拒绝（锁定/子模块等）：兜底直接删目录，随后 prune 清元数据
      await rm(record.path, { recursive: true, force: true });
    }
  }
  await gitOk(record.repoPath, 'worktree', 'prune');
}

/**
 * resume 发现 worktree 丢失后的重建：
 * 分支仍在 → 从分支重建（保留已提交工作）；分支也没了 → 从 baseCommit 重建同名分支。
 */
export async function rebuildSessionWorktree(
  record: SessionWorktree,
  root: string
): Promise<SessionWorktree> {
  await gitOk(record.repoPath, 'worktree', 'prune');
  const branchExists = await gitOk(record.repoPath, 'rev-parse', '--verify', record.branch);
  const base = shortId(record.conversationId);
  let path = join(root, record.projectId, base);
  if (existsSync(path)) {
    path = join(root, record.projectId, `${base}-${Date.now().toString(36)}`);
  }
  await mkdir(join(root, record.projectId), { recursive: true });
  if (branchExists) {
    await git(record.repoPath, 'worktree', 'add', path, record.branch);
  } else {
    await git(record.repoPath, 'worktree', 'add', '-b', record.branch, path, record.baseCommit);
  }
  return { ...record, path, createdAt: Date.now() };
}
