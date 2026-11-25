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

const hostMocks = vi.hoisted(() => ({
  socket: null as TestSocket | null,
  loadDevices: vi.fn(),
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
vi.mock('./agentHost', () => ({
  requestSnapshot: vi.fn(),
  setPinnedSessions: vi.fn(),
}));
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
  openPairRelayWebSocket: () => Promise.resolve(hostMocks.socket),
}));
vi.mock('./pairStore', () => ({
  isSecureStorageAvailable: () => true,
  loadDevices: hostMocks.loadDevices,
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

import { startPairHost, stopPairHost, updatePairCatalog } from './pairHost';
import { type RemoteLink, setRemoteHostHooks } from './remoteRenderer/hostHooks';

describe('pairHost 目录下发', () => {
  const contentKey = new Uint8Array(32).fill(7);

  beforeEach(async () => {
    hostMocks.socket = {
      readyState: 1,
      binaryType: '',
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: vi.fn(),
      close: vi.fn(),
    };
    hostMocks.loadDevices.mockReturnValue([
      {
        pairId: 'pair-1',
        token: 'token-1',
        contentKey: toBase64Url(contentKey),
        deviceName: 'guest-desktop',
        relayUrl: 'https://relay.example.com',
        pairedAt: 1,
      },
    ]);
    startPairHost();
    await vi.waitFor(() => expect(hostMocks.socket?.onmessage).toBeTypeOf('function'));
    hostMocks.socket?.onopen?.();
  });

  afterEach(() => {
    stopPairHost();
  });

  const control = (type: 'peer-joined' | 'peer-left'): void => {
    hostMocks.socket?.onmessage?.({ data: JSON.stringify({ type }) });
  };

  async function sentPayloads(): Promise<Record<string, unknown>[]> {
    const calls = hostMocks.socket?.send.mock.calls ?? [];
    return Promise.all(
      calls.map(
        async ([data]) =>
          (await openFrame(contentKey, new Uint8Array(data))) as Record<string, unknown>
      )
    );
  }

  async function sentTypes(): Promise<unknown[]> {
    return (await sentPayloads()).map((payload) => payload.type);
  }

  it('对端刷新后重新进房，模型表必须重发（内存已空，不能按上次进房的指纹跳过）', async () => {
    control('peer-joined');
    const providers = [{ id: 'p1', name: 'Provider', models: [{ id: 'm1', label: 'Model' }] }];
    updatePairCatalog({
      catalog: [],
      projects: [{ id: 'proj-1', name: 'demo', path: '/tmp/demo' }],
      providers,
      projectPaths: [{ id: 'proj-1', path: '/tmp/demo' }],
      theme: 'dark',
    });
    await vi.waitFor(async () => expect(await sentTypes()).toContain('appearance'));
    expect(await sentTypes()).toContain('providers');
    await new Promise((resolve) => setTimeout(resolve, 20));

    hostMocks.socket?.send.mockClear();
    control('peer-left');
    control('peer-joined');

    await vi.waitFor(async () => expect(await sentTypes()).toContain('host-info'));
    expect(await sentTypes()).toContain('projects');
    expect((await sentPayloads()).find((payload) => payload.type === 'providers')).toMatchObject({
      providers,
    });
  });

  it('host-info 向可操作设备声明桌面模式能力', async () => {
    control('peer-joined');
    await vi.waitFor(async () => expect(await sentTypes()).toContain('host-info'));
    // 可操作设备才声明桌面模式；旧桌面缺省该字段，PWA 据此隐藏入口
    expect((await sentPayloads()).find((payload) => payload.type === 'host-info')).toMatchObject({
      remoteDesktop: true,
    });
  });

  it('同一次进房内对端再要目录，不重打模型表', async () => {
    control('peer-joined');
    updatePairCatalog({
      catalog: [],
      projects: [],
      providers: [{ id: 'p1', name: 'Provider', models: [{ id: 'm1' }] }],
      projectPaths: [],
      theme: 'dark',
    });
    await vi.waitFor(async () => expect(await sentTypes()).toContain('providers'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    hostMocks.socket?.send.mockClear();
    const frame = await sealFrame(contentKey, { type: 'snapshot' });
    hostMocks.socket?.onmessage?.({
      data: frame.buffer.slice(
        frame.byteOffset,
        frame.byteOffset + frame.byteLength
      ) as ArrayBuffer,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await sentTypes()).not.toContain('providers');
  });

  it('手机已离开且无直连时，远程桌面帧不再发往中继，改为挂起远端 renderer', async () => {
    const links: RemoteLink[] = [];
    const linkDown = vi.fn();
    setRemoteHostHooks({
      command: async (link) => {
        links.push(link);
      },
      linkDown,
      linkRevoked: vi.fn(),
    });
    control('peer-joined');
    const frame = await sealFrame(contentKey, { type: 'rpc-hello', cid: 'c1', kind: 'main' });
    hostMocks.socket?.onmessage?.({
      data: frame.buffer.slice(
        frame.byteOffset,
        frame.byteOffset + frame.byteLength
      ) as ArrayBuffer,
    });
    await vi.waitFor(() => expect(links).toHaveLength(1));
    const link = links[0] as RemoteLink;
    await new Promise((resolve) => setTimeout(resolve, 20));

    hostMocks.socket?.send.mockClear();
    link.send({ type: 'rpc-event', cid: 'c1', ch: 'x', args: [], seq: 1 } as never);
    await vi.waitFor(async () => expect(await sentTypes()).toContain('rpc-event'));

    control('peer-left');
    linkDown.mockClear();
    hostMocks.socket?.send.mockClear();
    link.send({ type: 'rpc-event', cid: 'c1', ch: 'x', args: [], seq: 2 } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 发给中继也没人收：帧已在 RemoteSender 保留窗口里，挂起后等手机续上再补
    expect(await sentTypes()).not.toContain('rpc-event');
    expect(linkDown).toHaveBeenCalledWith('pair-1');
  });

  it('rpc-hello 催补发时先清掉该 slot 队列里的旧残片再解锁窗口，避免旧残片抢占带宽堵住新补发帧', async () => {
    let link: RemoteLink | null = null;
    const bigPayload = 'x'.repeat(240_000 * 5);
    setRemoteHostHooks({
      command: async (currentLink, command) => {
        link = currentLink;
        if (command.type === 'rpc-hello' && command.seq === 0) {
          // 模拟停滞后的重放补发：给同一 seq 生成新一轮分片
          currentLink.send({
            type: 'rpc-result',
            cid: command.cid,
            id: 1,
            ok: true,
            data: bigPayload,
            seq: 1,
          } as never);
        }
      },
      linkDown: vi.fn(),
      linkRevoked: vi.fn(),
    });
    const deliverFromPhone = async (message: unknown) => {
      const frame = await sealFrame(contentKey, message);
      hostMocks.socket?.onmessage?.({
        data: frame.buffer.slice(
          frame.byteOffset,
          frame.byteOffset + frame.byteLength
        ) as ArrayBuffer,
      });
    };
    control('peer-joined');
    await deliverFromPhone({ type: 'remote-ack', bytes: 0 });
    await deliverFromPhone({ type: 'rpc-hello', cid: 'c1', kind: 'main' });
    await vi.waitFor(() => expect(link).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 首次发送 6 片大帧：前 3 片立即在途（超过 512KB 窗口），后 3 片排在 BulkWindow 队列里
    hostMocks.socket?.send.mockClear();
    (link as unknown as RemoteLink).send({
      type: 'rpc-result',
      cid: 'c1',
      id: 1,
      ok: true,
      data: bigPayload,
      seq: 1,
    } as never);
    await vi.waitFor(async () =>
      expect((await sentPayloads()).filter((p) => p.type === 'part')).toHaveLength(3)
    );
    const firstBatch = (await sentPayloads()).filter((p) => p.type === 'part');
    const oldPid = firstBatch[0]?.pid as string;
    expect(firstBatch.map((p) => p.index)).toEqual([0, 1, 2]);

    // 推进时间超过 2s unblock 阈值，再发带 seq=0 的 rpc-hello 催补发
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_000);
    try {
      hostMocks.socket?.send.mockClear();
      await deliverFromPhone({ type: 'rpc-hello', cid: 'c1', kind: 'main', seq: 0 });
      await vi.waitFor(async () =>
        expect((await sentPayloads()).filter((p) => p.type === 'part')).toHaveLength(3)
      );
      const replayBatch = (await sentPayloads()).filter((p) => p.type === 'part');
      // 绝不能把旧 pid 的 index 3/4/5 残片先发出去重新堵死窗口
      expect(replayBatch.every((p) => p.pid !== oldPid)).toBe(true);
      expect(replayBatch.map((p) => p.index)).toEqual([0, 1, 2]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('rpc-bye 清除该 slot 排队中的残留分片且不影响资源分片', async () => {
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
      hostMocks.socket?.onmessage?.({
        data: frame.buffer.slice(
          frame.byteOffset,
          frame.byteOffset + frame.byteLength
        ) as ArrayBuffer,
      });
    };
    control('peer-joined');
    await deliverFromPhone({ type: 'remote-ack', bytes: 0 });
    await deliverFromPhone({ type: 'rpc-hello', cid: 'c1', kind: 'main' });
    await vi.waitFor(() => expect(link).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));

    hostMocks.socket?.send.mockClear();
    const huge = 'y'.repeat(240_000 * 5);
    (link as unknown as RemoteLink).send({
      type: 'rpc-event',
      cid: 'c1',
      ch: 'big',
      args: [huge],
      seq: 1,
    } as never);
    (link as unknown as RemoteLink).send({
      type: 'asset',
      id: 42,
      status: 200,
      mime: 'image/png',
      data: 'z'.repeat(240_000 * 2),
    } as never);
    await vi.waitFor(async () =>
      expect((await sentPayloads()).filter((p) => p.type === 'part')).toHaveLength(3)
    );
    const oldPid = (await sentPayloads()).find((p) => p.type === 'part')?.pid as string;

    hostMocks.socket?.send.mockClear();
    await deliverFromPhone({ type: 'rpc-bye', cid: 'c1' });
    await deliverFromPhone({ type: 'remote-ack', bytes: 1_000_000 });
    await vi.waitFor(async () =>
      expect((await sentPayloads()).filter((p) => p.type === 'part').length).toBeGreaterThanOrEqual(
        2
      )
    );
    const afterBye = (await sentPayloads()).filter((p) => p.type === 'part');
    expect(afterBye.some((p) => p.pid === oldPid)).toBe(false);
  });
});
