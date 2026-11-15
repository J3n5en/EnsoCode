import { describe, expect, it } from 'vitest';
import {
  type GitResult,
  parsePorcelainZ,
  parseWorktrees,
  REPO_STATUS_FILE_MAX,
  type RepoStatusDeps,
  readRepoStatus,
  resolveRepoScope,
  safeCommit,
  safeRef,
} from './repoStatus';

const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: '' });
const fail = (code = 128): GitResult => ({ code, stdout: '', stderr: 'fatal' });

/** 用一张 "目录 → 仓库" 表模拟 git：key 是绝对路径，值是它所属仓库的 common dir */
function makeDeps(options: {
  repos: Record<string, { common: string; top?: string }>;
  files?: string[];
  extra?: (cwd: string, args: readonly string[]) => GitResult | undefined;
}): RepoStatusDeps {
  const repos = options.repos;
  return {
    async realpath(target) {
      return target in repos ? target : null;
    },
    exists: (target) => (options.files ?? []).includes(target),
    async git(cwd, args) {
      const repo = repos[cwd];
      if (!repo) return fail();
      const injected = options.extra?.(cwd, args);
      if (injected) return injected;
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok(repo.top ?? cwd);
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return ok(repo.common);
      return fail();
    },
  };
}

describe('resolveRepoScope', () => {
  const candidates = [{ projectId: 'p1', path: '/repo/alpha' }];

  it('可见项目的检出目录直接放行', async () => {
    const deps = makeDeps({ repos: { '/repo/alpha': { common: '/repo/alpha/.git' } } });
    expect(await resolveRepoScope(deps, candidates, '/repo/alpha')).toEqual({
      projectId: 'p1',
      root: '/repo/alpha',
    });
  });

  it('同仓 worktree 根按 git common dir 放行', async () => {
    const deps = makeDeps({
      repos: {
        '/repo/alpha': { common: '/repo/alpha/.git' },
        '/wt/alpha-1': { common: '/repo/alpha/.git' },
      },
    });
    expect(await resolveRepoScope(deps, candidates, '/wt/alpha-1')).toEqual({
      projectId: 'p1',
      root: '/wt/alpha-1',
    });
  });

  it('别的仓库、项目子目录、不存在的路径一律拒绝', async () => {
    const deps = makeDeps({
      repos: {
        '/repo/alpha': { common: '/repo/alpha/.git' },
        '/repo/beta': { common: '/repo/beta/.git' },
        '/repo/alpha/src': { common: '/repo/alpha/.git', top: '/repo/alpha' },
      },
    });
    expect(await resolveRepoScope(deps, candidates, '/repo/beta')).toBeNull();
    expect(await resolveRepoScope(deps, candidates, '/repo/alpha/src')).toBeNull();
    expect(await resolveRepoScope(deps, candidates, '/etc')).toBeNull();
    expect(await resolveRepoScope(deps, candidates, '  ')).toBeNull();
  });

  it('没有可见项目时任何路径都拒绝', async () => {
    const deps = makeDeps({ repos: { '/repo/alpha': { common: '/repo/alpha/.git' } } });
    expect(await resolveRepoScope(deps, [], '/repo/alpha')).toBeNull();
  });
});

describe('safeRef / safeCommit', () => {
  it('只放行明确字符集，拒绝选项注入与范围写法', () => {
    expect(safeRef('main')).toBe('main');
    expect(safeRef('origin/feat/x-1')).toBe('origin/feat/x-1');
    expect(safeRef('--upload-pack=rm -rf')).toBeNull();
    expect(safeRef('main..other')).toBeNull();
    expect(safeRef('main;rm -rf /')).toBeNull();
    expect(safeCommit('9c23a8058')).toBe('9c23a8058');
    expect(safeCommit('9C23A805')).toBe('9c23a805');
    expect(safeCommit('HEAD')).toBeNull();
    expect(safeCommit('abc')).toBeNull();
  });
});

describe('parsePorcelainZ', () => {
  it('重命名的原路径不算独立条目，总数与列表分开', () => {
    const raw = [' M src/a.ts', '?? new.md', 'R  src/c.ts', 'src/old.ts', ''].join('\0');
    expect(parsePorcelainZ(raw)).toEqual({
      total: 3,
      files: [
        { status: ' M', path: 'src/a.ts' },
        { status: '??', path: 'new.md' },
        { status: 'R ', path: 'src/c.ts' },
      ],
    });
  });

  it('超过上限时只列前 N 条，总数照实给', () => {
    const entries = Array.from({ length: REPO_STATUS_FILE_MAX + 5 }, (_, index) => `?? f${index}`);
    const parsed = parsePorcelainZ(`${entries.join('\0')}\0`);
    expect(parsed.total).toBe(REPO_STATUS_FILE_MAX + 5);
    expect(parsed.files).toHaveLength(REPO_STATUS_FILE_MAX);
    expect(parsed.files[0]).toEqual({ status: '??', path: 'f0' });
  });
});

