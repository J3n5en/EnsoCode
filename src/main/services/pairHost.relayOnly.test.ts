import { openFrame, sealFrame, toBase64Url } from '@enso/pair';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TestSocket {
  readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  socket: null as TestSocket | null,
  direct: false,
  directSent: [] as Uint8Array[],
}));

vi.mock('@enso/pair', async (importOriginal) => {
  const original = await importOriginal<typeof import('@enso/pair')>();
  class FakeDirectLink {
    transport(): 'direct' | 'relay' {
      return mocks.direct ? 'direct' : 'relay';
    }
    send(frame: Uint8Array): boolean {
      if (!mocks.direct) return false;
      mocks.directSent.push(frame);
      return true;
    }
    peerOnline(): void {}
    handleSignal(): void {}
    networkChange(): void {}
    close(): void {}
  }
  return {
    ...original,
    attachHeartbeat: () => ({ stop: vi.fn(), probe: vi.fn() }),
    DirectLink: FakeDirectLink,
  };
});
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  powerMonitor: { on: vi.fn() },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() },
}));
vi.mock('./agentHost', () => ({ requestSnapshot: vi.fn(), setPinnedSessions: vi.fn() }));
vi.mock('./macosSystemSleepAssertion', () => ({
  MacosSystemSleepAssertion: class {
    start(): void {}
    stop(): void {}
  },
}));
vi.mock('./notifications', () => ({ readNotifyMainAgentOnly: () => false }));
vi.mock('./pairDirectConfig', () => ({ PAIR_DIRECT_ENABLED: false, PAIR_STUN_SERVERS: [] }));
vi.mock('./pairDirectPeer', () => ({
  isDirectPeerAvailable: () => false,
  mainDirectPeerFactory: null,
  preloadDirectPeer: () => Promise.resolve(),
}));
vi.mock('./pairMetaFlush', () => ({
  bumpPairMetaEpoch: vi.fn(),
  flushChangedMeta: vi.fn(async () => ({})),
  requestPairMeta: vi.fn(),
}));
vi.mock('./pairNetworkWatch', () => ({ startPairNetworkWatch: () => vi.fn() }));
vi.mock('./pairRelayLookup', () => ({ seedRelayHostCache: vi.fn() }));
vi.mock('./pairRelayOpen', () => ({
  openPairRelayWebSocket: () => Promise.resolve(mocks.socket),
}));
vi.mock('./pairStore', () => ({
  isSecureStorageAvailable: () => true,
  loadDevices: () => [
    {
      pairId: 'pair-1',
      token: 'token-1',
      contentKey: toBase64Url(new Uint8Array(32).fill(7)),
      deviceName: 'phone',
      relayUrl: 'https://relay.example.com',
      pairedAt: 1,
    },
  ],
  loadRelayHostCache: () => null,
  loadRelayUrl: () => null,
  renameDevice: (devices: unknown) => devices,
  saveDevices: vi.fn(),
  saveRelayUrl: vi.fn(),
  upsertDevice: (devices: unknown) => devices,
}));
vi.mock('./pushNotifier', () => ({
  buildPushPayload: () => null,
  clearPushSubscription: vi.fn(),
  getVapidPublicKey: () => '',
  hasPushSubscription: () => false,
  sendPush: vi.fn(),
  setPushSubscription: vi.fn(),
}));

import { startPairHost, stopPairHost } from './pairHost';
import { type RemoteLink, setRemoteHostHooks } from './remoteRenderer/hostHooks';

describe('pairHost peer-joined 防重放中继期与大帧 gzip', () => {
  const contentKey = new Uint8Array(32).fill(7);

  beforeEach(async () => {
    mocks.direct = false;
    mocks.directSent = [];
    mocks.socket = {
      readyState: 1,
      binaryType: '',
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: vi.fn(),
      close: vi.fn(),
    };
    startPairHost();
    await vi.waitFor(() => expect(mocks.socket?.onmessage).toBeTypeOf('function'));
    mocks.socket.onopen?.();
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    vi.setSystemTime(10_000);
  });

  const flushIO = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
  };

  afterEach(() => {
    stopPairHost();
    vi.useRealTimers();
  });

  it('peer-joined 后 3s 内即使直连已通也走中继，过后恢复走直连', async () => {
    let link: RemoteLink | null = null;
    setRemoteHostHooks({
      command: async (currentLink) => {
        link = currentLink;
      },
      linkDown: vi.fn(),
      linkRevoked: vi.fn(),
    });
    const deliverFromPhone = async (message: unknown) => {
      const frame = await sealFrame(contentKey, message);
      mocks.socket?.onmessage?.({
        data: frame.buffer.slice(
          frame.byteOffset,
          frame.byteOffset + frame.byteLength
        ) as ArrayBuffer,
      });
    };
    mocks.direct = true;
    mocks.socket?.onmessage?.({ data: JSON.stringify({ type: 'peer-joined' }) });
    await deliverFromPhone({ type: 'rpc-hello', cid: 'c1', kind: 'main' });
    await flushIO();
    expect(link).not.toBeNull();

    mocks.socket?.send.mockClear();
    mocks.directSent = [];
    link!.send({ type: 'rpc-event', cid: 'c1', ch: 'early', args: [], seq: 1 } as never);
    await flushIO();
    expect(mocks.directSent).toHaveLength(0);
    expect(mocks.socket?.send).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_100);
    mocks.socket?.send.mockClear();
    mocks.directSent = [];
    link!.send({ type: 'rpc-event', cid: 'c1', ch: 'later', args: [], seq: 2 } as never);
    await flushIO();
    expect(mocks.directSent).toHaveLength(1);
    expect(mocks.socket?.send).not.toHaveBeenCalled();
  });

  it('remote-ack 声明 gzip 后，超过阈值的大帧压缩成 gzip 帧发出且线格式兼容 gunzipRemoteFrame', async () => {
    const pair = await vi.importActual<typeof import('@enso/pair')>('@enso/pair');
    let link: RemoteLink | null = null;
    setRemoteHostHooks({
      command: async (currentLink) => {
        link = currentLink;
      },
      linkDown: vi.fn(),
      linkRevoked: vi.fn(),
    });
    const deliverFromPhone = async (message: unknown) => {
      const frame = await sealFrame(contentKey, message);
      mocks.socket?.onmessage?.({
        data: frame.buffer.slice(
          frame.byteOffset,
          frame.byteOffset + frame.byteLength
        ) as ArrayBuffer,
      });
    };
    mocks.socket?.onmessage?.({ data: JSON.stringify({ type: 'peer-joined' }) });
    await deliverFromPhone({ type: 'remote-ack', bytes: 0, gzip: true });
    await deliverFromPhone({ type: 'rpc-hello', cid: 'c1', kind: 'main' });
    await flushIO();
    expect(link).not.toBeNull();
    mocks.socket?.send.mockClear();

    const payload = {
      type: 'rpc-result',
      cid: 'c1',
      id: 1,
      ok: true,
      data: 'a'.repeat(30_000),
      seq: 1,
    };
    link!.send(payload as never);
    await flushIO();
    expect(mocks.socket?.send).toHaveBeenCalled();
    const sentBytes = mocks.socket?.send.mock.calls.at(-1)?.[0] as ArrayBuffer;
    const outer = (await openFrame(contentKey, new Uint8Array(sentBytes))) as {
      type: string;
      data: string;
    };
    expect(outer.type).toBe('gzip');
    expect(await pair.gunzipRemoteFrame(outer as never)).toEqual(payload);
  });
});
