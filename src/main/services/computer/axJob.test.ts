import { describe, expect, it } from 'vitest';
import type { AxJobBridge } from './axJob';
import { axPressFallbackMessage, dispatchAxJob, isAxPressUnsupported } from './axJob';

function fakeBridge(overrides: Partial<AxJobBridge> = {}): AxJobBridge {
  return {
    snapshot: async () => [{ ref: 'ax1', role: 'AXRow', title: 'CodeSigningHelper 43326' }],
    query: async () => [],
    elementAt: async () => null,
    focused: async () => null,
    node: async (handle) => ({ ref: handle, role: 'AXRow', title: 'CodeSigningHelper 43326' }),
    attributes: async () => [['role', 'AXRow']],
    children: async () => [],
    perform: async () => {
      throw new Error('ax1 expired; re-run ax()/find()');
    },
    setValue: async () => {},
    focus: async () => {},
    ...overrides,
  };
}

describe('dispatchAxJob', () => {
  it('perform 走 snapshot 同一套 handle，不会当成 focused', async () => {
    const seen: string[] = [];
    const ax = fakeBridge({
      perform: async (handle, action) => {
        seen.push(`${handle}:${action}`);
      },
    });
    await dispatchAxJob(ax, { op: 'snapshot', pid: 1, maxDepth: 1 });
    await dispatchAxJob(ax, { op: 'perform', handle: 'ax1', action: 'press' });
    expect(seen).toEqual(['ax1:press']);
  });

  it('未知 handle 的 expired 原样抛出', async () => {
    await expect(
      dispatchAxJob(fakeBridge(), { op: 'perform', handle: 'ax9', action: 'press' })
    ).rejects.toThrow(/expired/);
  });

  it('subtree 交给桥；桥不支持时报不支持', async () => {
    const ax = fakeBridge({
      subtree: async (handle, depth) => [{ ref: handle, role: `d${depth}` }],
    });
    await expect(dispatchAxJob(ax, { op: 'subtree', handle: 'ax1', maxDepth: 3 })).resolves.toEqual(
      [{ ref: 'ax1', role: 'd3' }]
    );
    await expect(
      dispatchAxJob(fakeBridge(), { op: 'subtree', handle: 'ax1', maxDepth: 3 })
    ).rejects.toThrow(/not supported/);
  });

  it('未知 handle 的 expired 原样抛出（perform）', async () => {
    await expect(
      dispatchAxJob(fakeBridge(), { op: 'perform', handle: 'ax9', action: 'press' })
    ).rejects.toThrow(/expired/);
  });
});

describe('isAxPressUnsupported', () => {
  it('AXRow 的 -25206 可以退回坐标点击', () => {
    expect(isAxPressUnsupported(new Error('AX action press failed (-25206)'))).toBe(true);
    expect(isAxPressUnsupported(new Error('ax1 expired; re-run ax()/find()'))).toBe(false);
    expect(axPressFallbackMessage('AXRow', 'e12')).toMatch(/-25206/);
    expect(axPressFallbackMessage('AXRow', 'e12')).toMatch(/no clickable bounds/);
  });
});
