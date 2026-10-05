import { openFrame, sealFrame, toBase64Url } from '@enso/pair';
import type { RendererAgentEvent } from '@shared/types/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PairReplayLog } from './pairReplay';

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
  requestSnapshot: vi.fn(),
  setPinnedSessions: vi.fn(),
  resume: vi.fn(),
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
  requestSnapshot: hostMocks.requestSnapshot,
  setPinnedSessions: hostMocks.setPinnedSessions,
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
vi.mock('./pairMetaFlush', () => ({
  bumpPairMetaEpoch: vi.fn(),
  flushChangedMeta: vi.fn(async () => ({})),
  requestPairMeta: vi.fn(),
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

import {
  forwardAgentEvent,
  type PairBotPort,
  setPairBotPort,
  setPairResumeListener,
  startPairHost,
  stopPairHost,
} from './pairHost';
import { requestPairMeta } from './pairMetaFlush';

function epochs(): () => string {
  let next = 0;
  return () => `epoch-${++next}`;
}

const status = (sessionId: string, state: string, generation = 'generation-1') => ({
  type: 'status',
  identity: { sessionId, generation },
  seq: 1,
  status: state,
});

describe('PairReplayLog', () => {
  it('基线无变化时返回空增量完成同步', () => {
    const log = new PairReplayLog(undefined, epochs());
    const cursor = log.resetSession('s1', 'generation-1');
    expect(log.replay('s1', cursor)).toEqual({ cursor, fromSeq: 0, events: [] });
  });

  it('同 index 流式重写不会去重，按 host seq 完整重放', () => {
    const log = new PairReplayLog(undefined, epochs());
    const cursor = log.resetSession('s1', 'generation-1');
    log.record({
      type: 'message-upsert',
      identity: { sessionId: 's1', generation: 'generation-1' },
      seq: 8,
      index: 3,
      message: { text: 'a' },
    });
    const latest = log.record({
      type: 'message-upsert',
      identity: { sessionId: 's1', generation: 'generation-1' },
      seq: 9,
      index: 3,
      message: { text: 'ab' },
    });
    const replay = log.replay('s1', cursor);
    expect(replay?.events.map((event) => event.message)).toEqual([{ text: 'a' }, { text: 'ab' }]);
    expect(replay?.cursor).toEqual(latest?.cursor);
    expect(replay?.fromSeq).toBe(0);
  });

  it('截断、ask resolved 与状态事件都进入日志', () => {
    const log = new PairReplayLog(undefined, epochs());
    const cursor = log.resetSession('s1', 'generation-1');
    log.record({
      type: 'messages-truncated',
      identity: { sessionId: 's1', generation: 'generation-1' },
      seq: 2,
      length: 1,
    });
    log.record({
      type: 'ask-resolved',
      identity: { sessionId: 's1', generation: 'generation-1' },
      seq: 3,
      requestId: 'ask-1',
    });
    log.record(status('s1', 'idle'));
    expect(log.replay('s1', cursor)?.events.map((event) => event.type)).toEqual([
      'messages-truncated',
      'ask-resolved',
      'status',
    ]);
  });

  it('epoch 不匹配或未来游标时要求回退 snapshot', () => {
    const log = new PairReplayLog(undefined, epochs());
    const cursor = log.resetSession('s1');
    expect(log.replay('s1', { ...cursor, epoch: 'wrong' })).toBeNull();
    expect(log.replay('s1', { ...cursor, seq: 1 })).toBeNull();
  });

  it('事件淘汰后旧游标回退 snapshot，边界游标仍可续传', () => {
    const log = new PairReplayLog({ maxEventsPerSession: 2 }, epochs());
    const old = log.resetSession('s1', 'generation-1');
    log.record(status('s1', 'one'));
    const boundary = log.record(status('s1', 'two'))?.cursor;
    log.record(status('s1', 'three'));
    expect(log.replay('s1', old)).toBeNull();
    expect(boundary && log.replay('s1', boundary)?.events.map((event) => event.status)).toEqual([
      'three',
    ]);
  });

  it('单事件超过字节预算时不保留内容，但当前游标仍可报告零变化', () => {
    const log = new PairReplayLog({ maxBytesPerSession: 80 }, epochs());
    const old = log.resetSession('s1', 'generation-1');
    const recorded = log.record({ ...status('s1', 'idle'), payload: 'x'.repeat(200) });
    expect(recorded).not.toBeNull();
    expect(log.replay('s1', old)).toBeNull();
    expect(recorded && log.replay('s1', recorded.cursor)?.events).toEqual([]);
  });

  it('worker exited 全局失效，snapshot 只重置涉及的会话', () => {
    const log = new PairReplayLog(undefined, epochs());
    const a = log.resetSession('a', 'generation-1');
    const b = log.resetSession('b', 'generation-1');
    log.record(status('a', 'running'));
    log.record(status('b', 'running'));

    log.resetSession('b', 'generation-1');
    expect(log.replay('a', a)?.events).toHaveLength(1);
    expect(log.replay('b', b)).toBeNull();

    log.invalidateAll();
    expect(log.replay('a', a)).toBeNull();
  });

  it('只读快照和已完整记录的变化不换epoch，翻页不破坏续传基线', () => {
    const log = new PairReplayLog(undefined, epochs());
    const snapshot = {
      sessions: [{ sessionId: 's1', baseIndex: 0, messages: [], status: 'idle' }],
    };
    const initial = log.checkpoint('s1', snapshot, 'g');
    const live = log.record({ type: 'status', sessionId: 's1', status: 'running' });
    const current = log.checkpoint(
      's1',
      { sessions: [{ ...snapshot.sessions[0], status: 'running' }] },
      'g'
    );
    expect(current).toEqual(live?.cursor);
    expect(log.replay('s1', initial)?.events).toHaveLength(1);
    log.record({
      type: 'message-upsert',
      sessionId: 's1',
      index: 1,
      message: { text: 'new' },
    });
    expect(
      log.checkpoint(
        's1',
        {
          sessions: [
            {
              sessionId: 's1',
              baseIndex: 0,
              messages: [{ text: 'old' }, { text: 'new' }],
              status: 'running',
            },
          ],
        },
        'g'
      ).epoch
    ).toBe(live?.cursor.epoch);
  });

  it('只有快照包含的变更会轮换epoch，不能把旧缓存判为已同步', () => {
    const log = new PairReplayLog(undefined, epochs());
    const initial = log.checkpoint('s1', {
      sessions: [{ sessionId: 's1', baseIndex: 0, messages: [], status: 'idle' }],
    });
    const changed = log.checkpoint('s1', {
      sessions: [{ sessionId: 's1', baseIndex: 0, messages: [], status: 'failed' }],
    });
    expect(changed.epoch).not.toBe(initial.epoch);
    expect(log.replay('s1', initial)).toBeNull();
  });

  it('generation 更换会自动轮换 epoch', () => {
    const log = new PairReplayLog(undefined, epochs());
    const old = log.resetSession('s1', 'generation-1');
    const current = log.record(status('s1', 'running', 'generation-2'));
    expect(current?.cursor.epoch).not.toBe(old.epoch);
    expect(log.replay('s1', old)).toBeNull();
  });

  it('保存与返回的事件不受调用方后续修改', () => {
    const log = new PairReplayLog(undefined, epochs());
    const cursor = log.resetSession('s1', 'generation-1');
    const event = { ...status('s1', 'idle'), nested: { value: 'before' } };
    log.record(event);
    event.nested.value = 'after';
    const first = log.replay('s1', cursor);
    expect(first?.events[0]?.nested).toEqual({ value: 'before' });
    if (first) (first.events[0]?.nested as { value: string }).value = 'mutated';
    expect(log.replay('s1', cursor)?.events[0]?.nested).toEqual({ value: 'before' });
  });

  it('会话数预算按最近使用淘汰，不串扰仍保留的会话', () => {
    const log = new PairReplayLog({ maxSessions: 2 }, epochs());
    const a = log.resetSession('a');
    const b = log.resetSession('b');
    expect(log.replay('a', a)).not.toBeNull();
    log.resetSession('c');
    expect(log.replay('a', a)).not.toBeNull();
    expect(log.replay('b', b)).toBeNull();
  });
});

describe('pairHost session-sync 接线', () => {
  const contentKey = new Uint8Array(32).fill(7);

  beforeEach(async () => {
    vi.clearAllMocks();
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
        deviceName: 'phone',
        relayUrl: 'https://relay.example.com',
        pairedAt: 1,
      },
    ]);
    setPairResumeListener(hostMocks.resume);
    startPairHost();
    await vi.waitFor(() => expect(hostMocks.socket?.onmessage).toBeTypeOf('function'));
    hostMocks.socket?.onopen?.();
    hostMocks.socket?.onmessage?.({ data: JSON.stringify({ type: 'peer-joined' }) });
  });

  afterEach(() => {
    stopPairHost();
  });

  async function receive(payload: unknown): Promise<void> {
    const frame = await sealFrame(contentKey, payload);
    const data = frame.buffer.slice(
      frame.byteOffset,
      frame.byteOffset + frame.byteLength
    ) as ArrayBuffer;
    hostMocks.socket?.onmessage?.({ data });
  }

  async function sentPayloads(): Promise<Record<string, unknown>[]> {
    const calls = hostMocks.socket?.send.mock.calls ?? [];
    return Promise.all(
      calls.map(
        async ([data]) =>
          (await openFrame(contentKey, new Uint8Array(data))) as Record<string, unknown>
      )
    );
  }

  const snapshotEvent = (): RendererAgentEvent =>
    ({
      type: 'snapshot',
      sessions: [
        {
          identity: { sessionId: 's1', generation: 'generation-1' },
          status: 'idle',
          messages: [],
          commands: [],
        },
      ],
    }) as RendererAgentEvent;

  it('首次请求 snapshot，离线事件随后按 cursor replay，空增量不再请求 worker', async () => {
    await receive({ type: 'subscribe', sessionId: 's1', sync: { requestId: 'request-1' } });
    await vi.waitFor(() => expect(hostMocks.requestSnapshot).toHaveBeenCalledTimes(1));
    expect(hostMocks.resume).toHaveBeenCalledTimes(1);

    forwardAgentEvent(snapshotEvent());
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    const initial = (await sentPayloads())[0];
    expect(initial).toMatchObject({
      type: 'session-sync',
      mode: 'snapshot',
      sessionId: 's1',
      requestId: 'request-1',
    });
    const initialCursor = initial.cursor;

    hostMocks.socket?.send.mockClear();
    hostMocks.socket?.onmessage?.({ data: JSON.stringify({ type: 'peer-left' }) });
    forwardAgentEvent({
      type: 'status',
      identity: { sessionId: 's1', generation: 'generation-1' },
      seq: 2,
      status: 'running',
    });
    hostMocks.socket?.onmessage?.({ data: JSON.stringify({ type: 'peer-joined' }) });
    await receive({
      type: 'subscribe',
      sessionId: 's1',
      sync: { requestId: 'request-2', cursor: initialCursor },
    });
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    const replay = (await sentPayloads())[0];
    expect(replay).toMatchObject({
      type: 'session-sync',
      mode: 'replay',
      requestId: 'request-2',
      fromSeq: 0,
    });
    expect(replay.events).toMatchObject([{ type: 'status', sessionId: 's1' }]);
    expect(hostMocks.requestSnapshot).toHaveBeenCalledTimes(1);
    expect(hostMocks.resume).toHaveBeenCalledTimes(1);

    hostMocks.socket?.send.mockClear();
    await receive({
      type: 'subscribe',
      sessionId: 's1',
      sync: { requestId: 'request-3', cursor: replay.cursor },
    });
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    expect((await sentPayloads())[0]).toMatchObject({
      type: 'session-sync',
      mode: 'replay',
      requestId: 'request-3',
      events: [],
    });
    expect(hostMocks.requestSnapshot).toHaveBeenCalledTimes(1);

    hostMocks.socket?.send.mockClear();
    await receive({
      type: 'subscribe',
      sessionId: 's1',
      sync: {
        requestId: 'request-4',
        cursor: { ...(replay.cursor as Record<string, unknown>), epoch: 'wrong' },
      },
    });
    await vi.waitFor(() => expect(hostMocks.requestSnapshot).toHaveBeenCalledTimes(2));
    expect(hostMocks.resume).toHaveBeenCalledTimes(2);
    forwardAgentEvent(snapshotEvent());
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    expect((await sentPayloads())[0]).toMatchObject({
      type: 'session-sync',
      mode: 'snapshot',
      requestId: 'request-4',
    });
  });

  it('重复 subscribe 只用最新 requestId，snapshot 帧先于后续 live 帧', async () => {
    const metaCalls = vi.mocked(requestPairMeta).mock.calls.length;
    await receive({ type: 'subscribe', sessionId: 's1', sync: { requestId: 'old' } });
    await receive({ type: 'subscribe', sessionId: 's1', sync: { requestId: 'latest' } });
    await vi.waitFor(() => expect(requestPairMeta).toHaveBeenCalledTimes(metaCalls + 2));
    expect(hostMocks.requestSnapshot).toHaveBeenCalledTimes(1);

    forwardAgentEvent(snapshotEvent());
    forwardAgentEvent({
      type: 'status',
      identity: { sessionId: 's1', generation: 'generation-1' },
      seq: 2,
      status: 'running',
    });
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(2));
    const payloads = await sentPayloads();
    expect(payloads.map((payload) => payload.type)).toEqual(['session-sync', 'agent-event']);
    expect(payloads[0]?.requestId).toBe('latest');
    const syncCursor = payloads[0]?.cursor as { epoch: string };
    expect(payloads[1]).toMatchObject({
      cursor: { epoch: syncCursor.epoch, seq: 1 },
    });
  });

  it('桌面自发快照只通知版本失效，不重发已完成请求的正文快照', async () => {
    await receive({ type: 'subscribe', sessionId: 's1', sync: { requestId: 'initial' } });
    await vi.waitFor(() => expect(hostMocks.requestSnapshot).toHaveBeenCalledTimes(1));
    forwardAgentEvent(snapshotEvent());
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    const cursor = (await sentPayloads())[0]?.cursor;
    hostMocks.socket?.send.mockClear();

    const changed = snapshotEvent();
    if (changed.type === 'snapshot') changed.sessions[0].status = 'failed';
    forwardAgentEvent(changed);
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    expect((await sentPayloads())[0]).toMatchObject({
      type: 'agent-event',
      event: { type: 'session-invalidated', sessionId: 's1' },
      cursor: { seq: 0 },
    });
    expect((await sentPayloads())[0]?.cursor).not.toEqual(cursor);

    hostMocks.socket?.send.mockClear();
    await receive({ type: 'subscribe', sessionId: 's1', sync: { requestId: 'refresh', cursor } });
    await vi.waitFor(() => expect(hostMocks.requestSnapshot).toHaveBeenCalledTimes(2));
    forwardAgentEvent(snapshotEvent());
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    expect((await sentPayloads())[0]).toMatchObject({
      type: 'session-sync',
      mode: 'snapshot',
      requestId: 'refresh',
    });
  });

  it('内容未变的桌面快照不再下发', async () => {
    await receive({ type: 'subscribe', sessionId: 's1', sync: { requestId: 'initial' } });
    await vi.waitFor(() => expect(hostMocks.requestSnapshot).toHaveBeenCalledTimes(1));
    forwardAgentEvent(snapshotEvent());
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    hostMocks.socket?.send.mockClear();
    forwardAgentEvent(snapshotEvent());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(hostMocks.socket?.send).not.toHaveBeenCalled();
  });

  it('worker-exited 会让 host 拒绝旧 cursor 并重新请求 snapshot', async () => {
    await receive({ type: 'subscribe', sessionId: 's1', sync: { requestId: 'before-exit' } });
    await vi.waitFor(() => expect(hostMocks.requestSnapshot).toHaveBeenCalledTimes(1));
    forwardAgentEvent(snapshotEvent());
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    const cursor = (await sentPayloads())[0]?.cursor;

    hostMocks.socket?.send.mockClear();
    hostMocks.socket?.onmessage?.({ data: JSON.stringify({ type: 'peer-left' }) });
    forwardAgentEvent({ type: 'worker-exited' });
    hostMocks.socket?.onmessage?.({ data: JSON.stringify({ type: 'peer-joined' }) });
    await receive({
      type: 'subscribe',
      sessionId: 's1',
      sync: { requestId: 'after-exit', cursor },
    });
    await vi.waitFor(() => expect(hostMocks.requestSnapshot).toHaveBeenCalledTimes(2));
    expect(hostMocks.socket?.send).not.toHaveBeenCalled();
  });

  it('旧端 subscribe 仍收到无 cursor 的 agent-event snapshot 与 live 事件', async () => {
    await receive({ type: 'subscribe', sessionId: 's1', sinceIndex: -1 });
    await vi.waitFor(() => expect(hostMocks.requestSnapshot).toHaveBeenCalledTimes(1));
    forwardAgentEvent(snapshotEvent());
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    expect((await sentPayloads())[0]).toMatchObject({
      type: 'agent-event',
      event: { type: 'snapshot' },
    });
    expect((await sentPayloads())[0]).not.toHaveProperty('cursor');

    hostMocks.socket?.send.mockClear();
    forwardAgentEvent({
      type: 'status',
      identity: { sessionId: 's1', generation: 'generation-1' },
      seq: 2,
      status: 'running',
    });
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    expect((await sentPayloads())[0]).not.toHaveProperty('cursor');
  });

  it('已同步后 history 只下发切片，不再推尾窗快照', async () => {
    await receive({ type: 'subscribe', sessionId: 's1', sync: { requestId: 'initial' } });
    await vi.waitFor(() => expect(hostMocks.requestSnapshot).toHaveBeenCalledTimes(1));
    forwardAgentEvent(snapshotEvent());
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    hostMocks.socket?.send.mockClear();
    hostMocks.requestSnapshot.mockClear();

    await receive({ type: 'history', sessionId: 's1', beforeIndex: 2 });
    await vi.waitFor(() => expect(hostMocks.requestSnapshot).toHaveBeenCalledTimes(1));
    const page = snapshotEvent();
    if (page.type === 'snapshot') {
      page.sessions[0].messages = [
        { role: 'user', content: [{ type: 'text', text: 'old' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'tail' }] },
      ];
    }
    forwardAgentEvent(page);
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    expect((await sentPayloads())[0]).toMatchObject({ type: 'history', sessionId: 's1' });
  });
});

