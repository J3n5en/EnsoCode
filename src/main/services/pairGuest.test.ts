import type { NodeMessage } from '@shared/types/nodes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface TestSocket {
  readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  sent: Uint8Array[];
  send(data: ArrayBuffer): void;
  close(): void;
}

/**
 * 明文帧：1 字节版本 + 12 字节 nonce + JSON，与真实密文帧同布局。
 * 防重放只看 nonce 与载荷里的 replay 戳，换成明文后解密时序可控、断言确定。
 */
const frames = vi.hoisted(() => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    seal: async (
      _key: Uint8Array,
      payload: unknown,
      nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(12))
    ): Promise<Uint8Array> => {
      const body = encoder.encode(JSON.stringify(payload));
      const frame = new Uint8Array(13 + body.length);
      frame[0] = 1;
      frame.set(nonce, 1);
      frame.set(body, 13);
      return frame;
    },
    open: async (_key: Uint8Array, frame: Uint8Array): Promise<unknown> =>
      JSON.parse(decoder.decode(frame.subarray(13))),
  };
});

const mocks = vi.hoisted(() => ({
  sockets: [] as TestSocket[],
  /** 假直连是否可用；可用时业务帧走直连并记在 directSent */
  direct: false,
  directSent: [] as Uint8Array[],
  /** 依次挂在节点端每次解密上的闸门：放行前这一帧解不完（模拟大帧解密慢） */
  openGates: [] as Promise<void>[],
  node: {
    pairId: 'node-1',
    nodeId: 'node-1',
    label: 'node',
    token: 'token-1',
    contentKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    deviceName: 'guest-mac',
    relayUrl: 'https://relay.example.com',
    pairedAt: 1,
  },
}));

function makeSocket(): TestSocket {
  const socket: TestSocket = {
    readyState: 0,
    binaryType: '',
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    sent: [],
    send(data) {
      socket.sent.push(new Uint8Array(data));
    },
    close() {
      socket.readyState = 3;
    },
  };
  return socket;
}

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
    hostInfo(): void {}
    handleSignal(): void {}
    networkChange(): void {}
    noteRelayRtt(): void {}
    close(): void {}
  }
  return {
    ...original,
    attachHeartbeat: () => ({ stop: vi.fn(), probe: vi.fn() }),
    DirectLink: FakeDirectLink,
    createFrameReplay: () =>
      original.createFrameReplay(frames.seal, async (key, frame) => {
        const gate = mocks.openGates.shift();
        if (gate) await gate;
        return frames.open(key, frame);
      }),
  };
});
vi.mock('./pairDirectConfig', () => ({ PAIR_DIRECT_ENABLED: false, PAIR_STUN_SERVERS: [] }));
vi.mock('./pairDirectPeer', () => ({
  isDirectPeerAvailable: () => false,
  mainDirectPeerFactory: null,
  preloadDirectPeer: () => Promise.resolve(),
}));
vi.mock('./pairNetworkWatch', () => ({ startPairNetworkWatch: () => vi.fn() }));
vi.mock('./pairRelayLookup', () => ({ seedRelayHostCache: vi.fn() }));
vi.mock('./pairRelayOpen', () => ({
  openPairRelayWebSocket: () => {
    const socket = makeSocket();
    mocks.sockets.push(socket);
    return Promise.resolve(socket);
  },
}));
vi.mock('./pairStore', () => ({ loadRelayHostCache: () => null }));
vi.mock('./nodeStore', () => ({
  adoptHostname: (nodes: unknown) => nodes,
  loadNodes: () => [mocks.node],
  removeNode: (nodes: unknown) => nodes,
  renameNode: (nodes: unknown) => nodes,
  saveNodes: vi.fn(),
  upsertNode: (nodes: unknown) => nodes,
}));

import {
  isPairClaimRejected,
  sendToNode,
  setNodesMessageListener,
  startPairGuest,
  stopPairGuest,
} from './pairGuest';

const key = new Uint8Array(32);

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function openSocket(socket: TestSocket): void {
  socket.readyState = 1;
  socket.onopen?.();
}

function control(socket: TestSocket, type: string): void {
  socket.onmessage?.({ data: JSON.stringify({ type }) });
}

function deliver(socket: TestSocket, frame: Uint8Array): void {
  socket.onmessage?.({ data: frame.slice().buffer });
}

const NODE_ID = mocks.node.nodeId;
let received: NodeMessage[] = [];

beforeEach(async () => {
  vi.useFakeTimers();
  mocks.sockets = [];
  mocks.direct = false;
  mocks.directSent = [];
  mocks.openGates = [];
  received = [];
  setNodesMessageListener((message) => received.push(message));
  startPairGuest();
  await flush();
  expect(mocks.sockets).toHaveLength(1);
});

afterEach(() => {
  stopPairGuest();
  vi.useRealTimers();
});

async function sentSubscribes(socket: TestSocket): Promise<unknown[]> {
  const payloads = await Promise.all(socket.sent.map((frame) => frames.open(key, frame)));
  return payloads.filter((payload) => (payload as { type?: string }).type === 'subscribe');
}

