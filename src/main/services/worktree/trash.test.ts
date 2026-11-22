import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTrashPath, type TrashFs, type TrashGit, WorktreeTrash } from './trash';

const ROOT = '/wt';

function fakeFs(overrides: Partial<TrashFs> = {}) {
  const renames: Array<[string, string]> = [];
  const removed: string[] = [];
  const fs: TrashFs = {
    mkdir: async () => undefined,
    rename: async (from, to) => {
      renames.push([from, to]);
    },
    readdir: async () => [],
    remove: async (target) => {
      removed.push(target);
    },
    ...overrides,
  };
  return { fs, renames, removed };
}

const okGit: TrashGit = async () => ({ code: 0 });

describe('WorktreeTrash.retire', () => {
  it('改名进回收目录、注销登记后立即返回，删除在后台排队', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fs, renames, removed } = fakeFs({
      remove: async (target) => {
        await gate;
        removed.push(target);
      },
    });
    const gitCalls: string[][] = [];
    const trash = new WorktreeTrash({
      fs,
      git: async (cwd, args) => {
        gitCalls.push([cwd, ...args]);
        return { code: 0 };
      },
      now: () => 1000,
    });
    const result = await trash.retire({ repoPath: '/repo', target: `${ROOT}/p/a`, root: ROOT });
    expect(result).toMatchObject({ status: 'trashed' });
    const trashPath = (result as { trashPath: string }).trashPath;
    expect(path.dirname(trashPath)).toBe(`${ROOT}/.trash`);
    expect(renames).toEqual([[`${ROOT}/p/a`, trashPath]]);
    expect(gitCalls).toEqual([['/repo', 'worktree', 'remove', '--force', `${ROOT}/p/a`]]);
    // 返回时删除还没完成
    expect(removed).toEqual([]);
    expect(trash.pending()).toBe(1);
    release();
    await trash.idle();
    expect(removed).toEqual([trashPath]);
  });

  it('注销失败（如被锁）就改名回去，不删', async () => {
    const { fs, renames, removed } = fakeFs();
    const trash = new WorktreeTrash({ fs, git: async () => ({ code: 128 }) });
    const result = await trash.retire({ repoPath: '/repo', target: `${ROOT}/a`, root: ROOT });
    expect(result).toEqual({ status: 'failed', reason: 'unregister-failed' });
    expect(renames[1]).toEqual([renames[0]?.[1], `${ROOT}/a`]);
    await trash.idle();
    expect(removed).toEqual([]);
  });

  it('根之外、根本身、回收目录里的路径一律拒绝', async () => {
    const { fs, renames } = fakeFs();
    const trash = new WorktreeTrash({ fs, git: okGit });
    for (const target of [
      '/elsewhere/a',
      ROOT,
      `${ROOT}/.trash`,
      `${ROOT}/.trash/x`,
      `${ROOT}/../x`,
    ])
      expect(await trash.retire({ repoPath: '/repo', target, root: ROOT })).toEqual({
        status: 'failed',
        reason: 'not-under-root',
      });
    expect(renames).toEqual([]);
  });

  it('跨卷改名失败时退回 git worktree remove，在后台跑', async () => {
    const exdev = Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    const { fs } = fakeFs({
      rename: async () => {
        throw exdev;
      },
    });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const background: string[][] = [];
    const trash = new WorktreeTrash({
      fs,
      git: okGit,
      backgroundGit: async (cwd, args) => {
        background.push([cwd, ...args]);
        if (args[0] === 'worktree' && args[1] === 'remove') await done;
        return { code: 0 };
      },
    });
    const target = `${ROOT}/a`;
    expect(await trash.retire({ repoPath: '/repo', target, root: ROOT })).toEqual({
      status: 'background',
    });
    expect(trash.isRemoving(target)).toBe(true);
    finish();
    await vi.waitFor(() => expect(trash.isRemoving(target)).toBe(false));
    expect(background).toEqual([
      ['/repo', 'worktree', 'remove', '--force', target],
      ['/repo', 'worktree', 'prune'],
    ]);
  });

  it('其他改名错误不删，报告失败', async () => {
    const { fs } = fakeFs({
      rename: async () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      },
    });
    const trash = new WorktreeTrash({ fs, git: okGit, warn: () => undefined });
    expect(await trash.retire({ repoPath: '/repo', target: `${ROOT}/a`, root: ROOT })).toEqual({
      status: 'failed',
      reason: 'rename-failed',
    });
  });
});

