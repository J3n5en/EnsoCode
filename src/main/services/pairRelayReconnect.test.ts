import { toBase64Url } from '@enso/pair';
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
  sockets: [] as TestSocket[],
  networkChange: null as (() => void) | null,
  device: null as Record<string, unknown> | null,
}));

function makeSocket(): TestSocket {
  // close() 只进 CLOSING，不触发 onclose：模拟半开链关闭握手永远等不到回应
  const socket: TestSocket = {
    readyState: 0,
    binaryType: '',
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(() => {
      socket.readyState = 2;
    }),
  };
  return socket;
}

vi.mock('@enso/pair', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@enso/pair')>()),
  attachHeartbeat: () => ({ stop: vi.fn(), probe: vi.fn() }),
}));
vi.mock('electron', () => ({
  app: { getVersion: () => 'test', getPath: () => '/tmp' },
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
vi.mock('./pairNetworkWatch', () => ({
  startPairNetworkWatch: ({ onChange }: { onChange: () => void }) => {
    mocks.networkChange = onChange;
    return vi.fn();
  },
}));
vi.mock('./pairRelayLookup', () => ({ seedRelayHostCache: vi.fn() }));
vi.mock('./pairRelayOpen', () => ({
  openPairRelayWebSocket: () => {
    const socket = makeSocket();
    mocks.sockets.push(socket);
    return Promise.resolve(socket);
  },
}));
vi.mock('./pairStore', () => ({
  isSecureStorageAvailable: () => true,
  loadDevices: () => [mocks.device],
  loadRelayHostCache: () => null,
  loadRelayUrl: () => null,
  renameDevice: (devices: unknown) => devices,
  saveDevices: vi.fn(),
  saveRelayUrl: vi.fn(),
  upsertDevice: (devices: unknown) => devices,
}));
vi.mock('./nodeStore', () => ({
  adoptHostname: vi.fn(),
  isNodeStoreSecure: () => true,
  loadNodes: () => [{ ...mocks.device, nodeId: mocks.device?.pairId, label: 'node' }],
  removeNode: (nodes: unknown) => nodes,
  renameNode: (nodes: unknown) => nodes,
  saveNodes: vi.fn(),
  upsertNode: (nodes: unknown) => nodes,
}));
vi.mock('./pushNotifier', () => ({
  buildPushPayload: () => null,
  clearPushSubscription: vi.fn(),
  getVapidPublicKey: () => '',
  hasPushSubscription: () => false,
  sendPush: vi.fn(),
  setPushSubscription: vi.fn(),
}));

import { startPairGuest, stopPairGuest } from './pairGuest';
import { startPairHost, stopPairHost } from './pairHost';

const sides = [
  { name: 'pairHost', start: startPairHost, stop: stopPairHost },
  { name: 'pairGuest', start: startPairGuest, stop: stopPairGuest },
];

describe.each(sides)('$name 中继重连', ({ start, stop }) => {
  beforeEach(async () => {
    vi.useFakeTimers();
    mocks.sockets = [];
    mocks.device = {
      pairId: 'pair-1',
      token: 'token-1',
      contentKey: toBase64Url(new Uint8Array(32).fill(7)),
      deviceName: 'device',
      relayUrl: 'https://relay.example.com',
      pairedAt: 1,
    };
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sockets).toHaveLength(1);
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('握手一直卡在 CONNECTING 时超时拆链并重连', async () => {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.sockets[0]?.close).toHaveBeenCalled();
    expect(mocks.sockets.length).toBeGreaterThanOrEqual(2);
  });

  it('握手成功后不触发连接超时', async () => {
    const socket = mocks.sockets[0] as TestSocket;
    socket.readyState = 1;
    socket.onopen?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.close).not.toHaveBeenCalled();
    expect(mocks.sockets).toHaveLength(1);
  });

  it('网络变化替换旧链时不等 close 事件就重连', async () => {
    const socket = mocks.sockets[0] as TestSocket;
    socket.readyState = 1;
    socket.onopen?.();
    mocks.networkChange?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.close).toHaveBeenCalled();
    expect(mocks.sockets).toHaveLength(2);
  });
});
