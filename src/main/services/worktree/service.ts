/**
 * 会话级 git worktree 的纯操作层（零 electron 依赖，可独立测试）。
 *
 * 设计决策见 docs/plans/2026-08-22-enso-code-design.md「trust 与 isolation」：
 * 默认本地、opt-in 隔离、不做应用内 merge、删除保留分支。
 * 实现经验参照 EnsoAI WorktreeService（无提交仓库预检、分支冲突预检、强删兜底）。
 */

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionWorktree, WorktreeStatus } from '../../../shared/types/worktree';
import { seedWorktreeDependencies } from './seed';
import { worktreeTrash } from './trash';

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
  /** 基线：分支名或提交号。缺省用 HEAD */
  baseRef?: string;
  /** 指定的新分支名。已存在时直接报错，绝不覆盖 */
  branch?: string;
}

/** 从基线为会话创建隔离 worktree（新分支，命名自动避让冲突） */
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
  const wanted = options.branch?.trim();
  if (wanted) {
    if (!(await branchNameValid(repoPath, wanted))) {
      throw new Error(`invalid branch name: ${wanted}`);
    }
    if (await branchExists(repoPath, wanted)) {
      throw new Error(`branch already exists: ${wanted}`);
    }
  }
  const baseRef = options.baseRef?.trim();
  // 基线不存在时 rev-parse 直接失败，不建任何东西
  const baseCommit = await git(repoPath, 'rev-parse', `${baseRef || 'HEAD'}^{commit}`);
  const baseBranch = baseRef
    ? await baseBranchName(repoPath, baseRef)
    : (await git(repoPath, 'branch', '--show-current')) || null;

  const base = shortId(conversationId);
  let branch = wanted || `enso/${base}`;
  let suffix = '';
  // 指定了分支名时只避让目录；没指定时分支冲突也追加时间戳（同会话重复创建场景）
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = wanted ? false : Boolean(await git(repoPath, 'branch', '--list', branch));
    const dirTaken = existsSync(join(root, projectId, `${base}${suffix}`));
    if (!existing && !dirTaken) break;
    suffix = `-${Date.now().toString(36)}${attempt || ''}`;
    if (!wanted) branch = `enso/${base}${suffix}`;
  }
  const path = join(root, projectId, `${base}${suffix}`);
  await mkdir(join(root, projectId), { recursive: true });
  await git(repoPath, 'worktree', 'add', '-b', branch, path, baseCommit);
  await seedDependencies(repoPath, path);

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

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  return gitOk(repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
}

/** 基线是本地分支时记下名字，worktreeStatus 用它算领先提交；提交号只留 baseCommit */
async function baseBranchName(repoPath: string, baseRef: string): Promise<string | null> {
  return (await branchExists(repoPath, baseRef)) ? baseRef : null;
}

async function branchNameValid(repoPath: string, branch: string): Promise<boolean> {
  return gitOk(repoPath, 'check-ref-format', '--branch', branch);
}

export interface DispatchBaseProbe {
  /** checkout 是这个项目的一个现有检出：项目目录本身，或它的某个 worktree */
  knownCheckout: boolean;
  /** checkout 与项目是同一个 git 仓库 */
  sameRepo: boolean;
  baseRefExists: boolean;
  branchExists: boolean;
  branchValid: boolean;
}

export interface DispatchBaseProbeInput {
  projectPath: string;
  checkout?: string;
  baseRef?: string;
  branch?: string;
}

function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** 仓库的公共 git 目录：同一个仓库的检出（含 worktree）解析到同一处 */
async function commonDir(cwd: string): Promise<string | null> {
  try {
    const raw = await git(cwd, 'rev-parse', '--git-common-dir');
    return physical(raw.startsWith('/') ? raw : join(cwd, raw));
  } catch {
    return null;
  }
}

