/**
 * 删 worktree 的快路径：整个目录先改名进同卷回收目录（瞬间、原子），再让 git 注销登记；
 * 占空间的递归删除放后台低优先级慢慢做。调用方立即返回，不会留下删到一半的工作区。
 *
 * 回收目录固定是 `<worktree 根>/.trash`，后台只删这个目录的直接子项，不会删到根外面。
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export const TRASH_DIR_NAME = '.trash';

export type TrashGit = (cwd: string, args: readonly string[]) => Promise<{ code: number }>;

export interface TrashFs {
  mkdir(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  /** 删掉一个回收项；抛错表示这次没删掉 */
  remove(target: string): Promise<void>;
}

export type RetireResult =
  /** 已注销登记，目录在回收目录里等后台删除 */
  | { status: 'trashed'; trashPath: string }
  /** 跨卷改名失败：退回 git worktree remove，在后台跑 */
  | { status: 'background' }
  | { status: 'failed'; reason: 'not-under-root' | 'rename-failed' | 'unregister-failed' };

export interface RetireInput {
  repoPath: string;
  target: string;
  /** target 所在的 worktree 根；回收目录建在它下面 */
  root: string;
}

export interface WorktreeTrashOptions {
  fs?: TrashFs;
  /** 注销登记用：目录已经不在，git 只删元数据，很快 */
  git?: TrashGit;
  /** 跨卷退回时的 git worktree remove：不设超时，在后台跑完 */
  backgroundGit?: TrashGit;
  /** 同时跑的后台删除数 */
  concurrency?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  schedule?: (run: () => void, ms: number) => void;
  now?: () => number;
  warn?: (message: string, error?: unknown) => void;
}

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;

function isInside(target: string, dir: string): boolean {
  const relative = path.relative(dir, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export const trashDirOf = (root: string): string => path.join(root, TRASH_DIR_NAME);

/** target 是否已经在某个根的回收目录里 */
export function isTrashPath(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInside(target, trashDirOf(root)));
}

/** 回收项必须正好是某个 `.trash` 目录的直接子项：后台删除只认这种路径 */
function isTrashEntry(target: string): boolean {
  const name = path.basename(target);
  return (
    path.isAbsolute(target) &&
    path.basename(path.dirname(target)) === TRASH_DIR_NAME &&
    name !== '' &&
    name !== '.' &&
    name !== '..'
  );
}

function execQuiet(command: string, args: readonly string[], timeout = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true }, (error) => {
      if (!error) return resolve(0);
      if (errorCode(error) === 'ENOENT') return reject(error);
      resolve(typeof error.code === 'number' ? error.code : 1);
    });
  });
}

const gitRunner =
  (timeout: number): TrashGit =>
  async (cwd, args) => ({
    code: await execQuiet('git', ['-C', cwd, ...args], timeout).catch(() => 127),
  });

