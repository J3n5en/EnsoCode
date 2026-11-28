import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './index';
import { PAIR_TTL_MS, type PairState } from './pairing';
import { PairRoom } from './room';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const KEY = `${'B'.repeat(42)}A`;

interface FakeSocket {
  sent: (string | ArrayBuffer | ArrayBufferView)[];
  closed: { code?: number; reason?: string }[];
  send(msg: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  accept(): void;
}

function makeFakeSocket(): FakeSocket {
  const sent: (string | ArrayBuffer | ArrayBufferView)[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  return {
    sent,
    closed,
    send(msg) {
      sent.push(msg);
    },
    close(code, reason) {
      closed.push({ code, reason });
    },
    accept() {},
  };
}

/** 实现 PairRoom 配对 + WebSocket hibernation 路径用到的 DurableObjectState 子集 */
function fakeState() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const sockets = new Map<FakeSocket, string[]>();
  const ctx = {
    storage: {
      get: async (key: string) => data.get(key),
      put: async (key: string, value: unknown) => {
        data.set(key, value);
      },
      deleteAll: async () => data.clear(),
      setAlarm: async (at: number | Date) => {
        alarm = typeof at === 'number' ? at : at.getTime();
      },
      getAlarm: async () => alarm,
    },
    setWebSocketAutoResponse: () => {},
    acceptWebSocket: (ws: FakeSocket, tags: string[] = []) => {
      sockets.set(ws, tags);
    },
    getTags: (ws: FakeSocket) => sockets.get(ws) ?? [],
    getWebSockets: (tag?: string) => {
      const out: FakeSocket[] = [];
      for (const [ws, tags] of sockets) {
        if (!tag || tags.includes(tag)) out.push(ws);
      }
      return out;
    },
  };
  return {
    ctx: ctx as unknown as DurableObjectState,
    data,
    sockets,
    dropSocket: (ws: FakeSocket) => {
      sockets.delete(ws);
    },
    alarmAt: () => alarm,
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://do${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pair-id': 'p' },
    body: JSON.stringify(body),
  });
}

let now = 1000;
let pairQueue: [FakeSocket, FakeSocket][] = [];

