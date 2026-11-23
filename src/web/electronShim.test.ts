import { IPC_CHANNELS } from '@shared/types/ipc';
import { describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (_channel: string, _payload: string) => 'true');
vi.stubGlobal('location', { pathname: '/index.html' });
vi.stubGlobal('addEventListener', vi.fn());
vi.stubGlobal('window', {
  parent: {
    Map,
    __ensoRemote: {
      platform: 'darwin',
      attach: () => ({ invoke, send: vi.fn(), on: vi.fn(() => () => {}), close: vi.fn() }),
    },
  },
});

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
});