/** 后台删除压低优先级：macOS 用 background QoS（限 CPU 与磁盘），其他 POSIX 用 nice */
async function removeLowPriority(target: string): Promise<void> {
  const argv: [string, string[]] | null =
    process.platform === 'darwin'
      ? ['taskpolicy', ['-b', 'rm', '-rf', '--', target]]
      : process.platform === 'win32'
        ? null
        : ['nice', ['-n', '19', 'rm', '-rf', '--', target]];
  if (argv) {
    try {
      const code = await execQuiet(argv[0], argv[1]);
      if (code !== 0) throw new Error(`${argv[0]} rm -rf exited with ${code}`);
      return;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  await rm(target, { recursive: true, force: true, maxRetries: 2 });
}

export const realTrashFs: TrashFs = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  rename,
  readdir: (dir) => readdir(dir),
  remove: removeLowPriority,
};

export class WorktreeTrash {
  private readonly fs: TrashFs;
  private readonly git: TrashGit;
  private readonly backgroundGit: TrashGit;
  private readonly concurrency: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly schedule: (run: () => void, ms: number) => void;
  private readonly now: () => number;
  private readonly warn: (message: string, error?: unknown) => void;
  private readonly queue: string[] = [];
  /** 排队、正在删、等重试的回收项：sweep 不重复入队 */
  private readonly known = new Set<string>();
  private readonly attempts = new Map<string, number>();
  /** 跨卷退回、git worktree remove 还在后台跑的 worktree */
  private readonly removing = new Set<string>();
  /** 已改名进回收目录、还在等 git 注销的：注销失败要改名回去，sweep 不能先删 */
  private readonly reserved = new Set<string>();
  private running = 0;
  private seq = 0;
  private waiters: Array<() => void> = [];

  constructor(options: WorktreeTrashOptions = {}) {
    this.fs = options.fs ?? realTrashFs;
    this.git = options.git ?? gitRunner(30_000);
    this.backgroundGit = options.backgroundGit ?? gitRunner(0);
    this.concurrency = options.concurrency ?? 1;
    this.retryDelayMs = options.retryDelayMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.schedule =
      options.schedule ??
      ((run, ms) => {
        setTimeout(run, ms).unref?.();
      });
    this.now = options.now ?? Date.now;
    this.warn =
      options.warn ?? ((message, error) => console.warn(`[worktree-trash] ${message}`, error));
  }

  /**
   * 改名进回收目录 → 注销 git 登记 → 后台删除。注销失败（如 worktree 被锁）就改名回去，
   * 原样保留。跨卷改名失败时退回 git worktree remove，在后台跑完。
   */
  async retire({ repoPath, target, root }: RetireInput): Promise<RetireResult> {
    const trashDir = trashDirOf(root);
    if (!isInside(target, root) || target === trashDir || isInside(target, trashDir))
      return { status: 'failed', reason: 'not-under-root' };
    this.seq += 1;
    const trashPath = path.join(
      trashDir,
      `${path.basename(target)}-${this.now().toString(36)}-${this.seq}`
    );
    this.reserved.add(trashPath);
    try {
      return await this.moveAndUnregister(repoPath, target, root, trashPath);
    } finally {
      this.reserved.delete(trashPath);
      if (this.known.has(trashPath)) this.pump();
    }
  }

  private async moveAndUnregister(
    repoPath: string,
    target: string,
    root: string,
    trashPath: string
  ): Promise<RetireResult> {
    const trashDir = trashDirOf(root);
    try {
      await this.fs.mkdir(trashDir);
      await this.fs.rename(target, trashPath);
    } catch (error) {
      if (errorCode(error) !== 'EXDEV') {
        this.warn(`rename ${target} failed`, error);
        return { status: 'failed', reason: 'rename-failed' };
      }
      this.removeInBackground(repoPath, target);
      return { status: 'background' };
    }
    // 目录已经不在原处：git 只删 .git/worktrees/<id>，不碰回收目录里的内容
    const unregistered = await this.git(repoPath, ['worktree', 'remove', '--force', target]);
    if (unregistered.code !== 0) {
      try {
        await this.fs.rename(trashPath, target);
      } catch (error) {
        this.warn(`restore ${target} failed, left in ${trashPath}`, error);
      }
      return { status: 'failed', reason: 'unregister-failed' };
    }
    this.known.add(trashPath);
    this.queue.push(trashPath);
    // 顺带重试回收目录里之前没删掉的
    void this.sweep(root);
    return { status: 'trashed', trashPath };
  }

  /** 跨卷退回的 worktree 还在后台删：清单不该再列它 */
  isRemoving(target: string): boolean {
    return this.removing.has(target);
  }

  /** 把回收目录里现有的项都排进后台删除：启动时与每次清理时调用 */
  async sweep(root: string): Promise<void> {
    const trashDir = trashDirOf(root);
    let names: string[];
    try {
      names = await this.fs.readdir(trashDir);
    } catch {
      return;
    }
    for (const name of names) this.enqueue(path.join(trashDir, name));
  }

  enqueue(trashPath: string): void {
    if (!isTrashEntry(trashPath) || this.known.has(trashPath) || this.reserved.has(trashPath))
      return;
    this.known.add(trashPath);
    this.queue.push(trashPath);
    this.pump();
  }

  /** 排队与正在删的数量（不含等重试的） */
  pending(): number {
    return this.queue.length + this.running;
  }

  /** 队列清空、没有在跑的删除时 resolve；测试用 */
  idle(): Promise<void> {
    if (this.pending() === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      // 还在等注销的项先不删
      const index = this.queue.findIndex((entry) => !this.reserved.has(entry));
      if (index < 0) return;
      const [next] = this.queue.splice(index, 1) as [string];
      this.running += 1;
      void this.removeOne(next).finally(() => {
        this.running -= 1;
        this.pump();
        if (this.pending() === 0) {
          const waiters = this.waiters;
          this.waiters = [];
          for (const resolve of waiters) resolve();
        }
      });
    }
  }

  private async removeOne(trashPath: string): Promise<void> {
    try {
      await this.fs.remove(trashPath);
      this.known.delete(trashPath);
      this.attempts.delete(trashPath);
    } catch (error) {
      const attempt = (this.attempts.get(trashPath) ?? 0) + 1;
      this.warn(`remove ${trashPath} failed (attempt ${attempt})`, error);
      if (attempt >= this.maxAttempts) {
        // 放弃这一轮：下次启动或下次清理的 sweep 会再排进来
        this.known.delete(trashPath);
        this.attempts.delete(trashPath);
        return;
      }
      this.attempts.set(trashPath, attempt);
      this.schedule(() => {
        this.queue.push(trashPath);
        this.pump();
      }, this.retryDelayMs * attempt);
    }
  }

  private removeInBackground(repoPath: string, target: string): void {
    this.removing.add(target);
    void (async () => {
      const removed = await this.backgroundGit(repoPath, ['worktree', 'remove', '--force', target]);
      if (removed.code !== 0) this.warn(`background remove ${target} exited with ${removed.code}`);
      await this.backgroundGit(repoPath, ['worktree', 'prune']);
    })()
      .catch((error) => this.warn(`background remove ${target} failed`, error))
      .finally(() => this.removing.delete(target));
  }
}

/** 进程级唯一实例：秘书清理与界面删除共用一条后台队列 */
export const worktreeTrash = new WorktreeTrash();
