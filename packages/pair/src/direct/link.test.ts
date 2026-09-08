import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectCandidate } from '../protocol';
import { encodeChunks } from './chunk';
import { DirectLink, type DirectSignal } from './link';
import type { DirectPeer } from './peer';

/** 可脚本化的假对端：记录调用，测试手动触发回调 */
function fakePeer() {
  const cbs = {
    ice: [] as ((c: DirectCandidate) => void)[],
    open: [] as (() => void)[],
    message: [] as ((b: Uint8Array) => void)[],
    close: [] as (() => void)[],
  };
  const sent: Uint8Array[] = [];
  const calls: string[] = [];
  let closed = false;
  const peer: DirectPeer = {
    createOffer: vi.fn(async () => {
      calls.push('createOffer');
      return 'offer-sdp';
    }),
    acceptOffer: vi.fn(async (sdp: string) => {
      calls.push(`acceptOffer:${sdp}`);
      return 'answer-sdp';
    }),
    acceptAnswer: vi.fn(async (sdp: string) => {
      calls.push(`acceptAnswer:${sdp}`);
    }),
    addIceCandidate: vi.fn(async (c: DirectCandidate) => {
      calls.push(`ice:${c.candidate}`);
    }),
    onIceCandidate: (cb) => {
      cbs.ice.push(cb);
      return () => {};
    },
    onOpen: (cb) => {
      cbs.open.push(cb);
      return () => {};
    },
    onMessage: (cb) => {
      cbs.message.push(cb);
      return () => {};
    },
    onClose: (cb) => {
      cbs.close.push(cb);
      return () => {};
    },
    send: (b) => {
      if (closed) return false;
      sent.push(b);
      return true;
    },
    close: () => {
      closed = true;
      calls.push('close');
    },
  };
  return {
    peer,
    calls,
    sent,
    isClosed: () => closed,
    fire: {
      ice: (c: DirectCandidate) => {
        for (const f of cbs.ice) f(c);
      },
      open: () => {
        for (const f of cbs.open) f();
      },
      message: (b: Uint8Array) => {
        for (const f of cbs.message) f(b);
      },
      close: () => {
        for (const f of cbs.close) f();
      },
    },
  };
}

