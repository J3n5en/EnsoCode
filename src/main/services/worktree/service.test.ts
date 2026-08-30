import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionWorktree,
  rebuildSessionWorktree,
  removeSessionWorktree,
  repoIsClean,
  worktreeStatus,
} from './service';

const runGit = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// 真实 git 仓库 + worktree 操作，放宽超时（参照 checkpoint.test.ts）
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

let repo: string;
let root: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'enso-wt-repo-'));
  root = mkdtempSync(join(tmpdir(), 'enso-wt-root-'));
  runGit(repo, 'init', '-q', '-b', 'main');
  runGit(repo, 'config', 'user.name', 'test');
  runGit(repo, 'config', 'user.email', 'test@test');
  writeFileSync(join(repo, 'a.txt'), 'v1\n');
  runGit(repo, 'add', '.');
  runGit(repo, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('createSessionWorktree', () => {
  it('从 HEAD 创建 worktree，记录分支与基准', async () => {
    const record = await createSessionWorktree({
      repoPath: repo,
      conversationId: 'conv-abc12345',
      projectId: 'proj-1',
      root,
    });
    expect(existsSync(join(record.path, 'a.txt'))).toBe(true);
    expect(record.branch).toMatch(/^enso\//);
    expect(record.baseBranch).toBe('main');
    expect(record.baseCommit).toBe(runGit(repo, 'rev-parse', 'HEAD'));
    expect(record.path.startsWith(root)).toBe(true);
    // worktree 的当前分支是新分支
    expect(runGit(record.path, 'branch', '--show-current')).toBe(record.branch);
  });

  it('无提交的仓库报错', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'enso-wt-empty-'));
    runGit(empty, 'init', '-q');
    await expect(
      createSessionWorktree({ repoPath: empty, conversationId: 'c1', projectId: 'p1', root })
    ).rejects.toThrow(/no commits|提交/i);
    rmSync(empty, { recursive: true, force: true });
  });

  it('非 git 目录报错', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'enso-wt-plain-'));
    await expect(
      createSessionWorktree({ repoPath: plain, conversationId: 'c1', projectId: 'p1', root })
    ).rejects.toThrow();
    rmSync(plain, { recursive: true, force: true });
  });

  it('同会话重复创建生成不冲突的分支名', async () => {
    const a = await createSessionWorktree({
      repoPath: repo,
      conversationId: 'conv-dup',
      projectId: 'p1',
      root,
    });
    const b = await createSessionWorktree({
      repoPath: repo,
      conversationId: 'conv-dup',
      projectId: 'p1',
      root,
    });
    expect(b.branch).not.toBe(a.branch);
    expect(b.path).not.toBe(a.path);
  });
});

describe('worktreeStatus', () => {
  it('干净且无领先提交', async () => {
    const record = await createSessionWorktree({
      repoPath: repo,
      conversationId: 'c-clean',
      projectId: 'p1',
      root,
    });
    const status = await worktreeStatus(record);
    expect(status).toEqual({ exists: true, dirty: false, ahead: 0 });
  });

  it('未提交改动 → dirty；提交后 → ahead', async () => {
    const record = await createSessionWorktree({
      repoPath: repo,
      conversationId: 'c-dirty',
      projectId: 'p1',
      root,
    });
    writeFileSync(join(record.path, 'b.txt'), 'new\n');
    let status = await worktreeStatus(record);
    expect(status.dirty).toBe(true);
    expect(status.ahead).toBe(0);

    runGit(record.path, 'add', '.');
    runGit(record.path, 'commit', '-q', '-m', 'work');
    status = await worktreeStatus(record);
    expect(status.dirty).toBe(false);
    expect(status.ahead).toBe(1);
  });

  it('base 分支被删后回退到 baseCommit 计算 ahead', async () => {
    const record = await createSessionWorktree({
      repoPath: repo,
      conversationId: 'c-nobranch',
      projectId: 'p1',
      root,
    });
    writeFileSync(join(record.path, 'b.txt'), 'new\n');
    runGit(record.path, 'add', '.');
    runGit(record.path, 'commit', '-q', '-m', 'work');
    // 主工作树切走并删掉 main
    runGit(repo, 'checkout', '-q', '-b', 'other');
    runGit(repo, 'branch', '-D', 'main');
    const status = await worktreeStatus(record);
    expect(status.ahead).toBe(1);
  });

  it('worktree 目录被删 → exists=false', async () => {
    const record = await createSessionWorktree({
      repoPath: repo,
      conversationId: 'c-gone',
      projectId: 'p1',
      root,
    });
    rmSync(record.path, { recursive: true, force: true });
    const status = await worktreeStatus(record);
    expect(status.exists).toBe(false);
  });
});

