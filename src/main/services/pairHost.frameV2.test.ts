import { openFrame, sealFrame, sealFrameV2, splitRemoteBinaryFrame, toBase64Url } from '@enso/pair';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeFrameCodec } from './pairFrameCodec';

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
}));

vi.mock('@enso/pair', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@enso/pair')>()),
  attachHeartbeat: () => ({ stop: vi.fn(), probe: vi.fn() }),
}));
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
      contentKey: toBase64Url(new Uint8Array(32).fill(9)),
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

describe('pairHost frame-v2 能力协商与二进制帧收发', () => {
  const contentKey = new Uint8Array(32).fill(9);

  beforeEach(async () => {
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
  });

  afterEach(() => {
    stopPairHost();
  });

  const deliverFrame = (frame: Uint8Array) => {
    mocks.socket?.onmessage?.({
      data: frame.buffer.slice(
        frame.byteOffset,
        frame.byteOffset + frame.byteLength
      ) as ArrayBuffer,
    });
  };

  it('host-info 声明 frame-v2；未收到 v2 前发 v1，收到 remote-ack(v2) 后切换 v2 并支持 bpart 上行', async () => {
    let link: RemoteLink | null = null;
    const receivedCommands: unknown[] = [];
    setRemoteHostHooks({
      command: async (currentLink, command) => {
        link = currentLink;
        receivedCommands.push(command);
      },
      linkDown: vi.fn(),
      linkRevoked: vi.fn(),
    });

    mocks.socket?.onmessage?.({ data: JSON.stringify({ type: 'peer-joined' }) });
    let hostInfo: { type: string; capabilities?: string[] } | undefined;
    await vi.waitFor(async () => {
      const initialRawFrames = (mocks.socket?.send.mock.calls ?? []).map(
        ([buf]) => new Uint8Array(buf as ArrayBuffer)
      );
      expect(initialRawFrames.length).toBeGreaterThan(0);
      expect(initialRawFrames.every((frame) => frame[0] === 1)).toBe(true);
      const initialPayloads = await Promise.all(
        initialRawFrames.map((frame) => openFrame(contentKey, frame))
      );
      hostInfo = initialPayloads.find(
        (item): item is { type: string; capabilities?: string[] } =>
          typeof item === 'object' &&
          item !== null &&
          (item as { type?: string }).type === 'host-info'
      );
      expect(hostInfo?.capabilities).toContain('frame-v2');
    });

    // 客户端以 v2 发送 remote-ack(v2: true) 与 rpc-hello
    deliverFrame(
      await sealFrameV2(
        contentKey,
        { type: 'remote-ack', bytes: 0, gzip: true, v2: true },
        { codec: nodeFrameCodec }
      )
    );
    deliverFrame(
      await sealFrameV2(
        contentKey,
        { type: 'rpc-hello', cid: 'c1', kind: 'main' },
        { codec: nodeFrameCodec }
      )
    );
    await vi.waitFor(() => expect(link?.v2).toBe(true));

    // 宿主发出的二进制 asset 走 v2 帧且无 Base64，总字节显著小于原始大小（文本类自动 gzip）
    mocks.socket?.send.mockClear();
    const textAsset = new TextEncoder().encode('export const ok = true;\n'.repeat(200));
    link!.send({
      type: 'asset',
      id: 7,
      status: 200,
      mime: 'application/javascript',
      bin: textAsset,
    });
    await vi.waitFor(() => expect(mocks.socket?.send).toHaveBeenCalled());
    const wireBytes = new Uint8Array(mocks.socket?.send.mock.calls.at(-1)?.[0] as ArrayBuffer);
    expect(wireBytes[0]).toBe(2);
    expect(wireBytes.byteLength).toBeLessThan(1000);
    const decodedAsset = (await openFrame(contentKey, wireBytes, { codec: nodeFrameCodec })) as {
      type: string;
      id: number;
      bin: Uint8Array;
    };
    expect(decodedAsset.type).toBe('asset');
    expect(Buffer.from(decodedAsset.bin).equals(Buffer.from(textAsset))).toBe(true);

    // 上行 bpart 分片能重组还原并触发 remote hooks
    const bigArgs = ['hello '.repeat(250)];
    const bigSend = { type: 'rpc-send' as const, cid: 'c1', id: 55, ch: 'big', args: bigArgs };
    const bparts = await splitRemoteBinaryFrame(bigSend, () => 'up-bp', {
      codec: nodeFrameCodec,
      limit: 64,
    });
    expect(bparts.length).toBeGreaterThanOrEqual(1);
    for (const part of bparts) {
      deliverFrame(await sealFrameV2(contentKey, part, { codec: nodeFrameCodec }));
    }
    await vi.waitFor(() =>
      expect(receivedCommands).toContainEqual(
        expect.objectContaining({ type: 'rpc-send', id: 55, ch: 'big', args: bigArgs })
      )
    );
  });

  it('v1 不可压缩 asset 回落也不应反向 gzip 膨胀', async () => {
    let link: RemoteLink | null = null;
    setRemoteHostHooks({
      command: async (currentLink) => {
        link = currentLink;
      },
      linkDown: vi.fn(),
      linkRevoked: vi.fn(),
    });

    mocks.socket?.onmessage?.({ data: JSON.stringify({ type: 'peer-joined' }) });
    deliverFrame(await sealFrame(contentKey, { type: 'remote-ack', bytes: 0, gzip: true }));
    deliverFrame(await sealFrame(contentKey, { type: 'rpc-hello', cid: 'c1', kind: 'main' }));
    await vi.waitFor(() => expect(link).not.toBeNull());

    mocks.socket?.send.mockClear();
    const rng = new Uint8Array(15_000);
    crypto.getRandomValues(rng);
    const base64 = Buffer.from(rng).toString('base64');
    link!.send({ type: 'asset', id: 11, status: 200, mime: 'image/png', data: base64 });
    await vi.waitFor(() => expect(mocks.socket?.send).toHaveBeenCalled());
    const rawFrame = new Uint8Array(mocks.socket?.send.mock.calls.at(-1)?.[0] as ArrayBuffer);
    expect(rawFrame[0]).toBe(1);
    const parsed = (await openFrame(contentKey, rawFrame)) as { type: string; mime?: string };
    expect(parsed.type).toBe('asset');
  });
});
