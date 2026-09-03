import { describe, expect, it, vi } from 'vitest';
import {
  branchSessionAtLeaf,
  branchSessionFromPersistedFile,
  resolveForkLeafId,
} from './sessionFork';

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

describe('branchSessionFromPersistedFile', () => {
  it('在副本上分叉，不改源 sessionFile', async () => {
    const copyCreate = vi.fn(() => '/tmp/new.jsonl');
    expect(
      branchSessionFromPersistedFile(
        {
          getSessionFile: () => '/tmp/source.jsonl',
          getEntry: (id) => (id === 'e1' ? { id } : undefined),
        },
        'e1',
        () => ({
          getEntry: (id) => (id === 'e1' ? { id } : undefined),
          createBranchedSession: copyCreate,
        })
      )
    ).toEqual({ ok: true, sessionFile: '/tmp/new.jsonl' });
    expect(copyCreate).toHaveBeenCalledWith('e1');
  });
});

type ForkEntry = { id: string; type: string; message?: { role: string } };

function branch(entries: ForkEntry[]) {
  return entries;
}

describe('resolveForkLeafId', () => {
  const tree: ForkEntry[] = [
    { id: 'u1', type: 'message', message: { role: 'user' } },
    { id: 'a1', type: 'message', message: { role: 'assistant' } },
    { id: 'u2', type: 'message', message: { role: 'user' } },
    { id: 'a2', type: 'message', message: { role: 'assistant' } },
    { id: 'u3', type: 'message', message: { role: 'user' } },
  ];

  it('user 锚点扩到该轮最后一条，未回复则停在该 user', () => {
    expect(resolveForkLeafId(branch(tree), { userIndexFromEnd: 2 })).toBe('a1');
    expect(resolveForkLeafId(branch(tree), { userIndexFromEnd: 1 })).toBe('a2');
    expect(resolveForkLeafId(branch(tree), { userIndexFromEnd: 0 })).toBe('u3');
  });

  it('指定 entry 时同样扩到该轮末，compaction 不扩', () => {
    expect(resolveForkLeafId(branch(tree), { entryId: 'u1' })).toBe('a1');
    expect(resolveForkLeafId(branch(tree), { entryId: 'a2' })).toBe('a2');
    const compacted: ForkEntry[] = [
      { id: 'c1', type: 'compaction' },
      { id: 'u1', type: 'message', message: { role: 'user' } },
    ];
    expect(resolveForkLeafId(branch(compacted), { entryId: 'c1' })).toBe('c1');
  });
});