function harness(role: 'guest' | 'host', factoryNull = false) {
  const peers: ReturnType<typeof fakePeer>[] = [];
  const signals: DirectSignal[] = [];
  const frames: Uint8Array[] = [];
  const transports: string[] = [];
  let resyncs = 0;
  const link = new DirectLink({
    role,
    factory: factoryNull
      ? () => null
      : () => {
          const p = fakePeer();
          peers.push(p);
          return p.peer;
        },
    iceServers: [{ urls: ['stun:example'] }],
    sendSignal: (s) => signals.push(s),
    onFrame: (f) => frames.push(f),
    onTransportChange: (t) => transports.push(t),
    onResync: () => {
      resyncs += 1;
    },
  });
  return { link, peers, signals, frames, transports, resyncs: () => resyncs };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('DirectLink guest', () => {
  it('看到 host 能力 + 在线 → 建 peer、发 offer（gen 1）', async () => {
    const h = harness('guest');
    h.link.peerOnline(true);
    h.link.hostInfo({ capabilities: ['direct-v1'], iceServers: [{ urls: ['stun:x'] }] });
    await flush();
    expect(h.peers).toHaveLength(1);
    expect(h.signals).toEqual([{ type: 'direct-offer', gen: 1, sdp: 'offer-sdp' }]);
  });

  it('host 无能力 → 不建 peer、不发信令', async () => {
    const h = harness('guest');
    h.link.peerOnline(true);
    h.link.hostInfo({});
    await flush();
    expect(h.peers).toHaveLength(0);
    expect(h.signals).toEqual([]);
  });

  it('工厂返回 null（本端无 WebRTC）→ 不发信令', async () => {
    const h = harness('guest', true);
    h.link.peerOnline(true);
    h.link.hostInfo({ capabilities: ['direct-v1'] });
    await flush();
    expect(h.signals).toEqual([]);
  });

  it('本地候选过滤后转发（去 a=，拒 relay）；answer/ice 按 gen 应用', async () => {
    const h = harness('guest');
    h.link.peerOnline(true);
    h.link.hostInfo({ capabilities: ['direct-v1'] });
    await flush();
    const p = h.peers[0];
    p.fire.ice({ candidate: 'a=candidate:1 1 UDP 1 10.0.0.2 1 typ host', sdpMid: '0' });
    p.fire.ice({ candidate: 'candidate:2 1 UDP 1 1.2.3.4 1 typ relay', sdpMid: '0' });
    expect(h.signals.slice(1)).toEqual([
      {
        type: 'direct-ice',
        gen: 1,
        candidate: 'candidate:1 1 UDP 1 10.0.0.2 1 typ host',
        sdpMid: '0',
      },
    ]);
    h.link.handleSignal({ type: 'direct-answer', gen: 1, sdp: 'answer-sdp' });
    h.link.handleSignal({ type: 'direct-ice', gen: 9, candidate: 'stale', sdpMid: null });
    h.link.handleSignal({ type: 'direct-ice', gen: 1, candidate: 'candidate:ok', sdpMid: null });
    await flush();
    expect(p.calls).toEqual(['createOffer', 'acceptAnswer:answer-sdp', 'ice:candidate:ok']);
  });

  it('通道打开 → transport=direct + resync；send 走分片；收到分片拼帧回调', async () => {
    const h = harness('guest');
    h.link.peerOnline(true);
    h.link.hostInfo({ capabilities: ['direct-v1'] });
    await flush();
    const p = h.peers[0];
    expect(h.link.transport()).toBe('relay');
    p.fire.open();
    expect(h.link.transport()).toBe('direct');
    expect(h.transports).toEqual(['direct']);
    expect(h.resyncs()).toBe(1);

    const frame = new Uint8Array(20_000).fill(9);
    expect(h.link.send(frame)).toBe(true);
    expect(p.sent).toHaveLength(2);

    for (const c of encodeChunks(new Uint8Array([1, 2, 3]))) p.fire.message(c);
    expect(h.frames).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it('通道关闭 → 切回 relay、resync、退避后重新 offer（gen 2）', async () => {
    const h = harness('guest');
    h.link.peerOnline(true);
    h.link.hostInfo({ capabilities: ['direct-v1'] });
    await flush();
    h.peers[0].fire.open();
    h.peers[0].fire.close();
    expect(h.link.transport()).toBe('relay');
    expect(h.transports).toEqual(['direct', 'relay']);
    expect(h.peers[0].isClosed()).toBe(true);
    expect(h.link.send(new Uint8Array([1]))).toBe(false);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.peers).toHaveLength(2);
    expect(h.signals.at(-1)).toEqual({ type: 'direct-offer', gen: 2, sdp: 'offer-sdp' });
  });

  it('协商 15s 无果 → direct-close + 销毁 peer', async () => {
    const h = harness('guest');
    h.link.peerOnline(true);
    h.link.hostInfo({ capabilities: ['direct-v1'] });
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.signals.at(-1)).toEqual({ type: 'direct-close', gen: 1 });
    expect(h.peers[0].isClosed()).toBe(true);
  });

  it('心跳：25s 发 ping，10s 内无消息判死 → 切回 relay', async () => {
    const h = harness('guest');
    h.link.peerOnline(true);
    h.link.hostInfo({ capabilities: ['direct-v1'] });
    await flush();
    const p = h.peers[0];
    p.fire.open();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(p.sent.at(-1)).toEqual(new Uint8Array([0x02]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.link.transport()).toBe('relay');
    expect(p.isClosed()).toBe(true);
  });

  it('收到 ping 回 pong；pong 视为存活', async () => {
    const h = harness('guest');
    h.link.peerOnline(true);
    h.link.hostInfo({ capabilities: ['direct-v1'] });
    await flush();
    const p = h.peers[0];
    p.fire.open();
    p.fire.message(new Uint8Array([0x02]));
    expect(p.sent.at(-1)).toEqual(new Uint8Array([0x03]));
    await vi.advanceTimersByTimeAsync(25_000);
    p.fire.message(new Uint8Array([0x03]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.link.transport()).toBe('direct');
  });

  it('网络变化：拆旧代、发 close、立刻新一代 offer', async () => {
    const h = harness('guest');
    h.link.peerOnline(true);
    h.link.hostInfo({ capabilities: ['direct-v1'] });
    await flush();
    h.peers[0].fire.open();
    h.link.networkChange();
    await flush();
    expect(h.peers[0].isClosed()).toBe(true);
    expect(h.signals.slice(1)).toEqual([
      { type: 'direct-close', gen: 1 },
      { type: 'direct-offer', gen: 2, sdp: 'offer-sdp' },
    ]);
  });

  it('close() 后不再有任何定时器与信令', async () => {
    const h = harness('guest');
    h.link.peerOnline(true);
    h.link.hostInfo({ capabilities: ['direct-v1'] });
    await flush();
    h.link.close();
    const n = h.signals.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.signals.length).toBe(n);
    expect(h.peers[0].isClosed()).toBe(true);
  });
});

describe('DirectLink host', () => {
  it('收到 offer → 建 peer、回 answer；dc 打开 → direct', async () => {
    const h = harness('host');
    h.link.handleSignal({ type: 'direct-offer', gen: 1, sdp: 'offer-sdp' });
    await flush();
    expect(h.peers[0].calls).toEqual(['acceptOffer:offer-sdp']);
    expect(h.signals).toEqual([{ type: 'direct-answer', gen: 1, sdp: 'answer-sdp' }]);
    h.peers[0].fire.open();
    expect(h.link.transport()).toBe('direct');
  });

  it('更新的 offer 顶掉旧代；direct-close 释放', async () => {
    const h = harness('host');
    h.link.handleSignal({ type: 'direct-offer', gen: 1, sdp: 'a' });
    await flush();
    h.link.handleSignal({ type: 'direct-offer', gen: 2, sdp: 'b' });
    await flush();
    expect(h.peers[0].isClosed()).toBe(true);
    expect(h.peers[1].calls).toEqual(['acceptOffer:b']);
    h.link.handleSignal({ type: 'direct-close', gen: 2 });
    expect(h.peers[1].isClosed()).toBe(true);
    expect(h.link.transport()).toBe('relay');
  });
});
