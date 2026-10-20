import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitRepository, parseGitStatus, validateGitPath } from './gitVersionControl';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let root: string;
let repo: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'enso-git-panel-'));
  repo = join(root, 'repo');
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.com');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('Git 版本管理', () => {
  it('初始仓库可暂存、取消暂存并创建首个提交', async () => {
    const repository = await GitRepository.open(repo);
    expect(await repository.history()).toEqual({ ok: true, commits: [], hasMore: false });
    writeFileSync(join(repo, 'a.txt'), 'first\n');
    await repository.stage(['a.txt']);
    expect((await repository.status()).staged).toEqual([{ path: 'a.txt', status: 'added' }]);
    await repository.unstage();
    expect(git(repo, 'ls-files')).toBe('');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('first\n');
    await repository.stage();
    await repository.commit('首个提交');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('首个提交');
  });

  it('同一文件的暂存与未暂存内容独立展示，丢弃仅恢复到索引', async () => {
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    const repository = await GitRepository.open(repo);
    writeFileSync(join(repo, 'a.txt'), 'staged\n');
    await repository.stage(['a.txt']);
    writeFileSync(join(repo, 'a.txt'), 'working\n');
    const status = await repository.status();
    expect(status.staged).toEqual([{ path: 'a.txt', status: 'modified' }]);
    expect(status.unstaged).toEqual([{ path: 'a.txt', status: 'modified' }]);
    expect(await repository.fileDiff('a.txt', true)).toMatchObject({
      oldText: 'base\n',
      newText: 'staged\n',
    });
    expect(await repository.fileDiff('a.txt', false)).toMatchObject({
      oldText: 'staged\n',
      newText: 'working\n',
    });
    await repository.discard(['a.txt'], false);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('staged\n');
    expect(git(repo, 'show', ':a.txt')).toBe('staged');
  });

  it('未跟踪文件删除必须确认，且批量校验失败时不先删除其他文件', async () => {
    const repository = await GitRepository.open(repo);
    writeFileSync(join(repo, 'keep.txt'), 'keep');
    await expect(repository.discard(['keep.txt'], false)).rejects.toThrow();
    await expect(repository.discard(['keep.txt', '../outside'], true)).rejects.toThrow();
    expect(readFileSync(join(repo, 'keep.txt'), 'utf8')).toBe('keep');
    await repository.discard(['keep.txt'], true);
    expect((await repository.status()).unstaged).toEqual([]);
  });

  it('文件被目录替换后拒绝暂存父路径，不能带入未选中的目录内容', async () => {
    writeFileSync(join(repo, 'a.txt'), 'base');
    writeFileSync(join(repo, 'b.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    unlinkSync(join(repo, 'a.txt'));
    mkdirSync(join(repo, 'a.txt'));
    writeFileSync(join(repo, 'a.txt', 'valuable.txt'), 'keep');
    writeFileSync(join(repo, 'b.txt'), 'changed');
    const repository = await GitRepository.open(repo);
    await expect(repository.stage(['b.txt', 'a.txt'])).rejects.toThrow();
    expect((await repository.status()).staged).toEqual([]);
    expect(readFileSync(join(repo, 'a.txt', 'valuable.txt'), 'utf8')).toBe('keep');
  });

  it('文件被目录替换后拒绝丢弃，校验完全部目标前不恢复其他文件', async () => {
    writeFileSync(join(repo, 'a.txt'), 'base');
    writeFileSync(join(repo, 'b.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    unlinkSync(join(repo, 'a.txt'));
    mkdirSync(join(repo, 'a.txt'));
    writeFileSync(join(repo, 'a.txt', 'valuable.txt'), 'keep');
    writeFileSync(join(repo, 'b.txt'), 'changed');
    const repository = await GitRepository.open(repo);
    await expect(repository.discard(['b.txt', 'a.txt'], false)).rejects.toThrow();
    expect(readFileSync(join(repo, 'a.txt', 'valuable.txt'), 'utf8')).toBe('keep');
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('changed');
    expect(git(repo, 'show', 'HEAD:a.txt')).toBe('base');
  });

  it('取消暂存删除项不能递归取消未选中的暂存子项', async () => {
    writeFileSync(join(repo, 'a.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    unlinkSync(join(repo, 'a.txt'));
    mkdirSync(join(repo, 'a.txt'));
    writeFileSync(join(repo, 'a.txt', 'valuable.txt'), 'keep');
    git(repo, 'add', '--all');
    rmSync(join(repo, 'a.txt'), { recursive: true });
    const repository = await GitRepository.open(repo);
    const before = (await repository.status()).staged;
    await expect(repository.unstage(['a.txt'])).rejects.toThrow();
    expect((await repository.status()).staged).toEqual(before);
    expect(git(repo, 'show', ':a.txt/valuable.txt')).toBe('keep');
  });

  it('取消暂存子路径不能移除未选中的暂存父路径文件', async () => {
    mkdirSync(join(repo, 'folder'));
    writeFileSync(join(repo, 'folder', 'a.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'rm', '-r', 'folder');
    writeFileSync(join(repo, 'folder'), 'replacement');
    git(repo, 'add', 'folder');
    unlinkSync(join(repo, 'folder'));
    const repository = await GitRepository.open(repo);
    const before = (await repository.status()).staged;
    await expect(repository.unstage(['folder/a.txt'])).rejects.toThrow();
    expect((await repository.status()).staged).toEqual(before);
    expect(git(repo, 'show', ':folder')).toBe('replacement');
  });

  it('仅提交暂存区，保留未暂存内容，并可分页查看首个提交 diff', async () => {
    const repository = await GitRepository.open(repo);
    writeFileSync(join(repo, 'a.txt'), 'staged\n');
    await repository.stage();
    writeFileSync(join(repo, 'a.txt'), 'working\n');
    await repository.commit('first');
    const hash = git(repo, 'rev-parse', 'HEAD');
    expect(git(repo, 'show', 'HEAD:a.txt')).toBe('staged');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('working\n');
    expect(await repository.commitFiles(hash)).toEqual({
      ok: true,
      files: [{ path: 'a.txt', status: 'added' }],
    });
    expect(await repository.commitDiff(hash, 'a.txt')).toEqual({
      ok: true,
      path: 'a.txt',
      oldText: '',
      newText: 'staged\n',
    });
    await repository.stage();
    await repository.commit('second');
    expect(await repository.history(0, 1)).toMatchObject({
      commits: [{ subject: 'second' }],
      hasMore: true,
    });
    expect(await repository.history(1, 1)).toMatchObject({
      commits: [{ subject: 'first' }],
      hasMore: false,
    });
  });

  it('二进制和大文件保留在列表且可暂存，预览返回明确不可用', async () => {
    writeFileSync(join(repo, 'binary.dat'), Buffer.from([1, 0, 2]));
    writeFileSync(join(repo, 'large.txt'), 'x'.repeat(2_000_001));
    const repository = await GitRepository.open(repo);
    expect((await repository.status()).unstaged).toHaveLength(2);
    await repository.stage();
    expect((await repository.status()).staged).toHaveLength(2);
    await expect(repository.fileDiff('binary.dat', true)).rejects.toMatchObject({
      unavailable: true,
    });
    await expect(repository.fileDiff('large.txt', true)).rejects.toMatchObject({
      unavailable: true,
    });
  });

  it('历史分页固定 head，新增提交不会让后续页重复或偏移', async () => {
    const repository = await GitRepository.open(repo);
    for (const message of ['first', 'second', 'third']) {
      writeFileSync(join(repo, 'a.txt'), message);
      await repository.stage();
      await repository.commit(message);
    }
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(await repository.history(0, 1, head)).toMatchObject({
      commits: [{ subject: 'third' }],
      hasMore: true,
    });
    writeFileSync(join(repo, 'a.txt'), 'fourth');
    await repository.stage();
    await repository.commit('fourth');
    expect(await repository.history(1, 1, head)).toMatchObject({
      commits: [{ subject: 'second' }],
      hasMore: true,
    });
    expect(await repository.history(2, 1, head)).toMatchObject({
      commits: [{ subject: 'first' }],
      hasMore: false,
    });
    await expect(repository.history(0, 1, '--all')).rejects.toMatchObject({
      code: 'invalid-request',
    });
  });

  it('重命名按删除与新增列出，两边均可全部取消暂存', async () => {
    writeFileSync(join(repo, 'old name.txt'), 'content\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'mv', 'old name.txt', 'new name.txt');
    const repository = await GitRepository.open(repo);
    expect((await repository.status()).staged).toEqual([
      { path: 'new name.txt', status: 'added' },
      { path: 'old name.txt', status: 'deleted' },
    ]);
    await repository.unstage();
    expect((await repository.status()).staged).toEqual([]);
  });

  it('仓库子目录以仓库根为相对路径基准，带特殊字符文件按字面处理', async () => {
    mkdirSync(join(repo, 'nested'));
    writeFileSync(join(repo, '[literal].txt'), 'literal');
    writeFileSync(join(repo, 'l.txt'), 'other');
    const repository = await GitRepository.open(join(repo, 'nested'));
    await repository.stage(['[literal].txt']);
    expect(git(repo, 'ls-files')).toBe('[literal].txt');
  });

  it('丢弃和暂存都拒绝穿过目录符号链接，保留仓库外文件', async () => {
    const nested = join(repo, 'nested');
    const outside = join(root, 'outside');
    mkdirSync(nested);
    mkdirSync(outside);
    writeFileSync(join(nested, 'file.txt'), 'base');
    writeFileSync(join(outside, 'file.txt'), 'outside');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    rmSync(nested, { recursive: true });
    symlinkSync(outside, nested, process.platform === 'win32' ? 'junction' : 'dir');
    const repository = await GitRepository.open(repo);
    await expect(repository.discard(['nested/file.txt'], true)).rejects.toMatchObject({
      code: 'invalid-path',
    });
    await expect(repository.stage(['nested/file.txt'])).rejects.toMatchObject({
      code: 'invalid-path',
    });
    expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe('outside');
    expect(git(repo, 'show', 'HEAD:nested/file.txt')).toBe('base');
  });

  it('空文件列表无副作用，提交前授权变化不修改索引或 HEAD', async () => {
    writeFileSync(join(repo, 'a.txt'), 'base');
    let authorized = true;
    const repository = await GitRepository.open(repo, () => {
      if (!authorized) throw new Error('authority changed');
    });
    await repository.stage([]);
    expect(git(repo, 'ls-files')).toBe('');
    await repository.stage(['a.txt']);
    authorized = false;
    await expect(repository.commit('blocked')).rejects.toThrow('authority changed');
    expect((await repository.status()).head).toBeNull();
    expect(git(repo, 'show', ':a.txt')).toBe('base');
  });

  it('解析冲突、特殊字符文件名和分支领先落后，不能静默跳过冲突', () => {
    const status = parseGitStatus(
      [
        '# branch.oid abc',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +2 -3',
        '1 MM N... 100644 100644 100644 abc def file with\nnewline.txt',
        'u UU N... 100644 100644 100644 100644 abc def ghi conflict.txt',
        '? new\tfile.txt',
        '',
      ].join('\0')
    );
    expect(status).toMatchObject({
      branch: 'main',
      head: 'abc',
      upstream: 'origin/main',
      ahead: 2,
      behind: 3,
    });
    expect(status.staged).toEqual([
      { path: 'file with\nnewline.txt', status: 'modified' },
      { path: 'conflict.txt', status: 'conflicted' },
    ]);
    expect(status.unstaged).toEqual([
      { path: 'file with\nnewline.txt', status: 'modified' },
      { path: 'conflict.txt', status: 'conflicted' },
      { path: 'new\tfile.txt', status: 'untracked' },
    ]);
  });

  it.each([
    '',
    '.',
    '..',
    '../file',
    '/file',
    'C:/file',
    '\\server\\file',
    '-x',
    ':(glob)*',
    'a/../b',
    '.. /outside',
    '.git/config',
    'x/.GIT/config',
    'NUL',
    'con.txt',
  ])('拒绝不安全路径 %j', (path) => {
    expect(() => validateGitPath(path)).toThrow();
  });

  it('继承的 Git 环境变量不能把索引写入权威仓库外', async () => {
    const outsideIndex = join(root, 'outside-index');
    vi.stubEnv('GIT_INDEX_FILE', outsideIndex);
    writeFileSync(join(repo, 'a.txt'), 'inside');
    const repository = await GitRepository.open(repo);
    await repository.stage(['a.txt']);
    expect(existsSync(outsideIndex)).toBe(false);
    expect(existsSync(join(repo, '.git', 'index'))).toBe(true);
    expect((await repository.status()).staged).toEqual([{ path: 'a.txt', status: 'added' }]);
  });

  it('没有 upstream 时 pull/push 返回清晰错误且不改工作树', async () => {
    const repository = await GitRepository.open(repo);
    await expect(repository.pull()).rejects.toThrow(/upstream/i);
    await expect(repository.push()).rejects.toThrow(/upstream/i);
    expect((await repository.status()).head).toBeNull();
  });

  it('远端操作使用已跟踪分支且 pull 拒绝分叉历史', async () => {
    const remote = join(root, 'remote.git');
    git(root, 'init', '--bare', '-q', '-b', 'main', remote);
    writeFileSync(join(repo, 'a.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-qu', 'origin', 'main');
    const other = join(root, 'other');
    git(root, 'clone', '-q', remote, other);
    git(other, 'config', 'user.name', 'test');
    git(other, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(other, 'remote.txt'), 'remote');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'remote');
    git(other, 'push', '-q');
    const repository = await GitRepository.open(repo);
    await repository.fetch();
    expect(await repository.status()).toMatchObject({
      upstream: 'origin/main',
      ahead: 0,
      behind: 1,
    });
    await repository.pull();
    expect(readFileSync(join(repo, 'remote.txt'), 'utf8')).toBe('remote');
    writeFileSync(join(repo, 'local.txt'), 'local');
    await repository.stage();
    await repository.commit('local');
    await repository.push();
    git(other, 'pull', '--ff-only', '-q');
    writeFileSync(join(other, 'diverge.txt'), 'remote divergence');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'diverge remote');
    git(other, 'push', '-q');
    writeFileSync(join(repo, 'local.txt'), 'diverge local');
    await repository.stage();
    await repository.commit('diverge local');
    const before = git(repo, 'rev-parse', 'HEAD');
    await expect(repository.pull()).rejects.toThrow();
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
  }, 30_000);
});