describe('WorktreeTrash 后台删除', () => {
  it('失败后按延迟重试，成功即止', async () => {
    let failures = 2;
    const removed: string[] = [];
    const scheduled: number[] = [];
    const { fs } = fakeFs({
      remove: async (target) => {
        if (failures-- > 0) throw new Error('EBUSY');
        removed.push(target);
      },
    });
    const trash = new WorktreeTrash({
      fs,
      git: okGit,
      retryDelayMs: 10,
      maxAttempts: 5,
      warn: () => undefined,
      schedule: (run, ms) => {
        scheduled.push(ms);
        queueMicrotask(run);
      },
    });
    trash.enqueue(`${ROOT}/.trash/a-1`);
    await vi.waitFor(() => expect(removed).toHaveLength(1));
    expect(scheduled).toEqual([10, 20]);
    expect(removed).toEqual([`${ROOT}/.trash/a-1`]);
  });

  it('超过次数就放下，下次 sweep 再排进来', async () => {
    let fail = true;
    const removed: string[] = [];
    const { fs } = fakeFs({
      readdir: async () => ['a-1'],
      remove: async (target) => {
        if (fail) throw new Error('EPERM');
        removed.push(target);
      },
    });
    const trash = new WorktreeTrash({
      fs,
      git: okGit,
      maxAttempts: 1,
      warn: () => undefined,
      schedule: () => {
        throw new Error('should not retry');
      },
    });
    await trash.sweep(ROOT);
    await trash.idle();
    expect(removed).toEqual([]);
    fail = false;
    await trash.sweep(ROOT);
    await trash.idle();
    expect(removed).toEqual([`${ROOT}/.trash/a-1`]);
  });

  it('并发受限，同一项不重复入队，只删回收目录的直接子项', async () => {
    let active = 0;
    let peak = 0;
    const removed: string[] = [];
    const { fs } = fakeFs({
      remove: async (target) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        removed.push(target);
      },
    });
    const trash = new WorktreeTrash({ fs, git: okGit, concurrency: 2 });
    for (const name of ['a', 'b', 'c', 'a']) trash.enqueue(`${ROOT}/.trash/${name}`);
    trash.enqueue(`${ROOT}/p/a`);
    trash.enqueue(`${ROOT}/.trash`);
    await trash.idle();
    expect(peak).toBe(2);
    expect(removed.sort()).toEqual([`${ROOT}/.trash/a`, `${ROOT}/.trash/b`, `${ROOT}/.trash/c`]);
  });

  it('isTrashPath 只认根下 .trash 里的路径', () => {
    expect(isTrashPath(`${ROOT}/.trash/a`, [ROOT])).toBe(true);
    expect(isTrashPath(`${ROOT}/.trash/a/b`, [ROOT])).toBe(true);
    expect(isTrashPath(`${ROOT}/a/.trash/b`, [ROOT])).toBe(false);
    expect(isTrashPath(`${ROOT}/a`, [ROOT])).toBe(false);
  });
});

describe('WorktreeTrash 真实 git', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('改名后注销登记、分支可删，目录随后在后台删掉', async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'enso-trash-')));
    const repo = path.join(dir, 'repo');
    const root = path.join(dir, 'wt');
    mkdirSync(repo);
    mkdirSync(root);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    git(repo, 'init', '-q', '-b', 'main');
    git(
      repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init'
    );
    const target = path.join(root, 'a');
    git(repo, 'worktree', 'add', '-q', '-b', 'fix/a', target);
    writeFileSync(path.join(target, 'big.bin'), 'x'.repeat(1024));
    const trash = new WorktreeTrash();
    const result = await trash.retire({ repoPath: repo, target, root });
    expect(result.status).toBe('trashed');
    expect(existsSync(target)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain(target);
    git(repo, 'branch', '-D', 'fix/a');
    await trash.idle();
    expect(readdirSync(path.join(root, '.trash'))).toEqual([]);
  });
});