describe('parseWorktrees', () => {
  it('按空行分段解析路径、分支与 HEAD', () => {
    const raw = [
      'worktree /repo/alpha',
      'HEAD 9c23a8058',
      'branch refs/heads/feat/x',
      '',
      'worktree /wt/alpha-1',
      'HEAD 1234567',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktrees(raw)).toEqual([
      { path: '/repo/alpha', branch: 'feat/x', head: '9c23a8058' },
      { path: '/wt/alpha-1', branch: null, head: '1234567' },
    ]);
  });
});

describe('readRepoStatus', () => {
  const base = (extra: (cwd: string, args: readonly string[]) => GitResult | undefined) =>
    makeDeps({
      repos: { '/repo/alpha': { common: '/repo/alpha/.git' } },
      files: ['/repo/alpha/.git/rebase-merge'],
      extra,
    });

  const standard = (_cwd: string, args: readonly string[]): GitResult | undefined => {
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('feat/x\n');
    if (args[0] === 'log' && args[1] === '-1') return ok('9c23a80\u001f合并秘书分支\n');
    if (args[0] === 'log') return ok('9c23a80\u001fJ\u001f1700000000\u001f合并秘书分支\n');
    if (args[0] === 'status') return ok(' M src/a.ts\0');
    if (args[0] === 'rev-parse' && args[1] === '--verify') return fail(1);
    if (args[0] === 'rev-parse' && args[1] === '--git-path')
      return ok(args[2] === 'rebase-merge' ? '.git/rebase-merge' : '.git/rebase-apply');
    if (args[0] === 'worktree')
      return ok('worktree /repo/alpha\nHEAD 9c23a80\nbranch refs/heads/feat/x\n');
    return undefined;
  };

  it('给出分支、HEAD、提交、改动、进行中的 rebase 与 worktree 列表', async () => {
    const outcome = await readRepoStatus(base(standard), { root: '/repo/alpha', limit: 5 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.snapshot).toMatchObject({
      root: '/repo/alpha',
      branch: 'feat/x',
      head: { sha: '9c23a80', subject: '合并秘书分支' },
      commits: [{ sha: '9c23a80', author: 'J', at: 1_700_000_000_000, subject: '合并秘书分支' }],
      changes: { total: 1, files: [{ status: ' M', path: 'src/a.ts' }] },
      operation: { merge: false, rebase: true },
      worktrees: [{ path: '/repo/alpha', branch: 'feat/x', head: '9c23a80' }],
    });
  });

  it('contains 按退出码判断，命中与不命中都给出结论', async () => {
    const hit = await readRepoStatus(
      base((cwd, args) => (args[0] === 'merge-base' ? ok('') : standard(cwd, args))),
      { root: '/repo/alpha', limit: 5, contains: '9c23a8058' }
    );
    expect(hit.ok && hit.snapshot.contains).toEqual({ sha: '9c23a8058', inHead: true });

    const miss = await readRepoStatus(
      base((cwd, args) => (args[0] === 'merge-base' ? fail(1) : standard(cwd, args))),
      { root: '/repo/alpha', limit: 5, contains: 'deadbeef' }
    );
    expect(miss.ok && miss.snapshot.contains).toEqual({ sha: 'deadbeef', inHead: false });
  });

  it('base 给出领先与落后数', async () => {
    const outcome = await readRepoStatus(
      base((cwd, args) => (args[0] === 'rev-list' ? ok('2\t3\n') : standard(cwd, args))),
      { root: '/repo/alpha', limit: 5, base: 'main' }
    );
    expect(outcome.ok && outcome.snapshot.base).toEqual({ ref: 'main', ahead: 3, behind: 2 });
  });

  it('非法 base 与 contains 直接拒绝，不跑 git', async () => {
    let calls = 0;
    const deps = base((cwd, args) => {
      calls += 1;
      return standard(cwd, args);
    });
    expect(await readRepoStatus(deps, { root: '/repo/alpha', limit: 5, base: '--x' })).toEqual({
      ok: false,
      code: 'invalid-base',
    });
    expect(await readRepoStatus(deps, { root: '/repo/alpha', limit: 5, contains: 'HEAD' })).toEqual(
      {
        ok: false,
        code: 'invalid-contains',
      }
    );
    expect(calls).toBe(0);
  });

  it('不是仓库时返回 not-a-repo', async () => {
    const deps = makeDeps({ repos: {} });
    expect(await readRepoStatus(deps, { root: '/nope', limit: 5 })).toEqual({
      ok: false,
      code: 'not-a-repo',
    });
  });

  it('limit 收口在 1..20', async () => {
    const seen: string[][] = [];
    const deps = base((cwd, args) => {
      if (args[0] === 'log' && args[1] !== '-1') seen.push([...args]);
      return standard(cwd, args);
    });
    await readRepoStatus(deps, { root: '/repo/alpha', limit: 999 });
    await readRepoStatus(deps, { root: '/repo/alpha', limit: 0 });
    expect(seen[0]).toContain('-n20');
    expect(seen[1]).toContain('-n1');
  });
});
