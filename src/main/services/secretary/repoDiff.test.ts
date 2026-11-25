import { describe, expect, it } from 'vitest';
import {
  mergeNumstatAndStatus,
  parseNameStatusZ,
  parseNumstatZ,
  REPO_DIFF_FILE_MAX,
  readRepoDiff,
} from './repoDiff';
import type { GitResult, RepoStatusDeps } from './repoStatus';

const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: '' });
const fail = (code = 128): GitResult => ({ code, stdout: '', stderr: 'fatal' });

function deps(
  overrides: Partial<Record<string, GitResult>> = {},
  repos: Record<string, string> = { '/repo/alpha': '/repo/alpha/.git' }
): { deps: RepoStatusDeps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      async realpath(target) {
        return target in repos ? target : null;
      },
      exists: () => false,
      async git(cwd, args) {
        calls.push(args.join(' '));
        if (!(cwd in repos)) return fail();
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok(cwd);
        if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return ok(repos[cwd] ?? '');
        const key = args.join(' ');
        return overrides[key] ?? fail();
      },
    },
  };
}

describe('parseNumstatZ', () => {
  it('解析增删行数与路径，二进制为 null', () => {
    const raw = ['10\t2\tsrc/a.ts', '-\t-\timg/logo.png', '3\t0\tsrc/b.ts', ''].join('\0');
    expect(parseNumstatZ(raw)).toEqual([
      { added: 10, deleted: 2, path: 'src/a.ts' },
      { added: null, deleted: null, path: 'img/logo.png' },
      { added: 3, deleted: 0, path: 'src/b.ts' },
    ]);
  });

  it('重命名：stats 行路径为空，旧/新路径各占一个 token，归并成新路径一条', () => {
    // git 实测：numstat -z 的 rename 是 "0\t0\t" \0 old \0 new \0
    const raw = ['5\t1\tsrc/a.ts', '0\t0\t', 'src/old.ts', 'src/renamed.ts', ''].join('\0');
    expect(parseNumstatZ(raw)).toEqual([
      { added: 5, deleted: 1, path: 'src/a.ts' },
      { added: 0, deleted: 0, path: 'src/renamed.ts', fromPath: 'src/old.ts' },
    ]);
  });
});

describe('parseNameStatusZ', () => {
  it('普通条目是 `<status>\\t<path>` 一个 token', () => {
    const raw = ['M\tsrc/a.ts', 'A\tsrc/new.ts', 'D\tsrc/gone.ts', ''].join('\0');
    expect(parseNameStatusZ(raw)).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'A', path: 'src/new.ts' },
      { status: 'D', path: 'src/gone.ts' },
    ]);
  });

  it('git 实际格式：rename 状态字母独占一个 token，旧/新路径各跟一个', () => {
    // git 实测：name-status -z 的 rename 是 "R100" \0 old \0 new \0（状态里不带 tab 与路径）
    const raw = ['M\tsrc/a.ts', 'R100', 'src/old.ts', 'src/renamed.ts', ''].join('\0');
    expect(parseNameStatusZ(raw)).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'R', path: 'src/renamed.ts', fromPath: 'src/old.ts' },
    ]);
  });
});

describe('mergeNumstatAndStatus', () => {
  it('按顺序对齐 numstat 与 name-status，二进制标 binary，重命名带原路径', () => {
    const files = mergeNumstatAndStatus(
      [
        { added: 10, deleted: 2, path: 'src/a.ts' },
        { added: null, deleted: null, path: 'img/logo.png' },
        { added: 0, deleted: 5, path: 'src/renamed.ts' },
      ],
      [
        { status: 'M', path: 'src/a.ts' },
        { status: 'M', path: 'img/logo.png' },
        { status: 'R', path: 'src/renamed.ts', fromPath: 'src/old.ts' },
      ]
    );
    expect(files).toEqual([
      { status: 'M', path: 'src/a.ts', added: 10, deleted: 2 },
      { status: 'M', path: 'img/logo.png', added: null, deleted: null, binary: true },
      { status: 'R', path: 'src/renamed.ts', added: 0, deleted: 5, fromPath: 'src/old.ts' },
    ]);
  });
});