beforeEach(() => {
  now = 1000;
  pairQueue = [];
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('WebSocketRequestResponsePair', class {});
  vi.stubGlobal(
    'WebSocketPair',
    class {
      0: FakeSocket;
      1: FakeSocket;
      constructor() {
        const pair = pairQueue.shift() ?? [makeFakeSocket(), makeFakeSocket()];
        this[0] = pair[0];
        this[1] = pair[1];
      }
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('过期配对码清理（request 不鉴权，不清理会无限占存储）', () => {
  it('未认领的配对码过期后由 alarm 清空存储', async () => {
    const state = fakeState();
    const room = new PairRoom(state.ctx, {} as Env);
    await room.fetch(post('/request', { publicKey: KEY }));
    expect(state.alarmAt()).toBe(1000 + PAIR_TTL_MS + 1);

    now = state.alarmAt() as number;
    await room.alarm();
    expect(state.data.size).toBe(0);
  });

  it('alarm 提前触发时保留配对码，并按过期时刻重新排期', async () => {
    const state = fakeState();
    const room = new PairRoom(state.ctx, {} as Env);
    await room.fetch(post('/request', { publicKey: KEY }));

    now = 1000 + PAIR_TTL_MS;
    await room.alarm();
    expect(state.data.get('state')).toMatchObject({
      phase: 'requested',
    } satisfies Partial<PairState>);
    expect(state.alarmAt()).toBe(1000 + PAIR_TTL_MS + 1);
  });

  it('已认领的配对不被清理：重连还要用 token', async () => {
    const state = fakeState();
    const room = new PairRoom(state.ctx, {} as Env);
    await room.fetch(post('/request', { publicKey: KEY }));
    await room.fetch(post('/claim', { publicKey: KEY, boxedKey: 'boxed' }));

    now = 1000 + PAIR_TTL_MS + 1;
    await room.alarm();
    expect(state.data.get('state')).toMatchObject({
      phase: 'authorized',
    } satisfies Partial<PairState>);
  });
});

async function setupAuthorizedRoom(room: PairRoom) {
  await room.fetch(post('/request', { publicKey: KEY }));
  const claimRes = await room.fetch(post('/claim', { publicKey: KEY, boxedKey: 'boxed' }));
  const { deviceToken } = (await claimRes.json()) as { deviceToken: string };
  const reqRes = await room.fetch(post('/request', { publicKey: KEY }));
  const { hostToken } = (await reqRes.json()) as { hostToken: string };
  return { hostToken, deviceToken };
}

async function connectRole(
  room: PairRoom,
  role: 'host' | 'guest',
  token: string,
  extra = ''
): Promise<FakeSocket> {
  const server = makeFakeSocket();
  const client = makeFakeSocket();
  pairQueue.push([client, server]);
  const res = await room.fetch(
    new Request(`https://do/connect?role=${role}&token=${token}${extra}`, {
      headers: { upgrade: 'websocket' },
    })
  );
  void res;
  return server;
}

describe('密文热缓冲（与 Go 中继对齐：relayEpoch + sinceRelaySeq 断线补放）', () => {
  const OrigResponse = globalThis.Response;

  beforeEach(() => {
    // Node 的原生 Response 不允许 status=101，这里仅对 101 返回轻量 stub
    vi.stubGlobal(
      'Response',
      class extends OrigResponse {
        override readonly webSocket: WebSocket | null = null;
        constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: WebSocket }) {
          if (init?.status === 101) {
            super(null, { status: 200 });
            this.webSocket = init.webSocket ?? null;
          } else {
            super(body, init);
          }
        }
      }
    );
  });

  const enc = (s: string): ArrayBuffer => {
    const bytes = new TextEncoder().encode(s);
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
  };

  it('guest 短暂断线带 relayEpoch + sinceRelaySeq 重连时，在 host-online 后补放缺失密文帧', async () => {
    const state = fakeState();
    const room = new PairRoom(state.ctx, {} as Env);
    const { hostToken, deviceToken } = await setupAuthorizedRoom(room);

    const host = await connectRole(room, 'host', hostToken);
    const guest1 = await connectRole(room, 'guest', deviceToken);

    const online1 = JSON.parse(guest1.sent[0] as string) as {
      type: string;
      relayEpoch?: string;
      relaySeq?: number;
    };
    expect(online1.type).toBe('host-online');
    expect(typeof online1.relayEpoch).toBe('string');
    expect(online1.relayEpoch?.length).toBeGreaterThan(0);
    expect(online1.relaySeq).toBe(0);

    await room.webSocketMessage(host as unknown as WebSocket, enc('f1'));
    expect(guest1.sent).toHaveLength(2);

    // guest1 断开，host 继续发 f2、f3
    state.dropSocket(guest1);
    await room.webSocketClose(guest1 as unknown as WebSocket);
    await room.webSocketMessage(host as unknown as WebSocket, enc('f2'));
    await room.webSocketMessage(host as unknown as WebSocket, enc('f3'));

    // guest2 带 relayEpoch & sinceRelaySeq=1 重连
    const guest2 = await connectRole(
      room,
      'guest',
      deviceToken,
      `&relayEpoch=${encodeURIComponent(online1.relayEpoch!)}&sinceRelaySeq=1`
    );
    const online2 = JSON.parse(guest2.sent[0] as string) as {
      type: string;
      relayEpoch?: string;
      relaySeq?: number;
      replayedFrom?: number;
    };
    expect(online2).toEqual({
      type: 'host-online',
      relayEpoch: online1.relayEpoch,
      relaySeq: 3,
      replayedFrom: 1,
    });
    const replayed = guest2.sent
      .slice(1)
      .map((buf) => new TextDecoder().decode(new Uint8Array(buf as ArrayBuffer)));
    expect(replayed).toEqual(['f2', 'f3']);
  });

  it('超过 90s TTL、epoch 不匹配或 host 断线重连后不误补放旧帧', async () => {
    const state = fakeState();
    const room = new PairRoom(state.ctx, {} as Env);
    const { hostToken, deviceToken } = await setupAuthorizedRoom(room);

    const host = await connectRole(room, 'host', hostToken);
    const guest1 = await connectRole(room, 'guest', deviceToken);
    const { relayEpoch } = JSON.parse(guest1.sent[0] as string) as { relayEpoch: string };

    await room.webSocketMessage(host as unknown as WebSocket, enc('old-1'));
    state.dropSocket(guest1);
    await room.webSocketClose(guest1 as unknown as WebSocket);

    // 超过 90s TTL
    now += 91_000;
    const guestExpired = await connectRole(
      room,
      'guest',
      deviceToken,
      `&relayEpoch=${encodeURIComponent(relayEpoch)}&sinceRelaySeq=0`
    );
    const onlineExpired = JSON.parse(guestExpired.sent[0] as string) as Record<string, unknown>;
    expect(onlineExpired.replayedFrom).toBeUndefined();
    expect(guestExpired.sent).toHaveLength(1);

    // host 离开后重连生成新 epoch，清空缓冲
    state.dropSocket(host);
    await room.webSocketClose(host as unknown as WebSocket);
    const host2 = await connectRole(room, 'host', hostToken);
    void host2;
    const hostOnlineAgain = JSON.parse(guestExpired.sent.at(-1) as string) as {
      type: string;
      relayEpoch?: string;
      relaySeq?: number;
    };
    expect(hostOnlineAgain.type).toBe('host-online');
    expect(hostOnlineAgain.relayEpoch).not.toBe(relayEpoch);
    expect(hostOnlineAgain.relaySeq).toBe(0);
  });

  it('DO 休眠重建实例后若 host 仍在线，惰性分配新 epoch 并继续工作', async () => {
    const state = fakeState();
    const room1 = new PairRoom(state.ctx, {} as Env);
    const { hostToken, deviceToken } = await setupAuthorizedRoom(room1);
    const host = await connectRole(room1, 'host', hostToken);
    const guest1 = await connectRole(room1, 'guest', deviceToken);
    const { relayEpoch: oldEpoch } = JSON.parse(guest1.sent[0] as string) as {
      relayEpoch: string;
    };
    state.dropSocket(guest1);

    // 模拟 DO 休眠后新实例化，host socket 仍在 ctx.getWebSockets('host') 中
    const room2 = new PairRoom(state.ctx, {} as Env);
    const guest2 = await connectRole(
      room2,
      'guest',
      deviceToken,
      `&relayEpoch=${encodeURIComponent(oldEpoch)}&sinceRelaySeq=0`
    );
    const online2 = JSON.parse(guest2.sent[0] as string) as {
      type: string;
      relayEpoch?: string;
      relaySeq?: number;
      replayedFrom?: number;
    };
    expect(online2.type).toBe('host-online');
    expect(online2.relayEpoch).toBeTruthy();
    expect(online2.relayEpoch).not.toBe(oldEpoch);
    expect(online2.replayedFrom).toBeUndefined();
    expect(online2.relaySeq).toBe(0);

    // 新 epoch 下继续发帧后可正常热缓冲补放
    state.dropSocket(guest2);
    await room2.webSocketMessage(host as unknown as WebSocket, enc('after-hibernate'));
    const guest3 = await connectRole(
      room2,
      'guest',
      deviceToken,
      `&relayEpoch=${encodeURIComponent(online2.relayEpoch!)}&sinceRelaySeq=0`
    );
    const online3 = JSON.parse(guest3.sent[0] as string) as Record<string, unknown>;
    expect(online3.replayedFrom).toBe(0);
    expect(online3.relaySeq).toBe(1);
    expect(new TextDecoder().decode(new Uint8Array(guest3.sent[1] as ArrayBuffer))).toBe(
      'after-hibernate'
    );
  });
});
