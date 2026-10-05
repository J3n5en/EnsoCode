import {
  type DirectPeer,
  decodeVoiceChunk,
  openFrame,
  type PairedDevice,
  type PhoneToHost,
} from '@enso/pair';
import { emptyGuestView } from '@shared/pair/guestProjection';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ClientEvents, PairClient } from './client';
import type { PhoneCacheData, PhoneCacheStore } from './sessionCache';

vi.mock('./theme', () => ({ setHostTheme: vi.fn() }));
vi.mock('./stubs/settings-store', () => ({
  setCompactReadOnlyTools: vi.fn(),
  setExpandLiveEdits: vi.fn(),
  setTerminalAppearance: vi.fn(),
}));
vi.mock('@enso/pair', async (original) => ({
  ...(await original<typeof import('@enso/pair')>()),
  sealFrame: async (_key: unknown, payload: unknown) =>
    new TextEncoder().encode(JSON.stringify(payload)),
  openFrame: vi.fn(async (_key: unknown, frame: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(frame))
  ),
  attachHeartbeat: () => ({ stop() {}, probe() {} }),
}));

class Socket {
  static all: Socket[] = [];
  readyState = 0;
  binaryType = '';
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;
  onmessage?: (event: { data: ArrayBuffer | string }) => void;
  sent: PhoneToHost[] = [];
  constructor() {
    Socket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(frame: ArrayBuffer) {
    this.sent.push(JSON.parse(new TextDecoder().decode(frame)));
  }
  receive(payload: unknown) {
    this.onmessage?.({ data: new TextEncoder().encode(JSON.stringify(payload)).buffer });
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const device: PairedDevice = {
  pairId: 'desktop-a',
  token: 'token',
  contentKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  relayUrl: 'https://relay.test',
  deviceName: 'Desktop',
  pairedAt: 1,
};
const text = (value: string) => ({
  role: 'user' as const,
  content: [{ type: 'text' as const, text: value }],
});
const cursor = { epoch: 'epoch-a', seq: 0 };
function cached(): PhoneCacheData {
  return {
    catalog: [{ id: 's', title: 'Cached', projectId: 'p', projectName: 'Project', status: 'idle' }],
    pinnedOrder: ['s'],
    projects: [{ id: 'p', name: 'Project', path: '/project' }],
    projectGroups: [],
    providers: [],
    sessions: [
      { id: 's', view: { ...emptyGuestView(), messages: new Map([[0, text('old')]]) }, cursor },
    ],
  };
}

async function settle() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

function stubDirectPeer(): DirectPeer {
  return {
    createOffer: async () => 'offer-sdp',
    acceptOffer: async () => 'answer-sdp',
    acceptAnswer: async () => {},
    addIceCandidate: async () => {},
    onIceCandidate: () => () => {},
    onOpen: () => () => {},
    onMessage: () => () => {},
    onClose: () => () => {},
    send: () => true,
    close() {},
  };
}

function liveDirectPeer() {
  let onOpen = (): void => {};
  let onMessage = (_bytes: Uint8Array): void => {};
  const peer: DirectPeer = {
    createOffer: async () => 'offer-sdp',
    acceptOffer: async () => 'answer-sdp',
    acceptAnswer: async () => {},
    addIceCandidate: async () => {},
    onIceCandidate: () => () => {},
    onOpen: (cb) => {
      onOpen = cb;
      return () => {};
    },
    onMessage: (cb) => {
      onMessage = cb;
      return () => {};
    },
    onClose: () => () => {},
    send: () => true,
    close() {},
  };
  return {
    peer,
    fireOpen: () => onOpen(),
    fireMessage: (bytes: Uint8Array) => onMessage(bytes),
  };
}

describe('PairClient 缓存与续传', () => {
  let client: PairClient;
  let cache: PhoneCacheStore;
  let events: ClientEvents;
  beforeEach(() => {
    vi.useFakeTimers();
    Socket.all = [];
    vi.stubGlobal('WebSocket', Socket);
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    cache = {
      load: vi.fn(async () => cached()),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };
    events = {
      onState: vi.fn(),
      onCatalog: vi.fn(),
      onProjects: vi.fn(),
      onProviders: vi.fn(),
      onSession: vi.fn(),
      onSync: vi.fn(),
      onGhostSession: vi.fn(),
    };
    client = new PairClient(device, events, null, cache);
  });
  afterEach(() => {
    client.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function start() {
    client.connect();
    client.subscribe('s');
    await settle();
    const socket = Socket.all[0];
    socket.open();
    await settle();
    return socket;
  }
  function subscription(socket: Socket) {
    const command = socket.sent.filter((item) => item.type === 'subscribe').at(-1);
    expect(command?.type).toBe('subscribe');
    if (command?.type !== 'subscribe') throw new Error('Missing subscription');
    return command;
  }
  function replay(socket: Socket, seq = 0, replayEvents: unknown[] = []) {
    socket.receive({
      type: 'session-sync',
      sessionId: 's',
      requestId: subscription(socket).sync?.requestId,
      mode: 'replay',
      fromSeq: 0,
      cursor: { ...cursor, seq },
      events: replayEvents,
    });
  }

  it('网络未恢复也先显示缓存目录和正文，正文与游标一起续传', async () => {
    const socket = await start();
    expect(events.onCatalog).toHaveBeenCalledWith(cached().catalog, ['s']);
    expect(client.getSession('s')?.messages.get(0)).toEqual(text('old'));
    expect(subscription(socket).sync?.cursor).toEqual(cursor);
    expect(events.onSync).toHaveBeenLastCalledWith('syncing');
    expect(events.onSession).toHaveBeenCalledWith(
      's',
      expect.objectContaining({ messages: expect.any(Map) })
    );
  });

  it('零增量即完成同步，不再等待或请求快照', async () => {
    const socket = await start();
    const count = socket.sent.length;
    replay(socket);
    await settle();
    expect(events.onSync).toHaveBeenLastCalledWith('synced');
    expect(socket.sent).toHaveLength(count);
    expect(client.getSession('s')?.messages.get(0)).toEqual(text('old'));
  });

  it('同一消息下标的更新和截断按事件序号补齐，并原子保存新游标', async () => {
    const socket = await start();
    replay(socket, 3, [
      { type: 'message-upsert', sessionId: 's', index: 0, message: text('updated') },
      { type: 'message-upsert', sessionId: 's', index: 1, message: text('removed') },
      { type: 'messages-truncated', sessionId: 's', length: 1 },
    ]);
    await settle();
    expect([...(client.getSession('s')?.messages ?? [])]).toEqual([[0, text('updated')]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cache.save).toHaveBeenCalledWith(
      device.pairId,
      expect.objectContaining({
        sessions: [
          expect.objectContaining({
            id: 's',
            cursor: { ...cursor, seq: 3 },
            view: expect.objectContaining({ messages: new Map([[0, text('updated')]]) }),
          }),
        ],
      })
    );
  });

  it('丢弃重复live事件，序号断档只重订阅一次且保留旧内容', async () => {
    const socket = await start();
    replay(socket);
    await settle();
    const event = {
      type: 'agent-event',
      cursor: { ...cursor, seq: 1 },
      event: {
        type: 'ask-request',
        sessionId: 's',
        ask: { requestId: 'ask', question: 'Continue?' },
      },
    };
    socket.receive(event);
    socket.receive(event);
    await settle();
    expect(client.getSession('s')?.asks).toHaveLength(1);
    const before = socket.sent.filter((item) => item.type === 'subscribe').length;
    socket.receive({ ...event, cursor: { ...cursor, seq: 3 } });
    socket.receive({ ...event, cursor: { ...cursor, seq: 4 } });
    await settle();
    expect(socket.sent.filter((item) => item.type === 'subscribe')).toHaveLength(before + 1);
    expect(subscription(socket).sync?.cursor).toEqual({ ...cursor, seq: 1 });
    expect(client.getSession('s')?.messages.get(0)).toEqual(text('old'));
  });

  it('切会话后旧同步应答不得覆盖新订阅或解除同步中', async () => {
    const socket = await start();
    const oldId = subscription(socket).sync?.requestId;
    client.subscribe('other');
    await settle();
    socket.receive({
      type: 'session-sync',
      sessionId: 's',
      requestId: oldId,
      mode: 'replay',
      fromSeq: 0,
      cursor,
      events: [],
    });
    await settle();
    expect(events.onSync).toHaveBeenLastCalledWith('syncing');
  });

  it('只有旧localStorage消息游标而没有正文时，不能假装可续传', async () => {
    vi.mocked(cache.load).mockResolvedValue(null);
    localStorage.setItem(`enso-phone-cursors:${device.pairId}`, JSON.stringify({ s: 900 }));
    const socket = await start();
    expect(subscription(socket).sinceIndex).toBeUndefined();
    expect(subscription(socket).sync?.cursor).toBeUndefined();
    socket.receive({
      type: 'agent-event',
      event: {
        type: 'snapshot',
        sessions: [{ sessionId: 's', baseIndex: 0, messages: [text('legacy')] }],
      },
    });
    await settle();
    expect(client.getSession('s')?.messages.get(0)).toEqual(text('legacy'));
    expect(events.onSync).toHaveBeenLastCalledWith('synced');
  });

  it('缓存加载中关闭客户端，迟到的缓存不能上墙或重建连接', async () => {
    let resolve!: (value: PhoneCacheData) => void;
    vi.mocked(cache.load).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    client.connect();
    client.close();
    resolve(cached());
    await settle();
    expect(events.onSession).not.toHaveBeenCalled();
    expect(Socket.all).toHaveLength(0);
  });

  it('桌面撤销配对会删除缓存并阻止节流写入复活数据', async () => {
    const socket = await start();
    replay(socket);
    await settle();
    socket.onmessage?.({ data: JSON.stringify({ type: 'revoked' }) });
    await settle();
    const saves = vi.mocked(cache.save).mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cache.clear).toHaveBeenCalledWith(device.pairId);
    expect(cache.save).toHaveBeenCalledTimes(saves);
    expect(events.onState).toHaveBeenLastCalledWith('unauthorized');
  });

  it('新epoch快照替换旧缓存，不能混入上一代的历史前缀', async () => {
    const socket = await start();
    socket.receive({
      type: 'session-sync',
      sessionId: 's',
      requestId: subscription(socket).sync?.requestId,
      mode: 'snapshot',
      cursor: { epoch: 'new-epoch', seq: 0 },
      snapshot: {
        type: 'snapshot',
        sessions: [{ sessionId: 's', baseIndex: 1, messages: [text('new branch')] }],
      },
    });
    await settle();
    expect([...(client.getSession('s')?.messages ?? [])]).toEqual([[1, text('new branch')]]);
    expect(events.onSync).toHaveBeenLastCalledWith('synced');
  });

  it('resume 空快照不能清掉缓存正文，避免打开 PWA 只剩正在读取历史', async () => {
    const socket = await start();
    const requestId = subscription(socket).sync?.requestId;
    socket.receive({
      type: 'session-sync',
      sessionId: 's',
      requestId,
      mode: 'snapshot',
      cursor: { epoch: 'resume-epoch', seq: 0 },
      snapshot: {
        type: 'snapshot',
        sessions: [{ sessionId: 's', baseIndex: 0, messages: [], status: 'running' }],
      },
    });
    await settle();
    expect(client.getSession('s')?.messages.get(0)).toEqual(text('old'));
    expect(client.getSession('s')?.status).toBe('running');
    expect(events.onSession).toHaveBeenCalledWith(
      's',
      expect.objectContaining({ messages: expect.any(Map) })
    );
  });

  it('旧端空 snapshot 事件也不能把已上墙的缓存清成加载态', async () => {
    const socket = await start();
    replay(socket);
    await settle();
    socket.receive({
      type: 'agent-event',
      event: {
        type: 'snapshot',
        sessions: [{ sessionId: 's', baseIndex: 0, messages: [], status: 'running' }],
      },
    });
    await settle();
    expect(client.getSession('s')?.messages.get(0)).toEqual(text('old'));
  });

  it('异步解密串行归并，较快的后帧不能越过前帧触发假断档', async () => {
    const socket = await start();
    replay(socket);
    await settle();
    let release!: (event: unknown) => void;
    vi.mocked(openFrame).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const first = {
      type: 'agent-event',
      cursor: { ...cursor, seq: 1 },
      event: { type: 'message-upsert', sessionId: 's', index: 0, message: text('first') },
    };
    socket.receive(first);
    socket.receive({
      type: 'agent-event',
      cursor: { ...cursor, seq: 2 },
      event: { type: 'message-upsert', sessionId: 's', index: 0, message: text('last') },
    });
    await settle();
    release(first);
    await settle();
    expect(client.getSession('s')?.messages.get(0)).toEqual(text('last'));
    expect(events.onSync).toHaveBeenLastCalledWith('synced');
  });

  it('权威目录删除会话，同时删除缓存正文而不保留幽灵会话', async () => {
    const socket = await start();
    socket.receive({ type: 'catalog', entries: [] });
    await settle();
    expect(client.getSession('s')).toBeUndefined();
    expect(events.onGhostSession).toHaveBeenCalledWith('s');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cache.save).toHaveBeenLastCalledWith(
      device.pairId,
      expect.objectContaining({ sessions: [] })
    );
  });

  it('缓存不可用仍建立连接，以无游标快照恢复', async () => {
    vi.mocked(cache.load).mockRejectedValue(new Error('storage denied'));
    const socket = await start();
    expect(subscription(socket).sync).toEqual({ requestId: expect.any(String) });
  });

  it('截断早于缓存尾窗时回退快照，不能把剩余历史误显示为空', async () => {
    const data = cached();
    data.sessions[0].view.messages = new Map([[100, text('tail')]]);
    vi.mocked(cache.load).mockResolvedValue(data);
    const socket = await start();
    replay(socket, 1, [{ type: 'messages-truncated', sessionId: 's', length: 80 }]);
    await settle();
    expect(subscription(socket).sync?.cursor).toBeUndefined();
    expect(events.onSync).toHaveBeenLastCalledWith('syncing');
    expect(client.getSession('s')?.messages.get(100)).toEqual(text('tail'));
  });

  it('手机刚新建的会话沿用实时订阅，不因尚无快照而吞掉首轮事件', async () => {
    const socket = await start();
    client.subscribe('fresh', { fresh: true });
    await settle();
    expect(subscription(socket).sync).toBeUndefined();
    client.subscribe('fresh');
    await settle();
    expect(subscription(socket).sync).toBeUndefined();
    socket.receive({
      type: 'agent-event',
      event: { type: 'message-upsert', sessionId: 'fresh', index: 0, message: text('first turn') },
    });
    await settle();
    expect(events.onSync).toHaveBeenLastCalledWith('synced');
    expect(client.getSession('fresh')?.messages.get(0)).toEqual(text('first turn'));
  });

  it('新建会话收到带 cursor 的事件时升级为同步协议，而不是空转重订阅', async () => {
    const socket = await start();
    client.subscribe('fresh', { fresh: true });
    await settle();
    const before = socket.sent.filter((item) => item.type === 'subscribe').length;
    const live = {
      type: 'agent-event',
      cursor: { epoch: 'fresh-epoch', seq: 1 },
      event: { type: 'message-upsert', sessionId: 'fresh', index: 0, message: text('first turn') },
    };
    socket.receive(live);
    socket.receive(live);
    await settle();
    expect(socket.sent.filter((item) => item.type === 'subscribe')).toHaveLength(before + 1);
    expect(subscription(socket).sync).toEqual({ requestId: expect.any(String) });
  });

  it('会话失效通知用新 epoch 触发一次重订阅，并带上旧游标', async () => {
    const socket = await start();
    replay(socket);
    await settle();
    const before = socket.sent.filter((item) => item.type === 'subscribe').length;
    socket.receive({
      type: 'agent-event',
      cursor: { epoch: 'epoch-b', seq: 0 },
      event: { type: 'session-invalidated', sessionId: 's' },
    });
    await settle();
    expect(socket.sent.filter((item) => item.type === 'subscribe')).toHaveLength(before + 1);
    expect(subscription(socket).sync?.cursor).toEqual(cursor);
  });

  it('切换传输通道时live抢在同步应答前到达，补拉未被应答覆盖的末条事件', async () => {
    const socket = await start();
    const requestId = subscription(socket).sync?.requestId;
    socket.receive({
      type: 'agent-event',
      cursor: { ...cursor, seq: 1 },
      event: { type: 'message-upsert', sessionId: 's', index: 0, message: text('raced') },
    });
    replay(socket);
    await settle();
    expect(subscription(socket).sync?.requestId).not.toBe(requestId);
    expect(subscription(socket).sync?.cursor).toEqual(cursor);
    expect(events.onSync).toHaveBeenLastCalledWith('syncing');
    replay(socket, 1, [
      { type: 'message-upsert', sessionId: 's', index: 0, message: text('raced') },
    ]);
    await settle();
    expect(client.getSession('s')?.messages.get(0)).toEqual(text('raced'));
    expect(events.onSync).toHaveBeenLastCalledWith('synced');
  });

  it('同步应答已覆盖提前到达的live事件，不重复订阅形成追赶循环', async () => {
    const socket = await start();
    const requestId = subscription(socket).sync?.requestId;
    const event = { type: 'message-upsert', sessionId: 's', index: 0, message: text('covered') };
    socket.receive({ type: 'agent-event', cursor: { ...cursor, seq: 1 }, event });
    replay(socket, 1, [event]);
    await settle();
    expect(subscription(socket).sync?.requestId).toBe(requestId);
    expect(client.getSession('s')?.messages.get(0)).toEqual(text('covered'));
    expect(events.onSync).toHaveBeenLastCalledWith('synced');
  });

  it('同步应答丢失时以同一requestId重试，成功后停止重试', async () => {
    const socket = await start();
    const command = subscription(socket);
    const count = socket.sent.filter((item) => item.type === 'subscribe').length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.sent.filter((item) => item.type === 'subscribe')).toHaveLength(count + 1);
    expect(subscription(socket)).toEqual(command);
    replay(socket);
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.sent.filter((item) => item.type === 'subscribe')).toHaveLength(count + 1);
    expect(events.onSync).toHaveBeenLastCalledWith('synced');
  });

  it('仅展示旧缓存不重复写盘；前后台重复flush不刷新过期时间', async () => {
    await start();
    client.flushCache();
    client.flushCache();
    await settle();
    expect(cache.save).not.toHaveBeenCalled();
  });

  it('幽灵会话的残留live帧不能重新订阅已删除会话', async () => {
    const socket = await start();
    socket.receive({ type: 'catalog', entries: [] });
    await settle();
    socket.receive({
      type: 'agent-event',
      cursor: { ...cursor, seq: 1 },
      event: { type: 'status', sessionId: 's', status: 'idle' },
    });
    await settle();
    expect(subscription(socket).sessionId).toBeNull();
    expect(client.getSession('s')).toBeUndefined();
  });

  it('onopen 已进房后 host-online 不再重复 snapshot/subscribe', async () => {
    const socket = await start();
    const before = socket.sent.map((item) => item.type);
    expect(before.filter((type) => type === 'snapshot')).toHaveLength(1);
    expect(before.filter((type) => type === 'subscribe')).toHaveLength(1);
    socket.onmessage?.({ data: JSON.stringify({ type: 'host-online' }) });
    await settle();
    expect(socket.sent.filter((item) => item.type === 'snapshot')).toHaveLength(1);
    expect(socket.sent.filter((item) => item.type === 'subscribe')).toHaveLength(1);
  });

  it('host 掉线后再上线才重新 snapshot/subscribe', async () => {
    const socket = await start();
    socket.onmessage?.({ data: JSON.stringify({ type: 'host-offline' }) });
    await settle();
    socket.onmessage?.({ data: JSON.stringify({ type: 'host-online' }) });
    await settle();
    expect(socket.sent.filter((item) => item.type === 'snapshot')).toHaveLength(2);
    expect(socket.sent.filter((item) => item.type === 'subscribe')).toHaveLength(2);
  });

  it('后台超过阈值回前台立即换 socket，不等 ping', async () => {
    const socket = await start();
    client.conceal();
    await vi.advanceTimersByTimeAsync(2_000);
    client.nudge('visibility');
    await settle();
    expect(socket.readyState).toBe(3);
    expect(Socket.all).toHaveLength(2);
  });

  it('短暂切后台只探活，不拆还 OPEN 的 socket', async () => {
    const socket = await start();
    client.conceal();
    await vi.advanceTimersByTimeAsync(200);
    client.nudge('visibility');
    await settle();
    expect(socket.readyState).toBe(1);
    expect(Socket.all).toHaveLength(1);
  });

  it('已经 CONNECTING 时回前台不另开一条', async () => {
    client.connect();
    await settle();
    expect(Socket.all).toHaveLength(1);
    expect(Socket.all[0].readyState).toBe(0);
    client.conceal();
    await vi.advanceTimersByTimeAsync(2_000);
    client.nudge('visibility');
    await settle();
    expect(Socket.all).toHaveLength(1);
  });

  it('后台过阈值回前台：直连 offer 等新中继就绪再发，不丢在旧 socket', async () => {
    client.close();
    client = new PairClient(device, events, () => stubDirectPeer(), cache);
    const socket = await start();
    socket.onmessage?.({ data: JSON.stringify({ type: 'host-online' }) });
    socket.receive({ type: 'host-info', capabilities: ['direct-v1'], iceServers: [] });
    await settle();
    const offersOnOld = socket.sent.filter((item) => item.type === 'direct-offer');
    expect(offersOnOld).not.toHaveLength(0);

    client.conceal();
    await vi.advanceTimersByTimeAsync(2_000);
    client.nudge('visibility');
    await settle();
    expect(Socket.all).toHaveLength(2);
    expect(socket.sent.filter((item) => item.type === 'direct-offer')).toHaveLength(
      offersOnOld.length
    );

    const next = Socket.all[1];
    next.open();
    next.onmessage?.({ data: JSON.stringify({ type: 'host-online' }) });
    await settle();
    expect(next.sent.filter((item) => item.type === 'direct-offer')).not.toHaveLength(0);
  });

  it('直连 RTT 明显差于中继时发 probe 并钉在中继', async () => {
    client.close();
    const live = liveDirectPeer();
    client = new PairClient(device, events, () => live.peer, cache);
    const socket = await start();
    socket.onmessage?.({ data: JSON.stringify({ type: 'host-online' }) });
    socket.receive({ type: 'host-info', capabilities: ['direct-v1'], iceServers: [] });
    await settle();
    vi.setSystemTime(10_000);
    live.fireOpen();
    await settle();
    const probe = socket.sent.filter((item) => item.type === 'probe').at(-1);
    expect(probe?.type).toBe('probe');
    if (probe?.type !== 'probe') throw new Error('missing probe');
    vi.setSystemTime(10_025);
    socket.receive({ type: 'probe-ack', nonce: probe.nonce });
    await settle();
    vi.setSystemTime(10_120);
    live.fireMessage(new Uint8Array([0x03]));
    await settle();
    expect(client.transport()).toBe('relay');
    expect(socket.sent.some((item) => item.type === 'direct-close')).toBe(true);
  });

  it('host-info 声明 voiceInput 才可用，主机离线即不可用', async () => {
    const onVoiceInput = vi.fn();
    events.onVoiceInput = onVoiceInput;
    const socket = await start();
    socket.onmessage?.({ data: JSON.stringify({ type: 'host-online' }) });
    socket.receive({ type: 'host-info', hostname: 'h', appVersion: '1', voiceInput: true });
    await settle();
    expect(onVoiceInput).toHaveBeenLastCalledWith(true);
    socket.receive({ type: 'host-info', hostname: 'h', appVersion: '1' });
    await settle();
    expect(onVoiceInput).toHaveBeenLastCalledWith(false);
    socket.receive({ type: 'host-info', hostname: 'h', appVersion: '1', voiceInput: true });
    await settle();
    socket.onmessage?.({ data: JSON.stringify({ type: 'host-offline' }) });
    expect(onVoiceInput).toHaveBeenLastCalledWith(false);
  });

  it('host-info 声明 readOnly 即只读，缺省（旧桌面或已切回可操作）不是只读', async () => {
    const onReadOnly = vi.fn();
    events.onReadOnly = onReadOnly;
    const socket = await start();
    socket.onmessage?.({ data: JSON.stringify({ type: 'host-online' }) });
    socket.receive({ type: 'host-info', hostname: 'h', appVersion: '1', readOnly: true });
    await settle();
    expect(onReadOnly).toHaveBeenLastCalledWith(true);
    socket.receive({ type: 'host-info', hostname: 'h', appVersion: '1' });
    await settle();
    expect(onReadOnly).toHaveBeenLastCalledWith(false);
  });

  it('写命令被 host 以只读拒绝时回报给上层', async () => {
    const onCommandRejected = vi.fn();
    events.onCommandRejected = onCommandRejected;
    const socket = await start();
    socket.receive({ type: 'command-rejected', command: 'task-stop', error: 'read-only' });
    await settle();
    expect(onCommandRejected).toHaveBeenCalledWith('task-stop', 'read-only');
  });

  function voiceChunks(socket: Socket) {
    return socket.sent.flatMap((item) => (item.type === 'voice-chunk' ? [item] : []));
  }
  const samples = (count: number) => new Float32Array(count).fill(0.1);
  const lengthOf = (data: string) => decodeVoiceChunk(data)?.length;

  it('startVoice 满 200ms 立即发一块；finish 时恰好没有余量就补一小段静音作为 last', async () => {
    const socket = await start();
    const voice = client.startVoice(() => {});
    voice.push(samples(3000));
    await settle();
    expect(voiceChunks(socket)).toHaveLength(0);
    voice.push(samples(400));
    await settle();
    expect(voiceChunks(socket).map((c) => [c.index, lengthOf(c.data), c.last])).toEqual([
      [0, 3200, undefined],
    ]);
    voice.push(samples(3000));
    await settle();
    expect(voiceChunks(socket)).toHaveLength(2);
    const pending = voice.finish();
    await settle();
    const sent = voiceChunks(socket);
    expect(sent.map((c) => [c.index, lengthOf(c.data), c.last])).toEqual([
      [0, 3200, undefined],
      [1, 3200, undefined],
      [2, 160, true],
    ]);
    expect(new Set(sent.map((c) => c.requestId)).size).toBe(1);
    socket.receive({ type: 'voice-result', requestId: 'other', text: 'x' });
    socket.receive({ type: 'voice-result', requestId: sent[0].requestId, text: '你好' });
    await settle();
    await expect(pending).resolves.toEqual({ ok: true, text: '你好' });
  });

  it('不足一块也发出带 last 的非空块；无采样直接 invalid-audio', async () => {
    const socket = await start();
    const short = client.startVoice(() => {});
    short.push(samples(10));
    void short.finish();
    await settle();
    expect(voiceChunks(socket).map((c) => [c.index, lengthOf(c.data), c.last])).toEqual([
      [0, 10, true],
    ]);
    const empty = client.startVoice(() => {});
    await expect(empty.finish()).resolves.toEqual({ ok: false, error: 'invalid-audio' });
    expect(voiceChunks(socket)).toHaveLength(1);
  });

  it('超过时长上限的采样被丢弃，finish 报 invalid-audio 并通知桌面取消', async () => {
    const socket = await start();
    const voice = client.startVoice(() => {});
    voice.push(samples(16_000 * 300));
    voice.push(samples(1));
    await expect(voice.finish()).resolves.toEqual({ ok: false, error: 'invalid-audio' });
    // 1500 块排在发送队列里，多轮冲刷
    for (let i = 0; i < 200; i++) await settle();
    expect(voiceChunks(socket)).toHaveLength(1500);
    expect(voiceChunks(socket).some((c) => c.last)).toBe(false);
    const cancel = socket.sent.find((item) => item.type === 'voice-cancel');
    expect(cancel).toEqual({ type: 'voice-cancel', requestId: voiceChunks(socket)[0].requestId });
  });

  it('voice-partial 回调到对应会话，结果到达后不再回调', async () => {
    const socket = await start();
    const a = vi.fn();
    const b = vi.fn();
    const va = client.startVoice(a);
    client.startVoice(b).push(samples(10));
    va.push(samples(6400));
    await settle();
    const id = voiceChunks(socket)[0].requestId;
    socket.receive({ type: 'voice-partial', requestId: id, text: '你' });
    socket.receive({ type: 'voice-partial', requestId: 'other', text: 'x' });
    await settle();
    expect(a.mock.calls).toEqual([['你', false]]);
    const pending = va.finish();
    socket.receive({ type: 'voice-partial', requestId: id, text: '你好', correcting: true });
    socket.receive({ type: 'voice-result', requestId: id, text: '你好。' });
    socket.receive({ type: 'voice-partial', requestId: id, text: '迟到' });
    await settle();
    await expect(pending).resolves.toEqual({ ok: true, text: '你好。' });
    expect(a.mock.calls).toEqual([
      ['你', false],
      ['你好', true],
    ]);
    expect(b).not.toHaveBeenCalled();
  });

  it('cancel 发 voice-cancel 并停止上传，未发过块则不打扰桌面', async () => {
    const socket = await start();
    const idle = client.startVoice(() => {});
    idle.push(samples(10));
    idle.cancel();
    await settle();
    expect(socket.sent.some((item) => item.type === 'voice-cancel')).toBe(false);
    const voice = client.startVoice(() => {});
    voice.push(samples(6400));
    await settle();
    const id = voiceChunks(socket)[0].requestId;
    voice.cancel();
    voice.push(samples(6400));
    await settle();
    expect(socket.sent.filter((item) => item.type === 'voice-cancel')).toEqual([
      { type: 'voice-cancel', requestId: id },
    ]);
    expect(voiceChunks(socket)).toHaveLength(2);
  });

  it('host 错误码透传，未知码归为 failed；录音中收到错误则 finish 直接返回它', async () => {
    const socket = await start();
    const a = client.startVoice(() => {});
    const b = client.startVoice(() => {});
    a.push(samples(10));
    b.push(samples(6400));
    const pa = a.finish();
    await settle();
    const ca = voiceChunks(socket).find((c) => c.last);
    const cb = voiceChunks(socket).find((c) => !c.last);
    if (!ca || !cb) throw new Error('missing chunks');
    socket.receive({ type: 'voice-result', requestId: ca.requestId, error: 'not-ready' });
    socket.receive({ type: 'voice-result', requestId: cb.requestId, error: 'weird' });
    await settle();
    await expect(pa).resolves.toEqual({ ok: false, error: 'not-ready' });
    b.push(samples(6400));
    await settle();
    expect(voiceChunks(socket)).toHaveLength(3);
    await expect(b.finish()).resolves.toEqual({ ok: false, error: 'failed' });
  });

  it('未连接直接失败；60 秒超时从 finish 起算', async () => {
    const offline = client.startVoice(() => {});
    offline.push(samples(10));
    await expect(offline.finish()).resolves.toEqual({ ok: false, error: 'failed' });
    await start();
    const voice = client.startVoice(() => {});
    voice.push(samples(10));
    await vi.advanceTimersByTimeAsync(90_000);
    let done = false;
    const pending = voice.finish().then((result) => {
      done = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ ok: false, error: 'failed' });
  });

  it('断线时录音中与等待结果的会话都以 failed 结束', async () => {
    const socket = await start();
    const waiting = client.startVoice(() => {});
    waiting.push(samples(10));
    const pending = waiting.finish();
    const recording = client.startVoice(() => {});
    recording.push(samples(10));
    await settle();
    socket.close();
    await expect(pending).resolves.toEqual({ ok: false, error: 'failed' });
    await expect(recording.finish()).resolves.toEqual({ ok: false, error: 'failed' });
  });
});

describe('PairClient Bot 帧', () => {
  let client: PairClient;
  let events: ClientEvents;
  beforeEach(() => {
    vi.useFakeTimers();
    Socket.all = [];
    vi.stubGlobal('WebSocket', Socket);
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    events = {
      onState: vi.fn(),
      onCatalog: vi.fn(),
      onProjects: vi.fn(),
      onProviders: vi.fn(),
      onSession: vi.fn(),
      onBotCatalog: vi.fn(),
      onBotChats: vi.fn(),
      onGroupTimeline: vi.fn(),
      onBotEvent: vi.fn(),
      onBotChatState: vi.fn(),
      onBotSendResult: vi.fn(),
      onBotInbox: vi.fn(),
      onBotActivity: vi.fn(),
    };
    client = new PairClient(device, events, null, {
      load: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    });
  });
  afterEach(() => {
    client.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function start() {
    client.connect();
    await settle();
    const socket = Socket.all[0];
    socket.open();
    await settle();
    return socket;
  }

  it('未知帧静默忽略，不影响后续帧', async () => {
    const socket = await start();
    socket.receive({ type: 'from-the-future', payload: 1 });
    socket.receive({ type: 'bot-chats', chats: [] });
    await settle();
    expect(events.onBotChats).toHaveBeenCalledWith([]);
  });

  it('Bot 帧分发到对应回调', async () => {
    const socket = await start();
    const timeline = {
      type: 'group-timeline',
      chatId: 'c',
      entries: [],
      lastSeq: 0,
      hasOlder: false,
    };
    socket.receive({ type: 'bot-catalog', enabled: true, bots: [] });
    socket.receive({ type: 'bot-inbox', items: [{ key: 'k', kind: 'budget', chatId: null }] });
    socket.receive({ type: 'bot-inbox', items: 'bad' });
    socket.receive({ type: 'bot-activity', now: Date.now() - 5000, items: [] });
    socket.receive({ type: 'bot-activity', items: [] });
    socket.receive(timeline);
    socket.receive({ type: 'bot-event', event: { kind: 'timeline', chatId: 'c', seq: 3 } });
    socket.receive({
      type: 'bot-chat-state',
      chatId: 'c',
      current: null,
      queue: [],
      hops: 0,
      turnsByBot: {},
      pendingHuman: false,
    });
    socket.receive({
      type: 'bot-send-result',
      chatId: 'c',
      deliveryId: 'd',
      ok: false,
      error: 'x',
    });
    await settle();
    expect(events.onBotCatalog).toHaveBeenCalledWith(true, []);
    expect(events.onBotInbox).toHaveBeenCalledTimes(1);
    expect(events.onBotInbox).toHaveBeenCalledWith([{ key: 'k', kind: 'budget', chatId: null }]);
    expect(events.onBotActivity).toHaveBeenCalledTimes(1);
    const [items, offset] = vi.mocked(events.onBotActivity!).mock.calls[0];
    expect(items).toEqual([]);
    expect(offset).toBeGreaterThanOrEqual(5000);
    expect(events.onGroupTimeline).toHaveBeenCalledWith(timeline);
    expect(events.onBotEvent).toHaveBeenCalledWith({ kind: 'timeline', chatId: 'c', seq: 3 });
    expect(events.onBotChatState).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'c' }));
    expect(events.onBotSendResult).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'd', ok: false })
    );
  });

  it('结构不对的 Bot 帧丢弃', async () => {
    const socket = await start();
    socket.receive({ type: 'bot-catalog', enabled: true, bots: 'nope' });
    socket.receive({ type: 'group-timeline', chatId: 'c', entries: null });
    socket.receive({ type: 'bot-event', event: null });
    await settle();
    expect(events.onBotCatalog).not.toHaveBeenCalled();
    expect(events.onGroupTimeline).not.toHaveBeenCalled();
    expect(events.onBotEvent).not.toHaveBeenCalled();
  });
});
