import { describe, expect, it, vi } from 'vitest';
import { branchSessionAtLeaf } from './sessionFork';

describe('branchSessionAtLeaf', () => {
  it('锚点无效或未落盘则失败，不宣称成功', () => {
    expect(
      branchSessionAtLeaf(
        {
          createBranchedSession: () => undefined,
          getEntry: () => undefined,
        },
        'missing'
      )
    ).toEqual({ ok: false, error: 'anchor-not-found' });

    expect(
      branchSessionAtLeaf(
        {
          createBranchedSession: () => undefined,
          getEntry: () => ({ id: 'e1' }),
        },
        'e1'
      )
    ).toEqual({ ok: false, error: 'branch-not-persisted' });
  });

  it('成功返回新 jsonl 路径', () => {
    const createBranchedSession = vi.fn(() => '/tmp/new.jsonl');
    expect(
      branchSessionAtLeaf(
        {
          createBranchedSession,
          getEntry: (id) => (id === 'e1' ? { id } : undefined),
        },
        'e1'
      )
    ).toEqual({ ok: true, sessionFile: '/tmp/new.jsonl' });
    expect(createBranchedSession).toHaveBeenCalledWith('e1');
  });
});