describe('pairHost Bot 会话接线', () => {
  const contentKey = new Uint8Array(32).fill(9);
  let port: PairBotPort;

  beforeEach(async () => {
    vi.clearAllMocks();
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
        pairId: 'pair-bot',
        token: 'token-1',
        contentKey: toBase64Url(contentKey),
        deviceName: 'phone',
        relayUrl: 'https://relay.example.com',
        pairedAt: 1,
      },
    ]);
    port = {
      handle: vi.fn(async (_pairId, _command, reply) => {
        await reply({ type: 'bot-chats', chats: [] });
      }),
      resync: vi.fn(),
      sessionAccess: vi.fn(() => 'none' as const),
      coldSnapshot: vi.fn(async () => null),
      sessionTitle: vi.fn(() => undefined),
      observe: vi.fn(),
    };
    setPairBotPort(port);
    setPairResumeListener(hostMocks.resume);
    startPairHost();
    await vi.waitFor(() => expect(hostMocks.socket?.onmessage).toBeTypeOf('function'));
    hostMocks.socket?.onopen?.();
    hostMocks.socket?.onmessage?.({ data: JSON.stringify({ type: 'peer-joined' }) });
  });

  afterEach(() => {
    stopPairHost();
    setPairBotPort(null);
  });

  async function receive(payload: unknown): Promise<void> {
    const frame = await sealFrame(contentKey, payload);
    const data = frame.buffer.slice(
      frame.byteOffset,
      frame.byteOffset + frame.byteLength
    ) as ArrayBuffer;
    hostMocks.socket?.onmessage?.({ data });
  }

  async function sentPayloads(): Promise<Record<string, unknown>[]> {
    const calls = hostMocks.socket?.send.mock.calls ?? [];
    return Promise.all(
      calls.map(
        async ([data]) =>
          (await openFrame(contentKey, new Uint8Array(data))) as Record<string, unknown>
      )
    );
  }

  const coldSnapshot = (count: number): RendererAgentEvent =>
    ({
      type: 'snapshot',
      partial: true,
      sessions: [
        {
          identity: { sessionId: 'bot-1' },
          sessionId: 'bot-1',
          status: 'idle',
          messages: Array.from({ length: count }, (_, i) => ({
            role: 'user',
            content: [{ type: 'text', text: `m${i}` }],
          })),
          commands: [],
        },
      ],
    }) as unknown as RendererAgentEvent;

  it('进房时请 Bot 层补推目录', () => {
    expect(port.resync).toHaveBeenCalledWith('pair-bot', expect.any(Function));
  });

  it('冷 Bot 会话：不走 renderer 恢复，用合成快照应答 session-sync，翻页也由它切', async () => {
    vi.mocked(port.sessionAccess).mockReturnValue('cold');
    vi.mocked(port.coldSnapshot).mockResolvedValue(coldSnapshot(300));
    await receive({ type: 'subscribe', sessionId: 'bot-1', sync: { requestId: 'r1' } });
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    expect(hostMocks.resume).not.toHaveBeenCalled();
    expect(hostMocks.requestSnapshot).not.toHaveBeenCalled();
    const [sync] = await sentPayloads();
    expect(sync).toMatchObject({ type: 'session-sync', sessionId: 'bot-1', requestId: 'r1' });
    const base = (sync.snapshot as { sessions: { baseIndex: number }[] }).sessions[0].baseIndex;
    expect(base).toBeGreaterThan(0);

    hostMocks.socket?.send.mockClear();
    await receive({ type: 'history', sessionId: 'bot-1', beforeIndex: base });
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    expect((await sentPayloads())[0]).toMatchObject({ type: 'history', sessionId: 'bot-1' });
    expect(port.coldSnapshot).toHaveBeenCalledTimes(2);
  });

  it('活 Bot 会话只要 worker 快照，不请 renderer 恢复', async () => {
    vi.mocked(port.sessionAccess).mockReturnValue('live');
    await receive({ type: 'subscribe', sessionId: 'bot-1', sync: { requestId: 'r1' } });
    await vi.waitFor(() => expect(hostMocks.requestSnapshot).toHaveBeenCalledWith('bot-1'));
    expect(hostMocks.resume).not.toHaveBeenCalled();
  });

  it('Bot 模式关闭时拒绝订阅 Bot 会话', async () => {
    vi.mocked(port.sessionAccess).mockReturnValue('deny');
    await receive({ type: 'subscribe', sessionId: 'bot-1', sync: { requestId: 'r1' } });
    await receive({ type: 'bot-catalog-request' });
    await vi.waitFor(() => expect(port.handle).toHaveBeenCalled());
    expect(hostMocks.resume).not.toHaveBeenCalled();
    expect(hostMocks.requestSnapshot).not.toHaveBeenCalled();
    expect(hostMocks.setPinnedSessions).not.toHaveBeenCalledWith('pair', ['bot-1']);
  });

  it('bot 命令交 Bot 层处理，应答回到同一连接', async () => {
    await receive({ type: 'bot-chat-open', chatId: 'chat-1', junk: true });
    await vi.waitFor(() => expect(hostMocks.socket?.send).toHaveBeenCalledTimes(1));
    expect(port.handle).toHaveBeenCalledWith(
      'pair-bot',
      { type: 'bot-chat-open', chatId: 'chat-1' },
      expect.any(Function)
    );
    expect((await sentPayloads())[0]).toEqual({ type: 'bot-chats', chats: [] });
  });

  it('普通会话仍走 renderer 恢复', async () => {
    await receive({ type: 'subscribe', sessionId: 'code-1', sync: { requestId: 'r1' } });
    await vi.waitFor(() => expect(hostMocks.requestSnapshot).toHaveBeenCalledWith('code-1'));
    expect(hostMocks.resume).toHaveBeenCalledWith('code-1');
  });
});
