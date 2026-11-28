import { IPC_CHANNELS } from '@shared/types/ipc';
import { describe, expect, it, vi } from 'vitest';
import { encodeRemoteValue } from '../../packages/pair/src/remote';

const invoke = vi.fn(async (_channel: string, _payload: string) => 'true');
const frameHandlers = new Map<string, (payload: string) => void>();
vi.stubGlobal('location', { pathname: '/index.html' });
vi.stubGlobal('addEventListener', vi.fn());
vi.stubGlobal('window', {
  parent: {
    Map,
    __ensoRemote: {
      platform: 'darwin',
      attach: () => ({
        invoke,
        send: vi.fn(),
        on: (channel: string, handler: (payload: string) => void) => {
          frameHandlers.set(channel, handler);
          return () => frameHandlers.delete(channel);
        },
        close: vi.fn(),
      }),
    },
  },
});

const push = (channel: string, args: unknown[]) =>
  frameHandlers.get(channel)?.(JSON.stringify(encodeRemoteValue(args)));

describe('electronShim 设置写入', () => {
  it('会话写回把确认号带给宿主', async () => {
    const { ipcRenderer } = await import('./electronShim');
    const value = { state: { conversations: {}, order: [] } };
    await ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WRITE_KEY, 'enso-conversations', value, 7);
    const [channel, payload] = invoke.mock.calls.at(-1) ?? [];
    expect(channel).toBe(IPC_CHANNELS.SETTINGS_WRITE_KEY);
    const args = JSON.parse(payload ?? '[]') as unknown[];
    expect(args[0]).toBe('enso-conversations');
    expect(args[2]).toBe(7);
  });

  it('高频大包读取走内容 hash 缓存', async () => {
    const { ipcRenderer } = await import('./electronShim');
    const channels = [
      IPC_CHANNELS.WORKTREE_LIST,
      IPC_CHANNELS.WORKTREE_STATUSES,
      IPC_CHANNELS.EXTENSION_PLUGINS_LIST,
      IPC_CHANNELS.SECRETARY_GET_STATE,
    ] as const;
    for (const ch of channels) {
      invoke.mockResolvedValueOnce(
        JSON.stringify({ __ensoCached: { h: `h-${ch}`, v: [{ id: ch }] } })
      );
      expect(await ipcRenderer.invoke(ch)).toEqual([{ id: ch }]);
      invoke.mockResolvedValueOnce(JSON.stringify({ __ensoCached: { h: `h-${ch}`, same: 1 } }));
      expect(await ipcRenderer.invoke(ch)).toEqual([{ id: ch }]);
      const [, secondPayload] = invoke.mock.calls.at(-1) ?? [];
      expect(JSON.parse(secondPayload ?? '[]')).toEqual([{ __ensoIfNone: `h-${ch}` }]);
    }
  });

  it('CONVERSATIONS_READ 展开压缩包并在缓存 same 命中及写回基线处保持一致', async () => {
    const { ipcRenderer } = await import('./electronShim');
    const { compactRemoteWireResult } = await import('@shared/remoteWireCompact');
    const rawConv = {
      seq: 1,
      value: {
        version: 4,
        state: {
          activeId: 'c1',
          order: ['c1'],
          conversations: {
            c1: {
              id: 'c1',
              projectId: 'p1',
              title: 'Original',
              createdAt: 1,
              messages: [],
              commands: [],
              customEntries: [],
              dispatchMainEvents: {},
              lastSeq: 0,
              spawning: false,
              started: false,
              status: 'idle',
              toolOutputs: {},
              toolStartedAt: {},
              toolDeadlineAt: {},
              toolEnded: {},
              toolTodos: {},
              pendingApprovals: [],
              pendingAsks: [],
              backgroundTasks: [],
              subagents: [],
            },
          },
        },
      },
    };
    const compacted = compactRemoteWireResult(IPC_CHANNELS.CONVERSATIONS_READ, rawConv);
    invoke.mockResolvedValueOnce(JSON.stringify({ __ensoCached: { h: 'h-conv-1', v: compacted } }));
    expect(await ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_READ)).toEqual(rawConv);

    invoke.mockResolvedValueOnce(JSON.stringify({ __ensoCached: { h: 'h-conv-1', same: 1 } }));
    expect(await ipcRenderer.invoke(IPC_CHANNELS.CONVERSATIONS_READ)).toEqual(rawConv);

    // 写回修改单字段时走增量（ops）而非整包覆盖
    invoke.mockResolvedValueOnce('true');
    const nextValue = structuredClone(rawConv.value);
    (nextValue.state.conversations.c1 as Record<string, unknown>).title = 'Updated';
    await ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_WRITE_KEY, 'enso-conversations', nextValue, 1);
    const [, writePayload] = invoke.mock.calls.at(-1) ?? [];
    const writeArgs = JSON.parse(writePayload ?? '[]') as unknown[];
    expect(writeArgs[1]).toMatchObject({
      __ensoWrite: { ops: expect.any(Array) },
    });
  });
});

