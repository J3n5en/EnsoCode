import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanDependencyDirs, seedWorktreeDependencies } from './seed';

let repo: string;
let worktree: string;

function makeNodeModules(base: string, rel: string, files: Record<string, string>) {
  const dir = join(base, rel, 'node_modules');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'enso-seed-repo-'));
  worktree = mkdtempSync(join(tmpdir(), 'enso-seed-wt-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

describe('scanDependencyDirs', () => {
  it('找到根 node_modules', () => {
    makeNodeModules(repo, '.', { 'a.js': 'x' });
    expect(scanDependencyDirs(repo)).toEqual(['node_modules']);
  });

  it('找到 packages 下的嵌套 node_modules，相对路径返回', () => {
    makeNodeModules(repo, '.', { 'a.js': 'x' });
    makeNodeModules(repo, 'packages/alpha', { 'b.js': 'y' });
    makeNodeModules(repo, 'packages/beta', { 'c.js': 'z' });
    const found = scanDependencyDirs(repo);
    expect(found).toContain('node_modules');
    expect(found).toContain('packages/alpha/node_modules');
    expect(found).toContain('packages/beta/node_modules');
  });

  it('不进 node_modules 内部、不进 .git 与隐藏目录', () => {
    makeNodeModules(repo, '.', { 'a.js': 'x' });
    // node_modules 里面的 node_modules（依赖的依赖）不该算作种子单元
    makeNodeModules(repo, 'node_modules/some-dep', { 'd.js': 'w' });
    makeNodeModules(repo, '.git', { 'e.js': 'v' });
    makeNodeModules(repo, '.hidden', { 'f.js': 'u' });
    const found = scanDependencyDirs(repo);
    expect(found).toEqual(['node_modules']);
  });

  it('深度受限：超过 4 层目录的 node_modules 不扫', () => {
    makeNodeModules(repo, 'a/b/c', { 'g.js': 't' });
    makeNodeModules(repo, 'a/b/c/d/e', { 'h.js': 's' });
    const found = scanDependencyDirs(repo);
    expect(found).toContain('a/b/c/node_modules');
    expect(found).not.toContain('a/b/c/d/e/node_modules');
  });

  it('没有 node_modules 返回空', () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    expect(scanDependencyDirs(repo)).toEqual([]);
  });
});

describe('seedWorktreeDependencies', () => {
  it('把根 node_modules 种进 worktree，内容一致', async () => {
    makeNodeModules(repo, '.', { 'dep.js': 'module content' });
    const result = await seedWorktreeDependencies({ repoPath: repo, worktreePath: worktree });
    expect(result.seeded).toEqual(['node_modules']);
    expect(readFileSync(join(worktree, 'node_modules', 'dep.js'), 'utf8')).toBe('module content');
  });

  it('符号链接原样保留（pnpm 布局依赖链接结构）', async () => {
    const dir = makeNodeModules(repo, '.', { 'real-pkg.js': 'real' });
    symlinkSync('real-pkg.js', join(dir, 'linked-pkg.js'));
    await seedWorktreeDependencies({ repoPath: repo, worktreePath: worktree });
    const link = join(worktree, 'node_modules', 'linked-pkg.js');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('real-pkg.js');
  });

  it('嵌套 node_modules 一并播种', async () => {
    makeNodeModules(repo, '.', { 'a.js': 'x' });
    makeNodeModules(repo, 'packages/alpha', { 'b.js': 'y' });
    const result = await seedWorktreeDependencies({ repoPath: repo, worktreePath: worktree });
    expect(result.seeded).toContain('packages/alpha/node_modules');
    expect(existsSync(join(worktree, 'packages/alpha/node_modules/b.js'))).toBe(true);
  });

  it('目标已有 node_modules 时跳过，不覆盖', async () => {
    makeNodeModules(repo, '.', { 'a.js': 'source' });
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    writeFileSync(join(worktree, 'node_modules', 'a.js'), 'existing');
    const result = await seedWorktreeDependencies({ repoPath: repo, worktreePath: worktree });
    expect(result.seeded).toEqual([]);
    expect(result.skipped).toEqual([{ dir: 'node_modules', reason: 'exists' }]);
    expect(readFileSync(join(worktree, 'node_modules', 'a.js'), 'utf8')).toBe('existing');
  });

  it('源仓库没有 node_modules：空结果，不报错', async () => {
    const result = await seedWorktreeDependencies({ repoPath: repo, worktreePath: worktree });
    expect(result.seeded).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('源路径不存在也不抛错（best-effort）', async () => {
    const result = await seedWorktreeDependencies({
      repoPath: join(repo, 'missing'),
      worktreePath: worktree,
    });
    expect(result.seeded).toEqual([]);
  });

  it('报告耗时', async () => {
    makeNodeModules(repo, '.', { 'a.js': 'x' });
    const result = await seedWorktreeDependencies({ repoPath: repo, worktreePath: worktree });
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
