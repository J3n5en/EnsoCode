import type { GoalResult } from '@shared/secretary/goalResult';
import { describe, expect, it } from 'vitest';
import { type GoalResultVerifyDeps, verifyGoalResult } from './goalResultVerify';

const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function deps(overrides: Partial<GoalResultVerifyDeps> = {}): GoalResultVerifyDeps {
  return {
    cwd: '/repo',
    git: async () => ({ code: 1, stdout: '' }),
    gh: async () => null,
    readHead: async () => null,
    ...overrides,
  };
}

const byKind = async (result: GoalResult, ports: GoalResultVerifyDeps) => {
  const checks = await verifyGoalResult(result, ports);
  return Object.fromEntries(checks.map((check) => [check.kind, check]));
};

describe('verifyGoalResult', () => {
  it('PR 状态、squash 与远端分支对得上就是已核验', async () => {
    const calls: string[][] = [];
    const checks = await byKind(
      {
        prs: [
          {
            repo: 'owner/x',
            number: 123,
            state: 'merged',
            squashSha: 'abc1234',
            remoteBranchDeleted: true,
          },
        ],
      },
      deps({
        gh: async (args) => {
          calls.push([...args]);
          if (args[0] === 'pr') {
            return {
              code: 0,
              stdout: JSON.stringify({
                state: 'MERGED',
                mergeCommit: { oid: 'abc1234fff' },
                headRefName: 'feat/x',
                isCrossRepository: false,
              }),
            };
          }
          return { code: 404, stdout: '' };
        },
      })
    );
    expect(checks['pr-state']).toMatchObject({ ref: 'owner/x#123', status: 'verified' });
    expect(checks['pr-squash']).toMatchObject({ status: 'verified' });
    expect(checks['pr-branch']).toMatchObject({ status: 'verified' });
    expect(calls.some((args) => args.join(' ').includes('repos/owner/x/branches/feat%2Fx'))).toBe(
      true
    );
  });

  it('PR 状态不符是不一致，gh 缺失是未能核验', async () => {
    const mismatch = await byKind(
      { prs: [{ repo: 'owner/x', number: 1, state: 'merged' }] },
      deps({
        gh: async () => ({ code: 0, stdout: JSON.stringify({ state: 'OPEN' }) }),
      })
    );
    expect(mismatch['pr-state']).toMatchObject({ status: 'mismatch', detail: 'open' });

    const missing = await byKind(
      { prs: [{ repo: 'owner/x', number: 1, state: 'merged', squashSha: 'abc1234' }] },
      deps()
    );
    expect(missing['pr-state']?.status).toBe('unverifiable');
    expect(missing['pr-squash']?.status).toBe('unverifiable');
  });

  it('提交在 main 上是已核验，分叉是不一致，两边都查不了是未能核验', async () => {
    const onMain = await byKind(
      { commits: ['abc1234'] },
      deps({
        git: async (_cwd, args) =>
          args[0] === 'merge-base' && args.at(-1) === 'refs/remotes/origin/main'
            ? { code: 0, stdout: '' }
            : { code: 1, stdout: '' },
      })
    );
    expect(onMain.commit).toMatchObject({ ref: 'abc1234', status: 'verified' });

    const diverged = await byKind(
      { commits: ['abc1234'] },
      deps({
        git: async (_cwd, args) =>
          args[0] === 'remote'
            ? { code: 0, stdout: 'git@github.com:owner/x.git\n' }
            : { code: 1, stdout: '' },
        gh: async (args) =>
          args[0] === 'api' ? { code: 0, stdout: 'diverged\n' } : { code: 1, stdout: '' },
      })
    );
    expect(diverged.commit).toMatchObject({ status: 'mismatch', detail: 'diverged' });

    const unknown = await byKind({ commits: ['abc1234'] }, deps());
    expect(unknown.commit?.status).toBe('unverifiable');
  });

  it('截图认文件头：图片已核验，不存在或不像图片是不一致', async () => {
    const image = await byKind(
      { screenshots: [{ path: '/tmp/a.png' }] },
      deps({ readHead: async () => png })
    );
    expect(image.screenshot).toMatchObject({ ref: '/tmp/a.png', status: 'verified' });

    const missing = await byKind(
      { screenshots: [{ path: '/tmp/gone.png' }] },
      deps({ readHead: async () => null })
    );
    expect(missing.screenshot).toMatchObject({ status: 'mismatch' });

    const text = await byKind(
      { screenshots: [{ path: '/tmp/a.txt' }] },
      deps({ readHead: async () => Uint8Array.of(0x68, 0x69) })
    );
    expect(text.screenshot).toMatchObject({ status: 'mismatch' });
  });

  it('CI 结论和声称不一致时标不一致，缺省声称 success', async () => {
    const checks = await byKind(
      { checks: { ci: { runId: 99, repo: 'owner/x' } } },
      deps({
        gh: async () => ({ code: 0, stdout: JSON.stringify({ conclusion: 'failure' }) }),
      })
    );
    expect(checks.ci).toMatchObject({ ref: '99', status: 'mismatch', detail: 'failure' });
  });
});