describe('pairGuest 收帧顺序', () => {
  // 真实场景：大快照后紧跟 status / upsert，各帧并发解密时小帧先解完被先应用，随后快照把状态盖回旧值
  it('先到的大帧解密慢时，后到的小帧也要等它应用完再应用', async () => {
    const socket = mocks.sockets[0];
    openSocket(socket);
    let release!: () => void;
    mocks.openGates.push(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    deliver(
      socket,
      await frames.seal(key, { type: 'agent-event', event: { type: 'snapshot', sessions: [] } })
    );
    deliver(
      socket,
      await frames.seal(key, {
        type: 'agent-event',
        event: { type: 'status', sessionId: 's1', status: 'idle' },
      })
    );
    await flush();
    release();
    await flush();
    expect(
      received.map((message) => (message.payload as { event: { type: string } }).event.type)
    ).toEqual(['snapshot', 'status']);
  });
});

describe('pairGuest host 重新进房', () => {
  // 真实场景：host 新连接顶替半开旧连接时中继只发 host-online、不发 host-offline，host 进房已清空本设备订阅；
  // 在线态没经历 false→true，渲染层不会重订阅，节点正在看的会话正文冻结
  it('host 重新进房只来 host-online 时补发最后一次订阅', async () => {
    const socket = mocks.sockets[0];
    openSocket(socket);
    control(socket, 'host-online');
    await sendToNode(NODE_ID, { type: 'subscribe', sessionId: 's1', sinceIndex: 3 });
    await flush();
    expect(await sentSubscribes(socket)).toHaveLength(1);
    control(socket, 'host-online');
    await flush();
    const subscribes = await sentSubscribes(socket);
    expect(subscribes).toHaveLength(2);
    expect(subscribes[1]).toMatchObject({ type: 'subscribe', sessionId: 's1' });
  });

  // host 掉线再上线（或节点重连后的首条 host-online）在线态 false→true，渲染层会带最新游标重订阅，main 不重复补发
  it('在线态 false→true 的 host-online 不由 main 重复补发订阅', async () => {
    const socket = mocks.sockets[0];
    openSocket(socket);
    control(socket, 'host-online');
    await sendToNode(NODE_ID, { type: 'subscribe', sessionId: 's1', sinceIndex: 3 });
    await flush();
    control(socket, 'host-offline');
    control(socket, 'host-online');
    await flush();
    expect(await sentSubscribes(socket)).toHaveLength(1);
  });
});

describe('pairGuest 中继重连与防重放', () => {
  // 真实场景：同局域网已直连，中继宕机/外网断时节点反复重连中继；每次重连尝试都重置防重放，
  // 经直连发的命令退回随机 nonce 且不带回声，仍锁定旧前缀的 host 静默丢弃，界面却显示在线
  it('中继重连期间经直连发的命令仍被已锁定的 host 接收，重放旧帧仍被拒', async () => {
    const pair = await vi.importActual<typeof import('@enso/pair')>('@enso/pair');
    const host = pair.createFrameReplay(frames.seal, frames.open);
    const socket = mocks.sockets[0];
    openSocket(socket);
    control(socket, 'host-online');
    await flush();
    // 握手：host 从进房 snapshot 学到质询；节点收到带回声的帧后回 replay-hello，双方锁定
    for (const frame of socket.sent) await host.open(key, frame);
    deliver(socket, await host.seal(key, { type: 'catalog', entries: [] }));
    await flush();
    const hello = socket.sent.at(-1) as Uint8Array;
    expect(await host.open(key, hello)).toEqual({ type: 'replay-hello' });

    mocks.direct = true;
    socket.readyState = 3;
    socket.onclose?.({ code: 1006 });
    await flush();
    expect(mocks.sockets).toHaveLength(2);
    await sendToNode(NODE_ID, { type: 'prompt', sessionId: 's1', text: 'hi' });
    const prompt = mocks.directSent.at(-1) as Uint8Array;
    expect(await host.open(key, prompt)).toMatchObject({ type: 'prompt', text: 'hi' });
    // 防重放不能被削弱：同一帧再到、握手阶段的旧帧再到都要丢
    expect(await host.open(key, prompt)).toBeUndefined();
    expect(await host.open(key, hello)).toBeUndefined();
  });
});

describe('isPairClaimRejected', () => {
  // 中继清掉过期配对码后，晚到的认领拿到 409 `no pending pair`；postJson 只抛这句文案，
  // 判成网络不可达会让用户以为中继挂了，而实际是链接已失效
  it('配对码过期被清理后的 no pending pair 按链接失效处理', () => {
    expect(isPairClaimRejected('no pending pair')).toBe(true);
  });

  it('网络层失败仍按中继不可达处理', () => {
    expect(isPairClaimRejected('fetch failed')).toBe(false);
    expect(isPairClaimRejected('The operation was aborted due to timeout')).toBe(false);
  });
});
