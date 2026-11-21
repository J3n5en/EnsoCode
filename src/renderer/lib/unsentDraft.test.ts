import { describe, expect, it, vi } from 'vitest';

const report = vi.fn();
vi.stubGlobal('window', { electronAPI: { updater: { reportUnsentDraft: report } } });

const { setUnsentDraft } = await import('./unsentDraft');

describe('setUnsentDraft', () => {
  it('任一输入框有草稿就报有，全部清空才报没有；没变化不重复报', () => {
    setUnsentDraft('a', true);
    setUnsentDraft('b', true);
    setUnsentDraft('a', false);
    expect(report.mock.calls).toEqual([[true]]);
    setUnsentDraft('b', false);
    setUnsentDraft('b', false);
    expect(report.mock.calls).toEqual([[true], [false]]);
  });
});