/** 项目的全部现有检出：项目目录 + git 认得的 worktree */
async function knownCheckouts(projectPath: string): Promise<Set<string>> {
  const paths = new Set<string>([physical(projectPath)]);
  try {
    const listed = await git(projectPath, 'worktree', 'list', '--porcelain');
    for (const line of listed.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      paths.add(physical(line.slice('worktree '.length).trim()));
    }
  } catch {
    // 不是仓库：只剩项目目录本身
  }
  return paths;
}

/**
 * 派发基线的既成事实：checkout 必须是这个项目的现有检出、同一个仓库，
 * baseRef 必须能解析，branch 必须合法且没被占用。派发前一次性查清，失败就不建会话。
 */
export async function probeDispatchBase(input: DispatchBaseProbeInput): Promise<DispatchBaseProbe> {
  const { projectPath, checkout, baseRef, branch } = input;
  const projectRepo = await commonDir(projectPath);
  const facts: DispatchBaseProbe = {
    knownCheckout: true,
    sameRepo: true,
    baseRefExists: true,
    branchExists: false,
    branchValid: true,
  };
  if (checkout) {
    facts.knownCheckout = (await knownCheckouts(projectPath)).has(physical(checkout));
    const checkoutRepo = await commonDir(checkout);
    facts.sameRepo = projectRepo !== null && projectRepo === checkoutRepo;
  }
  if (baseRef) {
    facts.baseRefExists = await gitOk(
      projectPath,
      'rev-parse',
      '--verify',
      '--quiet',
      `${baseRef}^{commit}`
    );
  }
  if (branch) {
    facts.branchValid = await branchNameValid(projectPath, branch);
    facts.branchExists = await branchExists(projectPath, branch);
  }
  return facts;
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

/** 当前分支名；detached HEAD 返回 null，非 git 目录抛错 */
export async function currentBranch(repoPath: string): Promise<string | null> {
  return (await git(repoPath, 'branch', '--show-current')) || null;
}

/**
 * 删除 worktree（强制，未提交改动由上层拦截确认）。分支保留。
 * 目录已被手动删除时仅清理 git 元数据。
 * 给了托管根时先改名进 `<根>/.trash` 立即返回，空间后台释放；改名或注销失败才走原路。
 */
export async function removeSessionWorktree(record: SessionWorktree, root?: string): Promise<void> {
  if (existsSync(record.path)) {
    if (root) {
      const retired = await worktreeTrash.retire({
        repoPath: record.repoPath,
        target: record.path,
        root,
      });
      if (retired.status !== 'failed') return;
    }
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
 * 删掉 worktree 之后：分支还停在创建时的基线上（没有任何提交）就一并删除，
 * 同名分支能立刻再用；有新提交的保留。
 */
export async function deleteUntouchedSessionBranch(record: SessionWorktree): Promise<void> {
  const tip = await git(
    record.repoPath,
    'rev-parse',
    '--verify',
    `refs/heads/${record.branch}`
  ).catch(() => null);
  if (tip !== record.baseCommit) return;
  await gitOk(record.repoPath, 'branch', '-D', record.branch);
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
  await seedDependencies(record.repoPath, path);
  return { ...record, path, createdAt: Date.now() };
}

/**
 * 播种依赖到新建 worktree：零拷贝复制 node_modules，agent 首次 install 退化为校验快路径。
 * best-effort 内联等待：并行 clonefile 通常秒级完成，同步等它能避免与 agent 的 install 竞争；
 * 失败只留日志，绝不阻断 worktree 创建。
 */
async function seedDependencies(repoPath: string, worktreePath: string): Promise<void> {
  try {
    const result = await seedWorktreeDependencies({ repoPath, worktreePath });
    if (result.seeded.length > 0 || result.errors > 0) {
      console.log(
        `[worktree] seeded ${result.seeded.length} dependency dirs into ${worktreePath} ` +
          `(${result.files} files, ${result.errors} errors, ${result.durationMs}ms)`
      );
    }
  } catch (error) {
    console.warn('[worktree] dependency seeding failed (non-fatal):', error);
  }
}
