import type { HostToRemote, PairedDevice, PhoneToHost } from '@enso/pair';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockClientEvents {
  onState(state: 'connecting' | 'online' | 'offline' | 'host-offline'): void;
  onRemoteFrame?(frame: HostToRemote): void;
  onTransport?(transport: 'relay' | 'direct'): void;
}

const mockState = vi.hoisted(() => ({
  events: null as MockClientEvents | null,
  sent: [] as PhoneToHost[],
}));

vi.mock('../client', () => ({
  PairClient: class {
    constructor(_device: PairedDevice, events: MockClientEvents) {
      mockState.events = events;
    }
    connect(): void {}
    close(): void {}
    nudge(): void {}
    conceal(): void {}
    send(message: PhoneToHost): void {
      mockState.sent.push(message);
    }
  },
}));

import { DeskTunnel } from './tunnel';

const DEVICE: PairedDevice = {
  pairId: 'pair-1',
  token: 'tok',
  contentKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  relayUrl: 'https://relay.example.com',
  deviceName: 'Mac',
  pairedAt: 1,
};

const hellos = () =>
  mockState.sent.filter(
    (m): m is Extract<PhoneToHost, { type: 'rpc-hello' }> => m.type === 'rpc-hello'
  );
const byes = () =>
  mockState.sent.filter(
    (m): m is Extract<PhoneToHost, { type: 'rpc-bye' }> => m.type === 'rpc-bye'
  );

