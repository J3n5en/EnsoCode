import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diffHead, type GitDiffHost, localGitDiffHost } from './gitDiff';

function host(opts: {
  inside?: boolean;
  nameStatus?: string;
  others?: string;
  show?: Record<string, string | null>;
  files?: Record<string, string | null>;
}): GitDiffHost {
  return {
    isDir: () => true,
    async run(args) {
      const key = args.join(' ');
      if (key.startsWith('rev-parse --is-inside-work-tree')) {
        return opts.inside === false
          ? { code: 128, stdout: '', stderr: 'not a git repo' }
          : { code: 0, stdout: 'true\n', stderr: '' };
      }
      if (key.startsWith('diff HEAD --name-status')) {
        return { code: 0, stdout: opts.nameStatus ?? '', stderr: '' };
      }
      if (key.startsWith('ls-files --others')) {
        return { code: 0, stdout: opts.others ?? '', stderr: '' };
      }
      if (args[0] === 'show' && args[1]?.startsWith('HEAD:./')) {
        const path = args[1].slice('HEAD:./'.length);
        const text = opts.show?.[path];
        return text == null
          ? { code: 128, stdout: '', stderr: 'missing' }
          : { code: 0, stdout: text, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
    async readFile(absPath) {
      const rel = absPath.replace(/^\/repo\//, '');
      return opts.files?.[rel] ?? null;
    },
  };
}

describe('diffHead', () => {
  it('非仓库返回 not-repo', async () => {
    const result = await diffHead('/repo', host({ inside: false }));
    expect(result).toEqual({ ok: false, error: 'not-repo' });
  });

  it('含已暂存 modified 与 untracked', async () => {
    const result = await diffHead(
      '/repo',
      host({
        nameStatus: 'M\0src/a.ts\0',
        others: 'new.ts\0',
        show: { 'src/a.ts': 'old a' },
        files: { 'src/a.ts': 'new a', 'new.ts': 'fresh' },
      })
    );
    expect(result).toEqual({
      ok: true,
      files: [
        { path: 'src/a.ts', status: 'modified', oldText: 'old a', newText: 'new a' },
        { path: 'new.ts', status: 'untracked', oldText: '', newText: 'fresh' },
      ],
    });
  });

  it('deleted 只有 old', async () => {
    const result = await diffHead(
      '/repo',
      host({
        nameStatus: 'D\0gone.ts\0',
        show: { 'gone.ts': 'bye' },
        files: {},
      })
    );
    expect(result).toEqual({
      ok: true,
      files: [{ path: 'gone.ts', status: 'deleted', oldText: 'bye', newText: '' }],
    });
  });

  it('读不到内容（过大/二进制）则跳过', async () => {
    const result = await diffHead(
      '/repo',
      host({
        nameStatus: 'M\0bin.dat\0',
        show: { 'bin.dat': 'xxx' },
        files: { 'bin.dat': null },
      })
    );
    expect(result).toEqual({ ok: true, files: [] });
  });
});

describe('diffHead 真实仓库', () => {
  let tmp: string;
  let repo: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'enso-git-diff-')));
    // 隔离开发机的全局 / 系统 git 配置（如 diff.relative 会改变输出路径），被测代码的子进程同样继承
    fs.mkdirSync(path.join(tmp, 'home'));
    fs.writeFileSync(path.join(tmp, 'gitconfig'), '');
    vi.stubEnv('HOME', path.join(tmp, 'home'));
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(tmp, 'gitconfig'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    repo = path.join(tmp, 'repo');
    git(tmp, 'init', '-q', '-b', 'main', repo);
    git(repo, 'config', 'core.autocrlf', 'false');
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'user.email', 'test@example.com');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // 审计实测：diff HEAD 输出相对仓库根、ls-files 输出相对 cwd，统一按 cwd 拼路径后
  // 子目录里的 modified/added 全部丢失，deleted 带着根相对路径并混入子目录之外的删除
  it('项目是仓库子目录时，只列出子目录内的改动且路径相对项目目录', async () => {
    const pkg = path.join(repo, 'pkg');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'a.txt'), 'old a\n');
    fs.writeFileSync(path.join(pkg, 'gone.txt'), 'bye\n');
    fs.writeFileSync(path.join(repo, 'outside.txt'), 'root\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    fs.writeFileSync(path.join(pkg, 'a.txt'), 'new a\n');
    fs.writeFileSync(path.join(pkg, 'new.txt'), 'fresh\n');
    git(repo, 'add', 'pkg/new.txt');
    fs.rmSync(path.join(pkg, 'gone.txt'));
    fs.rmSync(path.join(repo, 'outside.txt'));
    fs.writeFileSync(path.join(pkg, 'u.txt'), 'u\n');

    expect(await diffHead(pkg, localGitDiffHost())).toEqual({
      ok: true,
      files: [
        { path: 'a.txt', status: 'modified', oldText: 'old a\n', newText: 'new a\n' },
        { path: 'gone.txt', status: 'deleted', oldText: 'bye\n', newText: '' },
        { path: 'new.txt', status: 'added', oldText: '', newText: 'fresh\n' },
        { path: 'u.txt', status: 'untracked', oldText: '', newText: 'u\n' },
      ],
    });
  });

  // 背景：恶意仓库可以放一个指向工作区外文件的符号链接，跟随读取会把外部文件内容展示进改动面板；
  // gitVersionControl 的 workingText 已用 lstat 拒绝符号链接，这里保持一致
  it('指向工作区外文件的符号链接不读取目标内容', async () => {
    fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    const secret = path.join(tmp, 'secret.txt');
    fs.writeFileSync(secret, 'top secret\n');
    fs.symlinkSync(secret, path.join(repo, 'leak.txt'));

    expect(await diffHead(repo, localGitDiffHost())).toEqual({ ok: true, files: [] });
  });
});
