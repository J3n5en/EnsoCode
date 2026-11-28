import type { HostToPhone, HostToRemote } from '@enso/pair';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));

vi.mock('@platform', () => ({
  app: {
    getAppPath: () => '/tmp/enso-app',
    getVersion: () => '1.0.0',
    getPath: () => '/tmp',
  },
  images: {},
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../../ipc/agent', () => ({
  getSourceAuthorityRegistry: () => null,
}));
vi.mock('../../ipc/settings', () => ({
  readSettings: () => ({}),
  settingsRevision: () => 1,
}));
vi.mock('../localImageProtocol', () => ({
  handleLocalImageRequest: vi.fn(),
}));
vi.mock('../pairSessionHost', () => ({
  isPairHeadless: () => false,
  setPairHeadless: vi.fn(),
}));
vi.mock('../renderers', () => ({
  localMainContents: () => null,
}));
vi.mock('../uiHost', () => ({
  localUi: () => null,
}));
vi.mock('./assets', () => ({
  bundleManifest: async () => null,
  downloadEstimate: async () => 0,
  readRendererAsset: async () => ({ status: 404, mime: 'text/plain', body: new Uint8Array() }),
  rendererBuildId: async () => 'build-1',
}));
vi.mock('./ipcRegistry', () => ({
  installIpcRegistry: vi.fn(),
  registeredHandler: (ch: string) => mocks.handlers.get(ch),
  registeredListeners: () => [],
}));

import { handleRemoteCommand, type RemoteLink } from './index';

describe('remoteRenderer rpc-hello 1-RTT prefetch', () => {
  beforeEach(() => {
    mocks.handlers.clear();
  });

  it('发送带 prefetch 的 rpc-ready 并在后端并行执行允许的只读查询后推送一帧 rpc-prefetch', async () => {
    mocks.handlers.set(IPC_CHANNELS.SETTINGS_READ, async () => ({
      'enso-settings': { state: { theme: 'dark' } },
    }));
    mocks.handlers.set(IPC_CHANNELS.MODEL_DIRECTORY_GET, async () => ({ providers: [] }));
    const windowSpy = vi.fn(async () => 'should-not-run');
    mocks.handlers.set(IPC_CHANNELS.WINDOW_MINIMIZE, windowSpy);

    const sent: HostToPhone[] = [];
    const link: RemoteLink = {
      pairId: 'pair-prefetch',
      gzip: true,
      v2: true,
      send: (frame) => sent.push(frame),
    };

    await handleRemoteCommand(link, {
      type: 'rpc-hello',
      cid: 'cid-1',
      kind: 'main',
      prefetch: [
        { ch: IPC_CHANNELS.SETTINGS_READ, args: [], h: 'nonexistent' },
        { ch: IPC_CHANNELS.MODEL_DIRECTORY_GET, args: [], h: 'nonexistent-2' },
        { ch: IPC_CHANNELS.WINDOW_MINIMIZE, args: [], h: 'bad' },
      ],
    });

    await vi.waitFor(() => {
      expect(sent.some((f) => f.type === 'rpc-prefetch')).toBe(true);
    });

    expect(windowSpy).not.toHaveBeenCalled();
    const ready = sent.find((f) => f.type === 'rpc-ready');
    expect(ready).toMatchObject({
      type: 'rpc-ready',
      cid: 'cid-1',
      ok: true,
      prefetch: true,
    });

    const prefetchFrame = sent.find(
      (f): f is Extract<HostToRemote, { type: 'rpc-prefetch' }> => f.type === 'rpc-prefetch'
    )!;
    expect(prefetchFrame.items).toHaveLength(2);
    expect(prefetchFrame.items.map((i) => i.ch)).toEqual([
      IPC_CHANNELS.SETTINGS_READ,
      IPC_CHANNELS.MODEL_DIRECTORY_GET,
    ]);

    // 携带匹配 hash 再连一次，回 same: 1
    const firstHash = (prefetchFrame.items[0].data as { __ensoCached: { h: string } }).__ensoCached
      .h;
    sent.length = 0;
    await handleRemoteCommand(link, {
      type: 'rpc-hello',
      cid: 'cid-2',
      kind: 'main',
      prefetch: [{ ch: IPC_CHANNELS.SETTINGS_READ, args: [], h: firstHash }],
    });
    await vi.waitFor(() => {
      expect(sent.some((f) => f.type === 'rpc-prefetch')).toBe(true);
    });
    const secondFrame = sent.find(
      (f): f is Extract<HostToRemote, { type: 'rpc-prefetch' }> => f.type === 'rpc-prefetch'
    )!;
    expect(secondFrame.items[0].data).toEqual({
      __ensoCached: { h: firstHash, same: 1 },
    });

    await handleRemoteCommand(link, { type: 'rpc-bye', cid: 'cid-1' });
    await handleRemoteCommand(link, { type: 'rpc-bye', cid: 'cid-2' });
  });
});
