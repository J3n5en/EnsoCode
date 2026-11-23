import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CLAIM_IDLE_LEASE_MS,
  parseClaimCandidates,
  parseClaimGroup,
  parseClaimKey,
  parseClaimLabel,
  parseClaimSubscribedAt,
} from '@shared/types/eventClaims';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EventClaimStore,
  getEventClaimStore,
  peekEventClaimStore,
  setEventClaimStore,
} from './eventClaims';

const dirs: string[] = [];

afterEach(() => {
  setEventClaimStore(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function tempStore(
  time = clock(),
  extra: ConstructorParameters<typeof EventClaimStore>[0] = {}
): { store: EventClaimStore; file: string; time: ReturnType<typeof clock> } {
  const dir = mkdtempSync(path.join(tmpdir(), 'enso-claims-'));
  dirs.push(dir);
  const file = path.join(dir, 'event-claims.json');
  const store = new EventClaimStore({
    filePath: file,
    now: time.now,
    idleLeaseMs: 1_000,
    heartbeatPersistIntervalMs: 5_000,
    ...extra,
  });
  return { store, file, time };
}

describe('parseClaim*', () => {
  it('收窄认领键、标签、分组、订阅时间和候选', () => {
    expect(parseClaimKey(' github:acme/app#1:review ')).toBe('github:acme/app#1:review');
    expect(parseClaimKey('')).toBeNull();
    expect(parseClaimKey('x'.repeat(257))).toBeNull();
    expect(parseClaimKey(1)).toBeNull();
    expect(parseClaimLabel(undefined)).toBeUndefined();
    expect(parseClaimLabel('  PR 审查  ')).toBe('PR 审查');
    expect(parseClaimLabel('')).toBeNull();
    expect(parseClaimLabel('y'.repeat(121))).toBeNull();
    expect(parseClaimGroup('github')).toBe('github');
    expect(parseClaimGroup('g'.repeat(65))).toBeNull();
    expect(parseClaimSubscribedAt(undefined)).toBeUndefined();
    expect(parseClaimSubscribedAt(12)).toBe(12);
    expect(parseClaimSubscribedAt(-1)).toBeNull();
    expect(parseClaimSubscribedAt(Number.NaN)).toBeNull();
    expect(parseClaimCandidates(undefined)).toBeUndefined();
    expect(parseClaimCandidates([])).toEqual([]);
    expect(
      parseClaimCandidates([{ sessionId: 'a', subscribedAt: 1, active: true }, { sessionId: 'b' }])
    ).toEqual([{ sessionId: 'a', subscribedAt: 1, active: true }, { sessionId: 'b' }]);
    expect(parseClaimCandidates([{ sessionId: '' }])).toBeNull();
    expect(parseClaimCandidates('nope')).toBeNull();
  });
});

describe('EventClaimStore', () => {
  it('先到的会话认领，持有者续期，别人拿不到', () => {
    const { store, time } = tempStore();
    const first = store.acquire({
      key: 'github:acme/app#1:review',
      sessionId: 's1',
      pluginId: 'github',
    });
    expect(first).toMatchObject({ acquired: true, status: 'claimed', ownerSessionId: 's1' });
    expect(first.claim.leaseUntil).toBe(time.now() + 1_000);
    time.advance(400);
    const again = store.acquire({
      key: 'github:acme/app#1:review',
      sessionId: 's1',
      pluginId: 'github',
    });
    expect(again).toMatchObject({ acquired: true, status: 'renewed', ownerSessionId: 's1' });
    expect(again.claim.leaseUntil).toBe(time.now() + 1_000);
    expect(again.claim.claimedAt).toBe(first.claim.claimedAt);
    const other = store.acquire({
      key: 'github:acme/app#1:review',
      sessionId: 's2',
      pluginId: 'github',
    });
    expect(other).toMatchObject({ acquired: false, status: 'held-by-other', ownerSessionId: 's1' });
    expect(store.ownerOf('github:acme/app#1:review')?.sessionId).toBe('s1');
  });

  it('空闲超过租约后可以被接管，持续心跳则 30 分钟也不过期', () => {
    const { store, time } = tempStore();
    store.acquire({ key: 'k', sessionId: 's1', pluginId: 'p' });
    time.advance(1_000);
    const taken = store.acquire({ key: 'k', sessionId: 's2', pluginId: 'p' });
    expect(taken).toMatchObject({ acquired: true, status: 'claimed', ownerSessionId: 's2' });

    const long = tempStore(clock(), { idleLeaseMs: DEFAULT_CLAIM_IDLE_LEASE_MS });
    long.store.acquire({ key: 'k', sessionId: 's1', pluginId: 'p' });
    for (let i = 0; i < 30; i += 1) {
      long.time.advance(60_000);
      expect(long.store.heartbeat('s1')).toBe(true);
    }
    long.time.advance(60_000);
    expect(long.store.acquire({ key: 'k', sessionId: 's2', pluginId: 'p' })).toMatchObject({
      acquired: false,
      status: 'held-by-other',
      ownerSessionId: 's1',
    });
    expect(long.store.ownerOf('k')?.leaseUntil).toBe(
      long.time.now() - 60_000 + DEFAULT_CLAIM_IDLE_LEASE_MS
    );
  });

  it('上游恢复保护的会话即使租约已过也不被抢走', () => {
    const { store, time } = tempStore(clock(), {
      isSessionProtected: (sessionId) => sessionId === 's1',
    });
    store.acquire({ key: 'k', sessionId: 's1', pluginId: 'p' });
    time.advance(10 * DEFAULT_CLAIM_IDLE_LEASE_MS);
    expect(store.acquire({ key: 'k', sessionId: 's2', pluginId: 'p' })).toMatchObject({
      acquired: false,
      ownerSessionId: 's1',
    });
    expect(store.ownerOf('k')?.sessionId).toBe('s1');
  });

  it('已关联的首选会话优先于当前请求和候选选举', () => {
    const { store } = tempStore(clock(), {
      resolvePreferredOwner: (key) => (key === 'pr' ? 'owner' : null),
    });
    const lost = store.acquire({
      key: 'pr',
      sessionId: 'watcher',
      pluginId: 'github',
      candidates: [
        { sessionId: 'watcher', subscribedAt: 1, active: true },
        { sessionId: 'owner', subscribedAt: 50 },
      ],
    });
    expect(lost).toMatchObject({
      acquired: false,
      status: 'held-by-other',
      ownerSessionId: 'owner',
    });
    expect(store.ownerOf('pr')?.sessionId).toBe('owner');

    const open = store.acquire({
      key: 'other',
      sessionId: 'late',
      pluginId: 'github',
      preferredSessionId: 'early',
      candidates: [
        { sessionId: 'late', subscribedAt: 1, active: true },
        { sessionId: 'early', subscribedAt: 9 },
      ],
    });
    expect(open.ownerSessionId).toBe('early');
    expect(open.acquired).toBe(false);
  });

  it('首选不在候选里时按在处理优先、最早订阅、输入顺序选举', () => {
    const { store } = tempStore(clock(), {
      resolvePreferredOwner: () => 'outsider',
    });
    const elected = store.acquire({
      key: 'k',
      sessionId: 'caller',
      pluginId: 'p',
      candidates: [
        { sessionId: 'late', subscribedAt: 30 },
        { sessionId: 'quiet-early', subscribedAt: 2 },
        { sessionId: 'busy-late', subscribedAt: 20, active: true },
        { sessionId: 'busy-early', subscribedAt: 10, active: true },
        { sessionId: 'no-time' },
      ],
    });
    expect(elected).toMatchObject({ acquired: false, ownerSessionId: 'busy-early' });

    const byTime = store.acquire({
      key: 'k2',
      sessionId: 'caller',
      pluginId: 'p',
      candidates: [
        { sessionId: 'second', subscribedAt: 5 },
        { sessionId: 'first', subscribedAt: 1 },
        { sessionId: 'untimed' },
      ],
    });
    expect(byTime.ownerSessionId).toBe('first');

    const byOrder = store.acquire({
      key: 'k3',
      sessionId: 'caller',
      pluginId: 'p',
      candidates: [{ sessionId: 'a' }, { sessionId: 'b' }],
    });
    expect(byOrder).toMatchObject({ acquired: false, ownerSessionId: 'a' });

    const self = store.acquire({
      key: 'k4',
      sessionId: 'caller',
      pluginId: 'p',
      candidates: [{ sessionId: 'caller', subscribedAt: 3 }],
    });
    expect(self).toMatchObject({ acquired: true, status: 'claimed', ownerSessionId: 'caller' });
  });

  it('只有持有者能续期或释放；释放会话会清掉它的全部认领', () => {
    const { store, time } = tempStore();
    store.acquire({ key: 'a', sessionId: 's1', pluginId: 'p', label: 'A' });
    store.acquire({ key: 'b', sessionId: 's1', pluginId: 'p' });
    store.acquire({ key: 'c', sessionId: 's2', pluginId: 'p' });
    expect(store.renew('a', 's2')).toBeNull();
    time.advance(10);
    expect(store.renew('a', 's1')?.leaseUntil).toBe(time.now() + 1_000);
    expect(store.release('a', 's2')).toBe(false);
    expect(store.ownerOf('a')?.sessionId).toBe('s1');
    expect(store.release('a', 's1')).toBe(true);
    expect(store.ownerOf('a')).toBeNull();
    expect(store.releaseSession('s1')).toBe(1);
    expect(store.list()).toEqual([expect.objectContaining({ key: 'c', sessionId: 's2' })]);
    time.advance(1_000);
    expect(store.renew('c', 's2')).toBeNull();
    expect(store.heartbeat('s2')).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('列表滤掉过期项并按认领时间排序，支持前缀和会话过滤', () => {
    const { store, time } = tempStore();
    store.acquire({ key: 'tg:-1:1', sessionId: 's1', pluginId: 'tg', group: 'tg' });
    time.advance(5);
    store.acquire({
      key: 'github:a#1:review',
      sessionId: 's2',
      pluginId: 'github',
      group: 'github',
    });
    time.advance(5);
    store.acquire({
      key: 'github:a#2:review',
      sessionId: 's1',
      pluginId: 'github',
      group: 'github',
    });
    time.advance(990);
    expect(store.list().map((claim) => claim.key)).toEqual([
      'github:a#1:review',
      'github:a#2:review',
    ]);
    expect(store.list({ prefix: 'github:' }).map((claim) => claim.key)).toEqual([
      'github:a#1:review',
      'github:a#2:review',
    ]);
    expect(store.list({ sessionId: 's1' }).map((claim) => claim.key)).toEqual([
      'github:a#2:review',
    ]);
    expect(store.list({ pluginId: 'tg' })).toEqual([]);
  });

  it('坏文件当空表，结构变更立刻落盘，心跳按间隔节流', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'enso-claims-'));
    dirs.push(dir);
    const file = path.join(dir, 'event-claims.json');
    writeFileSync(file, '{');
    const time = clock();
    const store = new EventClaimStore({
      filePath: file,
      now: time.now,
      idleLeaseMs: 60_000,
      heartbeatPersistIntervalMs: 5_000,
    });
    expect(store.list()).toEqual([]);
    const seen: number[] = [];
    store.onChanged(() => seen.push(time.now()));
    store.acquire({ key: 'k', sessionId: 's1', pluginId: 'p', label: 'L', group: 'g' });
    const written = JSON.parse(readFileSync(file, 'utf8')) as { claims: { key: string }[] };
    expect(written.claims.map((claim) => claim.key)).toEqual(['k']);
    time.advance(100);
    store.heartbeat('s1');
    time.advance(100);
    store.heartbeat('s1');
    const mid = readFileSync(file, 'utf8');
    time.advance(5_000);
    store.heartbeat('s1');
    expect(readFileSync(file, 'utf8')).not.toBe(mid);
    const reloaded = new EventClaimStore({ filePath: file, now: time.now, idleLeaseMs: 60_000 });
    expect(reloaded.ownerOf('k')).toMatchObject({
      sessionId: 's1',
      label: 'L',
      group: 'g',
      leaseUntil: time.now() + 60_000,
    });
    expect(seen.length).toBe(2);
    const stop = store.onChanged(() => seen.push(-1));
    stop();
    store.release('k', 's1');
    expect(seen).not.toContain(-1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ claims: [] });
  });

  it('单例可替换，未初始化时 peek 为空', () => {
    expect(peekEventClaimStore()).toBeNull();
    const { store } = tempStore();
    setEventClaimStore(store);
    expect(peekEventClaimStore()).toBe(store);
    expect(getEventClaimStore()).toBe(store);
  });
});