describe('electronShim 秘书状态', () => {
  it('宿主只发重读通知：shim 走缓存重读，同一秘书的连发合并后再分发整份状态', async () => {
    const { ipcRenderer } = await import('./electronShim');
    const received: unknown[] = [];
    const listener = (_event: unknown, state: unknown) => received.push(state);
    ipcRenderer.on(IPC_CHANNELS.SECRETARY_STATE_CHANGED, listener);
    invoke.mockClear();
    let release: (value: string) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));
    invoke.mockResolvedValueOnce(
      JSON.stringify({ __ensoCached: { h: 'h2', v: { secretaryId: 's1', n: 2 } } })
    );
    for (let i = 0; i < 3; i++)
      push(IPC_CHANNELS.SECRETARY_STATE_CHANGED, [{ __ensoReread: 's1' }]);
    release(JSON.stringify({ __ensoCached: { h: 'h1', v: { secretaryId: 's1', n: 1 } } }));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received).toEqual([
      { secretaryId: 's1', n: 1 },
      { secretaryId: 's1', n: 2 },
    ]);
    expect(invoke.mock.calls.map(([ch, payload]) => [ch, JSON.parse(payload)[0]])).toEqual([
      [IPC_CHANNELS.SECRETARY_GET_STATE, 's1'],
      [IPC_CHANNELS.SECRETARY_GET_STATE, 's1'],
    ]);
    ipcRenderer.removeListener(IPC_CHANNELS.SECRETARY_STATE_CHANGED, listener);
  });

  it('整份状态照旧直接分发', async () => {
    const { ipcRenderer } = await import('./electronShim');
    const received: unknown[] = [];
    const listener = (_event: unknown, state: unknown) => received.push(state);
    ipcRenderer.on(IPC_CHANNELS.SECRETARY_STATE_CHANGED, listener);
    push(IPC_CHANNELS.SECRETARY_STATE_CHANGED, [{ secretaryId: 's1', enabled: true }]);
    expect(received).toEqual([{ secretaryId: 's1', enabled: true }]);
    ipcRenderer.removeListener(IPC_CHANNELS.SECRETARY_STATE_CHANGED, listener);
  });

  it('同时发出的动态流与日程读取合并成一次', async () => {
    const { ipcRenderer } = await import('./electronShim');
    for (const ch of [IPC_CHANNELS.SECRETARY_FEED, IPC_CHANNELS.SECRETARY_SCHEDULES_LIST]) {
      invoke.mockClear();
      invoke.mockResolvedValueOnce(JSON.stringify({ ok: true }));
      const results = await Promise.all([
        ipcRenderer.invoke(ch, { limit: 20 }, 's1'),
        ipcRenderer.invoke(ch, { limit: 20 }, 's1'),
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(invoke).toHaveBeenCalledTimes(1);
    }
  });

  it('命中 rpc-hello prefetch 时免发一次 frame.invoke；返回 null 时回落常规 invoke', async () => {
    const { ipcRenderer, remoteBridge } = await import('./electronShim');
    invoke.mockClear();
    const prefetched = { __ensoCached: { h: 'h-pref', v: { theme: 'dark' } } };
    remoteBridge.prefetch = {
      take: vi.fn().mockResolvedValueOnce(prefetched).mockResolvedValueOnce(null),
    };
    const res1 = await ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_READ);
    expect(res1).toEqual({ theme: 'dark' });
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce(
      JSON.stringify({ __ensoCached: { h: 'h-model', v: { models: [] } } })
    );
    const res2 = await ipcRenderer.invoke(IPC_CHANNELS.MODEL_DIRECTORY_GET);
    expect(res2).toEqual({ models: [] });
    expect(invoke).toHaveBeenCalledTimes(1);
    remoteBridge.prefetch = undefined;
  });
});
