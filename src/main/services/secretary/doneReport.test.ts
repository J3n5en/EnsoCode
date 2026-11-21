import type { SecretaryStoredReport } from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import { buildDoneReport, type DoneReportDeps } from './doneReport';

const REPORT: SecretaryStoredReport = {
  at: 1,
  text: '完成，PR https://github.com/o/r/pull/7 ，commit: abcdef1',
  images: [],
};

function deps(over: Partial<DoneReportDeps> = {}): DoneReportDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    report: () => REPORT,
    workspace: () => ({ cwd: '/repo' }),
    git: async (_cwd, args) => {
      calls.push(['git', ...args]);
      return { code: 0, stdout: '3\t1\tsrc/from-git.ts\n', stderr: '' };
    },
    gh: async (args) => {
      calls.push(['gh', ...args]);
      return JSON.stringify({
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        state: 'MERGED',
        mergeCommit: { oid: '1234567890abcdef1234567890abcdef12345678' },
        files: [{ path: 'src/a.ts', additions: 2, deletions: 0 }],
      });
    },
    ...over,
  };
}

describe('buildDoneReport', () => {
  it('有 PR 时用 gh 的号、合并 sha 与文件统计，不再跑 git', async () => {
    const d = deps();
    expect(await buildDoneReport('c1', d)).toEqual({
      report: REPORT,
      pr: {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        state: 'MERGED',
        mergeSha: '1234567890abcdef1234567890abcdef12345678',
      },
      files: [{ path: 'src/a.ts', additions: 2, deletions: 0 }],
    });
    expect(d.calls.some((call) => call[0] === 'git')).toBe(false);
  });

  it('gh 不可用时退回汇报里的提交号跑 git show --numstat', async () => {
    const d = deps({ gh: async () => null });
    const result = await buildDoneReport('c1', d);
    expect(result.pr).toBeUndefined();
    expect(result.files).toEqual([{ path: 'src/from-git.ts', additions: 3, deletions: 1 }]);
    expect(d.calls).toContainEqual(['git', 'show', '--numstat', '--format=', 'abcdef1']);
  });

  it('没有 PR、没有提交号时用 worktree 的起点算改动；什么都拿不到就不给', async () => {
    const plain = { ...REPORT, text: '做完了' };
    const d = deps({
      report: () => plain,
      workspace: () => ({ cwd: '/wt', baseCommit: 'base0001' }),
    });
    expect((await buildDoneReport('c1', d)).files).toHaveLength(1);
    expect(d.calls).toContainEqual(['git', 'diff', '--numstat', 'base0001', 'HEAD']);
    const none = deps({ report: () => plain, workspace: () => null });
    expect(await buildDoneReport('c1', none)).toEqual({ report: plain });
    const failing = deps({
      report: () => plain,
      workspace: () => ({ cwd: '/wt', baseCommit: 'base0001' }),
      git: async () => ({ code: 128, stdout: '', stderr: 'bad' }),
    });
    expect(await buildDoneReport('c1', failing)).toEqual({ report: plain });
  });
});
