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

/** 只实现 PairRoom 配对路径用到的 DurableObjectState 子集 */
function fakeState() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
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
    getWebSockets: () => [],
  };
  return { ctx: ctx as unknown as DurableObjectState, data, alarmAt: () => alarm };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://do${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pair-id': 'p' },
    body: JSON.stringify(body),
  });
}

let now = 1000;

beforeEach(() => {
  now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('WebSocketRequestResponsePair', class {});
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
