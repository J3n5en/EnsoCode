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
    const settings = tunnel.attach('settings', () => {});
    const settingsCid = hellos()[0]?.cid as string;
    expect(settingsCid).toBeTruthy();

    mockState.events?.onState('offline');
    mockState.sent = [];

    // 离线期间关闭设置页（iOS WebKit 移除 iframe 或用户关闭弹窗）
    settings.close();
    settings.close();
    expect(byes()).toHaveLength(0);

    // 网络恢复上线：应为离线关闭的 settings slot 补发一次 rpc-bye，且不再为它发 rpc-hello
    mockState.events?.onState('online');
    expect(byes()).toEqual([{ type: 'rpc-bye', cid: settingsCid }]);
    expect(hellos().some((h) => h.cid === settingsCid)).toBe(false);

    // 再次重连不应重复发送已清理的 rpc-bye
    mockState.sent = [];
    mockState.events?.onState('offline');
    mockState.events?.onState('online');
    expect(byes()).toHaveLength(0);
  });
});
