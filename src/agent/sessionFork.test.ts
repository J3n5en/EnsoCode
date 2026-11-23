import { PLUGIN_MESSAGE_TYPE } from '@shared/extensionPlugins/protocol';
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

type ForkEntry = { id: string; type: string; customType?: string; message?: { role: string } };

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
    expect(resolveForkLeafId(branch(tree), { turnIndexFromEnd: 2 })).toBe('a1');
    expect(resolveForkLeafId(branch(tree), { turnIndexFromEnd: 1 })).toBe('a2');
    expect(resolveForkLeafId(branch(tree), { turnIndexFromEnd: 0 })).toBe('u3');
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

  it('多次压缩后从早期轮次分叉：止于该轮末条，不带上之后才发生的压缩', () => {
    const history: ForkEntry[] = [
      { id: 'u1', type: 'message', message: { role: 'user' } },
      { id: 'a1', type: 'message', message: { role: 'assistant' } },
      { id: 'c1', type: 'compaction' },
      { id: 'u2', type: 'message', message: { role: 'user' } },
      { id: 'a2', type: 'message', message: { role: 'assistant' } },
      { id: 'c2', type: 'compaction' },
      { id: 'a2-tail', type: 'message', message: { role: 'assistant' } },
      { id: 'c3', type: 'compaction' },
      { id: 'u3', type: 'message', message: { role: 'user' } },
      { id: 'a3', type: 'message', message: { role: 'assistant' } },
    ];
    expect(resolveForkLeafId(branch(history), { entryId: 'u1' })).toBe('a1');
    expect(resolveForkLeafId(branch(history), { turnIndexFromEnd: 2 })).toBe('a1');
    // 压缩切在轮中：该轮后半段仍属本轮，止于后半段末条
    expect(resolveForkLeafId(branch(history), { entryId: 'u2' })).toBe('a2-tail');
    expect(resolveForkLeafId(branch(history), { entryId: 'u3' })).toBe('a3');
    expect(resolveForkLeafId(branch(history), { entryId: 'c1' })).toBe('c1');
  });

  it('插件投递是轮次输入；本轮写入的上下文条目带上，之后才发生的压缩/切模型不带', () => {
    const message = (id: string, role: string): ForkEntry => ({
      id,
      type: 'message',
      message: { role },
    });
    const custom = (id: string, customType: string): ForkEntry => ({
      id,
      type: 'custom_message',
      customType,
    });
    const history: ForkEntry[] = [
      message('u1', 'user'),
      message('a1', 'assistant'),
      { id: 'c1', type: 'compaction' },
      custom('p1', PLUGIN_MESSAGE_TYPE),
      custom('h1', 'enso-branch-context'),
      message('a2', 'assistant'),
      custom('r2', 'output-limit-recovery'),
      { id: 'm2', type: 'model_change' },
      custom('p2', PLUGIN_MESSAGE_TYPE),
      message('u3', 'user'),
      message('a3', 'assistant'),
    ];
    expect(resolveForkLeafId(branch(history), { entryId: 'u1' })).toBe('a1');
    expect(resolveForkLeafId(branch(history), { turnIndexFromEnd: 3 })).toBe('a1');
    expect(resolveForkLeafId(branch(history), { turnIndexFromEnd: 2 })).toBe('r2');
    expect(resolveForkLeafId(branch(history), { turnIndexFromEnd: 1 })).toBe('p2');
    expect(resolveForkLeafId(branch(history), { turnIndexFromEnd: 0 })).toBe('a3');
    expect(resolveForkLeafId(branch(history), { turnIndexFromEnd: 4 })).toBe(undefined);
  });
});