describe('DeskTunnel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    mockState.events = null;
    mockState.sent = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createOnlineTunnel() {
    const tunnel = new DeskTunnel(
      DEVICE,
      () => {},
      () => {}
    );
    const frame = tunnel.attach('main', () => {});
    mockState.events?.onState('online');
    const cid = hellos()[0]?.cid as string;
    mockState.events?.onRemoteFrame?.({
      type: 'rpc-ready',
      cid,
      ok: true,
      resumed: false,
      version: 'v1',
      platform: 'darwin',
      leader: true,
      replay: true,
    });
    mockState.sent = [];
    return { tunnel, frame, cid };
  }

  it('混发乱序帧按 seq 有序应用并去重', () => {
    const { frame, cid } = createOnlineTunnel();
    const received: string[] = [];
    frame.on('evt', (payload) => received.push(payload));

    // seq 2、3 先走直连到达，seq 1 慢走中继后到达，再收到重复的 seq 1/2
    mockState.events?.onRemoteFrame?.({ type: 'rpc-event', cid, ch: 'evt', args: ['b'], seq: 2 });
    mockState.events?.onRemoteFrame?.({ type: 'rpc-event', cid, ch: 'evt', args: ['c'], seq: 3 });
    expect(received).toEqual([]);

    mockState.events?.onRemoteFrame?.({ type: 'rpc-event', cid, ch: 'evt', args: ['a'], seq: 1 });
    mockState.events?.onRemoteFrame?.({ type: 'rpc-event', cid, ch: 'evt', args: ['a'], seq: 1 });
    mockState.events?.onRemoteFrame?.({ type: 'rpc-event', cid, ch: 'evt', args: ['b'], seq: 2 });
    expect(received).toEqual(['["a"]', '["b"]', '["c"]']);
  });

  it('重连后等 ready 期间补发帧在按序应用：不重新 hello', () => {
    const listen = { addEventListener: () => {} };
    vi.stubGlobal('document', { ...listen, visibilityState: 'visible' });
    vi.stubGlobal('window', listen);
    const { tunnel, cid } = createOnlineTunnel();
    tunnel.start();
    mockState.events?.onState('offline');
    mockState.events?.onState('online');
    mockState.sent = [];
    for (let seq = 1; seq <= 6; seq++) {
      mockState.events?.onRemoteFrame?.({ type: 'rpc-event', cid, ch: 'evt', args: [seq], seq });
      vi.advanceTimersByTime(2_000);
    }
    expect(hellos()).toHaveLength(0);
    vi.advanceTimersByTime(6_000);
    expect(hellos()).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('切链后 1.5s 快速补发每缺口仅触发一次，随后退回 8s 常规窗口', () => {
    const { cid } = createOnlineTunnel();
    mockState.events?.onTransport?.('relay');
    mockState.sent = [];

    // 切链后立刻出现缺口（收到 seq 2，缺 seq 1）
    mockState.events?.onRemoteFrame?.({ type: 'rpc-event', cid, ch: 'evt', args: [2], seq: 2 });

    vi.advanceTimersByTime(1_499);
    expect(hellos()).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(hellos()).toHaveLength(1);

    // 不应在 1.5s 后再次雪崩重发；直到 8s 常规窗口才发第二次
    vi.advanceTimersByTime(7_999);
    expect(hellos()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(hellos()).toHaveLength(2);
  });

  it('外部 resync 发完 hello 后推迟既有 gapTimer，不在短时间内叠发两次', () => {
    const { cid } = createOnlineTunnel();
    mockState.events?.onTransport?.('relay');
    mockState.sent = [];

    mockState.events?.onRemoteFrame?.({ type: 'rpc-event', cid, ch: 'evt', args: [2], seq: 2 });
    vi.advanceTimersByTime(1_000);
    expect(hellos()).toHaveLength(0);

    // 宿主重新上线触发 resync 立即发一次 hello；原有 1.5s gapTimer（只剩 500ms）应被推迟到 8s
    mockState.events?.onState('online');
    expect(hellos()).toHaveLength(1);

    vi.advanceTimersByTime(2_000);
    expect(hellos()).toHaveLength(1);
  });

  it('中继升级到直连不重新 hello：中继仍在送，重发只会让宿主把在途大帧再排一遍', () => {
    const { cid } = createOnlineTunnel();
    mockState.events?.onTransport?.('direct');
    expect(hellos()).toHaveLength(0);

    // 大结果走中继分片、小帧走直连先到，属正常乱序：按常规窗口等，不走切链快速补发
    mockState.events?.onRemoteFrame?.({ type: 'rpc-event', cid, ch: 'evt', args: [2], seq: 2 });
    vi.advanceTimersByTime(7_999);
    expect(hellos()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(hellos()).toHaveLength(1);
  });

  it('首次上线没有可丢的旧帧：启动期缺口按常规窗口等', () => {
    const { cid } = createOnlineTunnel();
    mockState.events?.onRemoteFrame?.({ type: 'rpc-event', cid, ch: 'evt', args: [2], seq: 2 });
    vi.advanceTimersByTime(1_500);
    expect(hellos()).toHaveLength(0);
    vi.advanceTimersByTime(6_500);
    expect(hellos()).toHaveLength(1);
  });

  it('断线重连上线后缺口仍快速补发', () => {
    const { cid } = createOnlineTunnel();
    mockState.events?.onState('offline');
    mockState.events?.onState('online');
    mockState.events?.onRemoteFrame?.({
      type: 'rpc-ready',
      cid,
      ok: true,
      resumed: true,
      version: 'v1',
      platform: 'darwin',
      leader: true,
      replay: true,
    });
    mockState.sent = [];
    mockState.events?.onRemoteFrame?.({ type: 'rpc-event', cid, ch: 'evt', args: [2], seq: 2 });
    vi.advanceTimersByTime(1_500);
    expect(hellos()).toHaveLength(1);
  });

  it('离线期间关闭 slot，重连上线后补发 rpc-bye 清理宿主幽灵 slot', () => {
    const { tunnel } = createOnlineTunnel();
    const second = tunnel.attach('main', () => {});
    const secondCid = hellos()[0]?.cid as string;
    expect(secondCid).toBeTruthy();

    mockState.events?.onState('offline');
    mockState.sent = [];

    // 离线期间关闭第二个 slot（iframe 移除或页面关闭）
    second.close();
    second.close();
    expect(byes()).toHaveLength(0);

    // 网络恢复上线：为离线关闭的 slot 补发一次 rpc-bye，且不再为它发 rpc-hello
    mockState.events?.onState('online');
    expect(byes()).toEqual([{ type: 'rpc-bye', cid: secondCid }]);
    expect(hellos().some((h) => h.cid === secondCid)).toBe(false);

    // 再次重连不应重复发送已清理的 rpc-bye
    mockState.sent = [];
    mockState.events?.onState('offline');
    mockState.events?.onState('online');
    expect(byes()).toHaveLength(0);
  });

  it('等 ready 时桌面重进中继（再次 host-online）：立即重新 hello，不等 5s 重试', () => {
    const tunnel = new DeskTunnel(
      DEVICE,
      () => {},
      () => {}
    );
    tunnel.attach('main', () => {});
    mockState.events?.onState('online');
    expect(hellos()).toHaveLength(1);
    mockState.sent = [];
    mockState.events?.onState('online');
    expect(hellos()).toHaveLength(1);
  });

  it('rpc-result 先到而前置 rpc-event 缺口未补时立即 resolve，缺口补齐后幂等不重放', async () => {
    const { frame, cid } = createOnlineTunnel();
    const events: string[] = [];
    frame.on('evt', (payload) => events.push(payload));

    const pending = frame.invoke('settings:read', '[]');
    const req = mockState.sent.find(
      (m): m is Extract<PhoneToHost, { type: 'rpc-invoke' }> => m.type === 'rpc-invoke'
    );
    expect(req).toBeTruthy();

    // seq: 2 先到达，seq: 1（rpc-event）仍在路上：invoke 结果立刻兑现
    mockState.events?.onRemoteFrame?.({
      type: 'rpc-result',
      cid,
      id: req!.id,
      ok: true,
      data: { ok: 1 },
      seq: 2,
    });
    await expect(pending).resolves.toBe(JSON.stringify({ ok: 1 }));

    // 随后 seq: 1 补到，按序应用；重复的 seq: 2 再次到来不会报错或二次兑现
    mockState.events?.onRemoteFrame?.({ type: 'rpc-event', cid, ch: 'evt', args: ['e1'], seq: 1 });
    mockState.events?.onRemoteFrame?.({
      type: 'rpc-result',
      cid,
      id: req!.id,
      ok: true,
      data: { ok: 2 },
      seq: 2,
    });
    expect(events).toEqual(['["e1"]']);
  });

  it('rpc-result 越过缺口先行兑现后，缺口仍会触发 rehello-gap 补发前置事件', async () => {
    const { frame, cid } = createOnlineTunnel();
    const pending = frame.invoke('settings:read', '[]');
    const req = mockState.sent.find(
      (m): m is Extract<PhoneToHost, { type: 'rpc-invoke' }> => m.type === 'rpc-invoke'
    );
    mockState.sent = [];

    mockState.events?.onRemoteFrame?.({
      type: 'rpc-result',
      cid,
      id: req!.id,
      ok: true,
      data: { ok: 1 },
      seq: 2,
    });
    await expect(pending).resolves.toBe(JSON.stringify({ ok: 1 }));

    vi.advanceTimersByTime(8_500);
    expect(hellos()).toHaveLength(1);
  });

  it('idle 忽略后台低优通道，仅存在核心请求或流缺口时返回 false', () => {
    const { tunnel, frame, cid } = createOnlineTunnel();
    expect(tunnel.idle('main')).toBe(true);

    // 后台低优通道在途时仍算 idle
    for (const ch of [
      'worktree:list',
      'worktree:statuses',
      'projects:get-icon',
      'projects:get-icons',
      'updater:getState',
    ]) {
      void frame.invoke(ch, '[]');
    }
    expect(tunnel.idle('main')).toBe(true);

    // 核心通道在途时不算 idle，直到返回
    const core = frame.invoke('settings:read', '[]');
    const coreReq = mockState.sent.findLast(
      (m): m is Extract<PhoneToHost, { type: 'rpc-invoke' }> =>
        m.type === 'rpc-invoke' && m.ch === 'settings:read'
    );
    expect(tunnel.idle('main')).toBe(false);

    mockState.events?.onRemoteFrame?.({
      type: 'rpc-result',
      cid,
      id: coreReq!.id,
      ok: true,
      data: {},
      seq: 1,
    });
    expect(tunnel.idle('main')).toBe(true);
    void core;

    // 即使只剩低优通道在途，只要 stream 有 seq 缺口仍不算 idle
    mockState.events?.onRemoteFrame?.({
      type: 'rpc-event',
      cid,
      ch: 'evt',
      args: [1],
      seq: 3,
    });
    expect(tunnel.idle('main')).toBe(false);
  });

  it('在线 ack 声明 v2 能力，支持 asset.bin 与 bpart 二进制分片重组及流控 ack', async () => {
    const tunnel = new DeskTunnel(
      DEVICE,
      () => {},
      () => {}
    );
    mockState.events?.onState('online');
    const acks = mockState.sent.filter((m) => m.type === 'remote-ack');
    expect(acks[0]).toEqual({ type: 'remote-ack', bytes: 0, gzip: true, v2: true });

    const assetPromise = tunnel.fetchAsset('r/app.js');
    const assetReq = mockState.sent.find(
      (m): m is Extract<PhoneToHost, { type: 'asset-get' }> => m.type === 'asset-get'
    );
    const bin = new Uint8Array([1, 2, 3, 4, 5]);
    mockState.events?.onRemoteFrame?.({
      type: 'asset',
      id: assetReq!.id,
      status: 200,
      mime: 'application/octet-stream',
      bin,
    });
    const asset = await assetPromise;
    expect(Buffer.from(asset.body).equals(Buffer.from(bin))).toBe(true);

    // bpart 多片传输与重组（超过 128KB 触发流控 ack）
    const { splitRemoteBinaryFrame } =
      await vi.importActual<typeof import('@enso/pair')>('@enso/pair');
    const bigPng = new Uint8Array(160_000).fill(7);
    const bigAssetReqPromise = tunnel.fetchAsset('r/big.png');
    const bigReq = mockState.sent
      .filter((m): m is Extract<PhoneToHost, { type: 'asset-get' }> => m.type === 'asset-get')
      .at(-1);
    const bparts = await splitRemoteBinaryFrame(
      { type: 'asset', id: bigReq!.id, status: 200, mime: 'image/png', bin: bigPng },
      () => 'bp-desk',
      { limit: 90_000 }
    );
    expect(bparts.length).toBeGreaterThan(1);
    for (const part of bparts) mockState.events?.onRemoteFrame?.(part as HostToRemote);

    const bigAsset = await bigAssetReqPromise;
    expect(Buffer.from(bigAsset.body).equals(Buffer.from(bigPng))).toBe(true);
    expect(mockState.sent.filter((m) => m.type === 'remote-ack').length).toBeGreaterThanOrEqual(2);
  });

  it('拆包 rpc-batch 按序触发 rpc-event 与 rpc-result 并忽略嵌套 rpc-batch', async () => {
    const { frame, cid } = createOnlineTunnel();
    const events: string[] = [];
    frame.on('evt', (payload) => events.push(payload));

    const invokePromise = frame.invoke('settings:read', '[]');
    const req = mockState.sent.find(
      (m): m is Extract<PhoneToHost, { type: 'rpc-invoke' }> => m.type === 'rpc-invoke'
    );

    mockState.events?.onRemoteFrame?.({
      type: 'rpc-batch',
      frames: [
        { type: 'rpc-event', cid, ch: 'evt', args: ['first'], seq: 1 },
        {
          type: 'rpc-batch',
          frames: [{ type: 'rpc-event', cid, ch: 'evt', args: ['nested'], seq: 99 }],
        } as never,
        { type: 'rpc-result', cid, id: req!.id, ok: true, data: { batched: 1 }, seq: 2 },
        { type: 'rpc-event', cid, ch: 'evt', args: ['third'], seq: 3 },
      ],
    });

    await expect(invokePromise).resolves.toBe(JSON.stringify({ batched: 1 }));
    expect(events).toEqual(['["first"]', '["third"]']);
  });

  it('冷启动 rpc-hello 附带 prefetch，支持 rpc-prefetch 命中消费与旧宿主即时回落', async () => {
    const tunnel = new DeskTunnel(
      DEVICE,
      () => {},
      () => {},
      {
        getPrefetch: () => [
          { ch: 'settings:read', args: [], h: 'hs1' },
          { ch: 'conversations:read', args: [], h: 'hc1' },
        ],
      }
    );
    tunnel.attach('main', () => {});
    mockState.events?.onState('online');
    const hello = hellos()[0] as Extract<PhoneToHost, { type: 'rpc-hello' }> & {
      prefetch?: unknown;
    };
    expect(hello.prefetch).toEqual([
      { ch: 'settings:read', args: [], h: 'hs1' },
      { ch: 'conversations:read', args: [], h: 'hc1' },
    ]);

    const t = tunnel as unknown as {
      takePrefetch: (key: string, expectedHash: string) => Promise<unknown> | null;
    };
    const settingsHit = t.takePrefetch('settings:read\0[]', 'hs1');
    expect(settingsHit).not.toBeNull();
    // hash 不匹配直接返回 null
    expect(t.takePrefetch('settings:read\0[]', 'other')).toBeNull();

    mockState.events?.onRemoteFrame?.({
      type: 'rpc-ready',
      cid: hello.cid,
      ok: true,
      resumed: false,
      version: 'v1',
      platform: 'darwin',
      leader: true,
      replay: true,
      prefetch: true,
    } as HostToRemote);

    mockState.events?.onRemoteFrame?.({
      type: 'rpc-prefetch',
      cid: hello.cid,
      items: [
        { ch: 'settings:read', args: [], data: { __ensoCached: { h: 'hs1', same: 1 } } },
        { ch: 'conversations:read', args: [], data: { __ensoCached: { h: 'hc1', same: 1 } } },
      ],
    } as HostToRemote);

    await expect(settingsHit!).resolves.toEqual({ __ensoCached: { h: 'hs1', same: 1 } });
    // 已到站后再 takePrefetch 同样可直接消费一次
    const convHit = t.takePrefetch('conversations:read\0[]', 'hc1');
    await expect(convHit!).resolves.toEqual({ __ensoCached: { h: 'hc1', same: 1 } });
    expect(t.takePrefetch('conversations:read\0[]', 'hc1')).toBeNull();

    // 旧宿主（rpc-ready 没有 prefetch: true）立即以 null 结束等待
    const tunnelOld = new DeskTunnel(
      DEVICE,
      () => {},
      () => {},
      {
        getPrefetch: () => [{ ch: 'settings:read', args: [], h: 'hs1' }],
      }
    );
    tunnelOld.attach('main', () => {});
    mockState.events?.onState('online');
    const oldHello = hellos().at(-1)!;
    const oldPending = (
      tunnelOld as unknown as {
        takePrefetch: (key: string, expectedHash: string) => Promise<unknown> | null;
      }
    ).takePrefetch('settings:read\0[]', 'hs1');
    mockState.events?.onRemoteFrame?.({
      type: 'rpc-ready',
      cid: oldHello.cid,
      ok: true,
      resumed: false,
      version: 'v1',
      platform: 'darwin',
      leader: true,
      replay: true,
    });
    await expect(oldPending!).resolves.toBeNull();
  });

  it('冷启动 attach 早于 online 时预挂 prefetch，早到的 takePrefetch 直接复用 rpc-prefetch 结果', async () => {
    const tunnel = new DeskTunnel(
      DEVICE,
      () => {},
      () => {},
      {
        getPrefetch: () => [{ ch: 'settings:read', args: [], h: 'hs-early' }],
      }
    );
    // 尚未 online 就 attach + 请求 takePrefetch（模拟真实冷启动 iframe 抢跑）
    tunnel.attach('main', () => {});
    const t = tunnel as unknown as {
      takePrefetch: (key: string, expectedHash: string) => Promise<unknown> | null;
    };
    const earlyPending = t.takePrefetch('settings:read\0[]', 'hs-early');
    expect(earlyPending).not.toBeNull();

    mockState.events?.onState('online');
    const hello = hellos()[0] as Extract<PhoneToHost, { type: 'rpc-hello' }> & {
      prefetch?: unknown;
    };
    expect(hello.prefetch).toEqual([{ ch: 'settings:read', args: [], h: 'hs-early' }]);

    mockState.events?.onRemoteFrame?.({
      type: 'rpc-ready',
      cid: hello.cid,
      ok: true,
      resumed: false,
      version: 'v1',
      platform: 'darwin',
      leader: true,
      replay: true,
      prefetch: true,
    });
    mockState.events?.onRemoteFrame?.({
      type: 'rpc-prefetch',
      cid: hello.cid,
      items: [
        { ch: 'settings:read', args: [], data: { __ensoCached: { h: 'hs-early', same: 1 } } },
      ],
    });
    await expect(earlyPending!).resolves.toEqual({ __ensoCached: { h: 'hs-early', same: 1 } });
  });

  it('原生 iOS 退后台 enso:background 只 conceal 不发 rpc-bye，避免切回被宿主拒掉续连', () => {
    const listeners = new Map<string, Array<(event: Event) => void>>();
    const origWindow = globalThis.window;
    const origDocument = globalThis.document;
    const addWin = (type: string, fn: (event: Event) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    };
    vi.stubGlobal('window', { addEventListener: addWin });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: () => {},
    });
    try {
      const { tunnel } = createOnlineTunnel();
      tunnel.start();
      mockState.sent = [];
      for (const fn of listeners.get('enso:background') ?? []) fn(new Event('enso:background'));
      expect(mockState.sent.some((m) => m.type === 'rpc-bye')).toBe(false);
      expect(mockState.sent.some((m) => m.type === 'presence')).toBe(true);
    } finally {
      vi.stubGlobal('window', origWindow);
      vi.stubGlobal('document', origDocument);
    }
  });
});