describe('repoIsClean', () => {
  it('干净仓库 true，有未提交改动 false', async () => {
    expect(await repoIsClean(repo)).toBe(true);
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    expect(await repoIsClean(repo)).toBe(false);
  });

  it('非 git 目录报错', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'enso-wt-plain2-'));
    await expect(repoIsClean(plain)).rejects.toThrow();
    rmSync(plain, { recursive: true, force: true });
  });
});

describe('removeSessionWorktree', () => {
  it('删除 worktree 目录并保留分支', async () => {
    const record = await createSessionWorktree({
      repoPath: repo,
      conversationId: 'c-rm',
      projectId: 'p1',
      root,
    });
    // 弄脏也要能强制删（拦截确认在上层，service 层执行即强制）
    writeFileSync(join(record.path, 'dirty.txt'), 'x\n');
    await removeSessionWorktree(record);
    expect(existsSync(record.path)).toBe(false);
    // 分支保留
    expect(runGit(repo, 'branch', '--list', record.branch)).toContain(record.branch);
    // git 元数据已清（可重复创建同名不报错）
    expect(runGit(repo, 'worktree', 'list')).not.toContain(record.path);
  });

  it('目录已被手动删除时也能清理元数据不报错', async () => {
    const record = await createSessionWorktree({
      repoPath: repo,
      conversationId: 'c-rm2',
      projectId: 'p1',
      root,
    });
    rmSync(record.path, { recursive: true, force: true });
    await expect(removeSessionWorktree(record)).resolves.toBeUndefined();
    expect(runGit(repo, 'worktree', 'list')).not.toContain(record.path);
  });
});

describe('rebuildSessionWorktree', () => {
  it('分支仍在：从记录分支重建，保留已提交的工作', async () => {
    const record = await createSessionWorktree({
      repoPath: repo,
      conversationId: 'c-rebuild',
      projectId: 'p1',
      root,
    });
    writeFileSync(join(record.path, 'work.txt'), 'done\n');
    runGit(record.path, 'add', '.');
    runGit(record.path, 'commit', '-q', '-m', 'work');
    rmSync(record.path, { recursive: true, force: true });
    runGit(repo, 'worktree', 'prune');

    const rebuilt = await rebuildSessionWorktree(record, root);
    expect(rebuilt.branch).toBe(record.branch);
    expect(existsSync(join(rebuilt.path, 'work.txt'))).toBe(true);
  });

  it('分支也没了：从 baseCommit 重建新分支', async () => {
    const record = await createSessionWorktree({
      repoPath: repo,
      conversationId: 'c-rebuild2',
      projectId: 'p1',
      root,
    });
    rmSync(record.path, { recursive: true, force: true });
    runGit(repo, 'worktree', 'prune');
    runGit(repo, 'branch', '-D', record.branch);

    const rebuilt = await rebuildSessionWorktree(record, root);
    expect(existsSync(join(rebuilt.path, 'a.txt'))).toBe(true);
    expect(rebuilt.baseCommit).toBe(record.baseCommit);
    expect(runGit(rebuilt.path, 'rev-parse', 'HEAD')).toBe(record.baseCommit);
  });
});