describe('readRepoDiff', () => {
  const numstat = '5\t1\tsrc/a.ts\0-\t-\timg/pic.png\0';
  const nameStatus = 'M\tsrc/a.ts\0A\timg/pic.png\0';
  const base = deps({
    'diff --numstat -z origin/main...HEAD': ok(numstat),
    'diff --name-status -z origin/main...HEAD': ok(nameStatus),
  });

  it('默认 base 为 origin/main、ref 为 HEAD，合并两行输出成文件清单', async () => {
    const outcome = await readRepoDiff(base.deps, { root: '/repo/alpha' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.diff).toMatchObject({
      base: 'origin/main',
      ref: 'HEAD',
      mergeBase: true,
      totalFiles: 2,
      truncated: false,
      added: 5,
      deleted: 1,
      binary: 1,
    });
    expect(outcome.diff.files).toEqual([
      { status: 'M', path: 'src/a.ts', added: 5, deleted: 1 },
      { status: 'A', path: 'img/pic.png', added: null, deleted: null, binary: true },
    ]);
  });

  it('总行数统计不含二进制文件', async () => {
    const outcome = await readRepoDiff(base.deps, { root: '/repo/alpha' });
    expect(outcome.ok && outcome.diff.added).toBe(5);
    expect(outcome.ok && outcome.diff.binary).toBe(1);
  });

  it('mergeBase false 用两点 diff，ref 可指定', async () => {
    const { deps: d, calls } = deps({
      'diff --numstat -z origin/main..feat/x': ok(numstat),
      'diff --name-status -z origin/main..feat/x': ok(nameStatus),
    });
    const outcome = await readRepoDiff(d, {
      root: '/repo/alpha',
      ref: 'feat/x',
      mergeBase: false,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.diff).toMatchObject({ ref: 'feat/x', mergeBase: false });
    expect(calls.some((call) => call.includes('origin/main..feat/x'))).toBe(true);
  });

  it('非法 base / ref 在跑 git 前拒绝', async () => {
    const { deps: d, calls } = deps();
    expect(await readRepoDiff(d, { root: '/repo/alpha', base: '--exec=rm' })).toEqual({
      ok: false,
      code: 'invalid-base',
    });
    expect(await readRepoDiff(d, { root: '/repo/alpha', ref: '-q' })).toEqual({
      ok: false,
      code: 'invalid-ref',
    });
    expect(calls).toHaveLength(0);
  });

  it('不是仓库时返回 not-a-repo', async () => {
    const { deps: d } = deps({}, {});
    expect(await readRepoDiff(d, { root: '/nope' })).toEqual({ ok: false, code: 'not-a-repo' });
  });

  it('unknown ref / base 时返回 diff-failed', async () => {
    const { deps: d } = deps();
    expect(await readRepoDiff(d, { root: '/repo/alpha' })).toEqual({
      ok: false,
      code: 'diff-failed',
    });
  });

  it('文件数超过上限时只列前 200 个，总数与统计照实给', async () => {
    const total = REPO_DIFF_FILE_MAX + 30;
    const numRows: string[] = [];
    const statusRows: string[] = [];
    for (let index = 0; index < total; index += 1) {
      numRows.push(`2\t1\tf${index}.ts`);
      statusRows.push(`M\tf${index}.ts`);
    }
    const { deps: d } = deps({
      'diff --numstat -z origin/main...HEAD': ok(`${numRows.join('\0')}\0`),
      'diff --name-status -z origin/main...HEAD': ok(`${statusRows.join('\0')}\0`),
    });
    const outcome = await readRepoDiff(d, { root: '/repo/alpha' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.diff.totalFiles).toBe(total);
    expect(outcome.diff.truncated).toBe(true);
    expect(outcome.diff.files).toHaveLength(REPO_DIFF_FILE_MAX);
    expect(outcome.diff.added).toBe(total * 2);
    expect(outcome.diff.deleted).toBe(total);
  });

  it('diff 命令只读：argv 永远是 diff/rev-parse，不带任何写操作子命令', async () => {
    const { deps: d, calls } = deps({
      'diff --numstat -z origin/main...HEAD': ok(numstat),
      'diff --name-status -z origin/main...HEAD': ok(nameStatus),
    });
    await readRepoDiff(d, { root: '/repo/alpha' });
    for (const call of calls) {
      const subcommand = call.split(' ')[0];
      expect(['diff', 'rev-parse']).toContain(subcommand);
    }
  });

  it('空 diff 给出空清单而不是报错', async () => {
    const { deps: d } = deps({
      'diff --numstat -z origin/main...HEAD': ok(''),
      'diff --name-status -z origin/main...HEAD': ok(''),
    });
    const outcome = await readRepoDiff(d, { root: '/repo/alpha' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.diff).toMatchObject({ totalFiles: 0, files: [], added: 0, deleted: 0 });
  });
});
