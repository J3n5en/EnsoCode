import type { GuestSessionView } from '@shared/pair/guestProjection';
import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  createPhoneCacheStore,
  type PhoneCacheBackend,
  type PhoneCacheBackendEntry,
  type PhoneCacheData,
} from './sessionCache';

class MemoryBackend implements PhoneCacheBackend {
  readonly records = new Map<string, unknown>();
  failReads = false;
  failWrites = false;
  failRemoves = false;
  private nextGate?: { started: () => void; wait: Promise<void> };

  async read(key: string): Promise<unknown> {
    if (this.failReads) throw new DOMException('denied', 'SecurityError');
    const value = this.records.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async write(
    key: string,
    value: unknown,
    prune: (entries: readonly PhoneCacheBackendEntry[]) => readonly string[]
  ): Promise<void> {
    const gate = this.nextGate;
    this.nextGate = undefined;
    gate?.started();
    if (gate) await gate.wait;
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError');

    const next = new Map(this.records);
    next.set(key, structuredClone(value));
    const entries = [...next].map(([entryKey, entryValue]) => ({
      key: entryKey,
      value: structuredClone(entryValue),
    }));
    for (const stale of prune(entries)) next.delete(stale);
    this.records.clear();
    for (const [entryKey, entryValue] of next) this.records.set(entryKey, entryValue);
  }

  async remove(key: string): Promise<void> {
    if (this.failRemoves) throw new DOMException('denied', 'SecurityError');
    this.records.delete(key);
  }

  blockNextWrite(): { started: Promise<void>; release: () => void } {
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextGate = { started, wait };
    return { started: startedPromise, release };
  }

  corrupt(key: string, mutate: (record: Record<string, unknown>) => void): void {
    const value = structuredClone(this.records.get(key));
    if (!value || typeof value !== 'object') throw new Error('missing fixture');
    const record = value as Record<string, unknown>;
    mutate(record);
    if (record.data !== undefined) {
      record.bytes = new TextEncoder().encode(JSON.stringify(record.data)).byteLength;
    }
    this.records.set(key, value);
  }
}

const projected = (text: string): ProjectedMessage => ({
  role: 'assistant',
  content: [
    { type: 'text', text },
    { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'src/a.ts' } },
  ],
  usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  timing: { stepStartMs: 10, firstTokenMs: 12, completedMs: 20 },
});

const view = (messages: Array<[number, ProjectedMessage]>): GuestSessionView => ({
  messages: new Map(messages),
  status: 'idle',
  approvals: [],
  asks: [],
  tasks: [],
  subagents: [],
});

const data = (
  id = 'session-1',
  messages: ReadonlyArray<readonly [number, ProjectedMessage]> = [[8, projected('hello')]]
): PhoneCacheData => ({
  catalog: [
    {
      id,
      title: '会话',
      projectName: 'Enso',
      projectId: 'project-1',
      cwd: '/repo',
      status: 'idle',
      unread: true,
      pendingAskCount: 0,
      updatedAt: 123,
      pendingApprovalCount: 2,
      muted: true,
      queued: [{ id: 'q1', text: 'later' }],
      goal: { text: 'ship', status: 'active', autoTurns: 1 },
      slashCommands: [{ name: 'review', description: 'Review changes' }],
      context: { used: 5000, window: 200_000 },
      usageTotals: {
        inputTokens: 1200,
        outputTokens: 30,
        cacheHitPercent: 80,
        ttftAvgMs: 812.5,
        tokensPerSecond: 42.5,
      },
    },
  ],
  pinnedOrder: [id],
  projects: [{ id: 'project-1', name: 'Enso', path: '/repo' }],
  projectGroups: [{ id: 'group-1', name: '工作', order: 0 }],
  providers: [{ id: 'provider-1', name: 'Provider', models: [{ id: 'model-1' }] }],
  sessions: [
    {
      id,
      view: view(messages.map(([index, message]) => [index, message])),
      cursor: { epoch: 'epoch-1', seq: 9 },
    },
  ],
});

describe('phone session cache', () => {
  it('按 pair 隔离，并原子恢复 Map 正文与同步游标', async () => {
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({ backend, now: () => 1_000 });
    const rich = data('a');
    Object.assign(rich.sessions[0].view, {
      status: 'running',
      approvals: [{ requestId: 'approval-1', tool: 'bash', kind: 'command', summary: 'pnpm test' }],
      asks: [{ requestId: 'ask-1', question: '继续吗？', options: ['继续'] }],
      retry: { attempt: 1, maxAttempts: 3, delayMs: 500, error: 'network', at: 900 },
      compaction: 'queued',
    });
    await cache.save('pair-a', rich);
    await cache.save('pair-b', data('b', [[3, projected('other')]]));

    const a = await cache.load('pair-a');
    const b = await cache.load('pair-b');
    expect(a?.sessions[0]?.view.messages).toBeInstanceOf(Map);
    expect(a?.sessions[0]?.view.messages.get(8)?.content[1]).toEqual({
      type: 'toolCall',
      id: 'call-1',
      name: 'write',
      arguments: { path: 'src/a.ts' },
    });
    expect(a?.sessions[0]?.cursor).toEqual({ epoch: 'epoch-1', seq: 9 });
    expect(a?.sessions[0]?.view).toMatchObject({
      status: 'running',
      approvals: [{ requestId: 'approval-1', kind: 'command' }],
      asks: [{ requestId: 'ask-1', options: ['继续'] }],
      retry: { attempt: 1, maxAttempts: 3 },
      compaction: 'queued',
    });
    expect(a?.catalog[0]?.pendingApprovalCount).toBe(2);
    expect(a?.catalog[0]?.muted).toBe(true);
    expect(a?.catalog[0]?.context).toEqual(rich.catalog[0]?.context);
    expect(a?.catalog[0]?.usageTotals).toEqual(rich.catalog[0]?.usageTotals);
    expect(b?.sessions[0]?.id).toBe('b');
    expect(b?.sessions[0]?.view.messages.get(3)?.content[0]).toEqual({
      type: 'text',
      text: 'other',
    });
  });

  it('写入只保留白名单投影，不落配对凭据或 metadata 额外字段', async () => {
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({ backend });
    const tainted = data() as PhoneCacheData & { token?: string; contentKey?: string };
    tainted.token = 'pair-token-secret';
    tainted.contentKey = 'pair-content-key-secret';
    (tainted.catalog[0] as (typeof tainted.catalog)[number] & { apiKey?: string }).apiKey =
      'provider-secret';

    await cache.save('pair-a', tainted);
    const raw = JSON.stringify(backend.records.get('pair-a'));
    expect(raw).not.toContain('pair-token-secret');
    expect(raw).not.toContain('pair-content-key-secret');
    expect(raw).not.toContain('provider-secret');
  });

  it('只保留最近会话及每个会话的连续消息尾窗', async () => {
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({
      backend,
      limits: { maxSessions: 2, maxMessages: 3 },
    });
    const input = data();
    input.sessions = Array.from({ length: 7 }, (_, sessionIndex) => ({
      id: `s${sessionIndex}`,
      view: view(Array.from({ length: 6 }, (_, index) => [index + 10, projected(`${index}`)])),
      cursor: { epoch: 'e', seq: sessionIndex },
    }));
    input.sessions[6].view.messages.delete(12);

    await cache.save('pair-a', input);
    const restored = await cache.load('pair-a');
    expect(restored?.sessions.map((session) => session.id)).toEqual(['s5', 's6']);
    expect([...restored!.sessions[0].view.messages.keys()]).toEqual([13, 14, 15]);
    expect([...restored!.sessions[1].view.messages.keys()]).toEqual([13, 14, 15]);
  });

  it('字节预算只从头部裁剪；尾部单条过大时丢整个会话与游标', async () => {
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({ backend, limits: { maxDeviceBytes: 2_000 } });
    const bounded = data();
    bounded.sessions[0].view = view(
      Array.from({ length: 20 }, (_, index) => [index, projected(`${index}:${'x'.repeat(200)}`)])
    );
    await cache.save('bounded', bounded);
    const tail = await cache.load('bounded');
    const keys = [...(tail?.sessions[0]?.view.messages.keys() ?? [])];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThan(20);
    expect(keys).toEqual(
      Array.from({ length: keys.length }, (_, index) => 20 - keys.length + index)
    );
    expect(tail?.sessions[0]?.cursor).toEqual({ epoch: 'epoch-1', seq: 9 });
    expect(
      new TextEncoder().encode(JSON.stringify(backend.records.get('bounded'))).byteLength
    ).toBeLessThanOrEqual(2_000);

    const huge = data('huge', [[0, projected('z'.repeat(10_000))]]);
    await cache.save('huge', huge);
    const withoutSession = await cache.load('huge');
    expect(withoutSession?.sessions).toEqual([]);
  });

  it('schema 不匹配、过期及嵌套消息脏输入均按缓存缺失处理并清理', async () => {
    let now = 1_000;
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({ backend, now: () => now, limits: { ttlMs: 100 } });

    await cache.save('schema', data());
    backend.corrupt('schema', (record) => {
      record.schema = 999;
    });
    expect(await cache.load('schema')).toBeNull();
    expect(backend.records.has('schema')).toBe(false);

    await cache.save('expired', data());
    now = 1_101;
    expect(await cache.load('expired')).toBeNull();
    expect(backend.records.has('expired')).toBe(false);

    now = 1_000;
    await cache.save('dirty', data());
    backend.corrupt('dirty', (record) => {
      const stored = record.data as PhoneCacheData & {
        sessions: Array<{ view: { messages: Array<[number, Record<string, unknown>]> } }>;
      };
      stored.sessions[0].view.messages[0][1].content = [{ type: 'text', text: 42 }];
    });
    expect(await cache.load('dirty')).toBeNull();
  });

  it('拒绝重复消息索引与不安全游标整数', async () => {
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({ backend });
    await cache.save('duplicates', data());
    backend.corrupt('duplicates', (record) => {
      const stored = record.data as PhoneCacheData & {
        sessions: Array<{
          cursor: { seq: number };
          view: { messages: Array<[number, ProjectedMessage]> };
        }>;
      };
      stored.sessions[0].view.messages.push(structuredClone(stored.sessions[0].view.messages[0]));
    });
    expect(await cache.load('duplicates')).toBeNull();

    await cache.save('unsafe', data());
    backend.corrupt('unsafe', (record) => {
      const stored = record.data as PhoneCacheData & {
        sessions: Array<{ cursor: { seq: number } }>;
      };
      stored.sessions[0].cursor.seq = Number.MAX_SAFE_INTEGER + 1;
    });
    expect(await cache.load('unsafe')).toBeNull();

    await cache.save('bad-map', data());
    backend.corrupt('bad-map', (record) => {
      const stored = record.data as { sessions: Array<{ view: { messages: unknown } }> };
      stored.sessions[0].view.messages = { 8: projected('not-a-map') };
    });
    expect(await cache.load('bad-map')).toBeNull();
  });

  it('离线反复读取只更新访问顺序，不能延长正文的新鲜期', async () => {
    let now = 1_000;
    const cache = createPhoneCacheStore({
      backend: new MemoryBackend(),
      now: () => now,
      limits: { ttlMs: 100 },
    });
    await cache.save('stale', data());
    now = 1_090;
    expect(await cache.load('stale')).not.toBeNull();
    now = 1_101;
    expect(await cache.load('stale')).toBeNull();
  });

  it('全局记录按访问时间做 LRU，并同时受总字节上限约束', async () => {
    let now = 1;
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({ backend, now: () => now, limits: { maxRecords: 2 } });
    await cache.save('p1', data('s1'));
    now = 2;
    await cache.save('p2', data('s2'));
    now = 3;
    await cache.load('p1');
    now = 4;
    await cache.save('p3', data('s3'));
    expect([...backend.records.keys()].sort()).toEqual(['p1', 'p3']);

    const tinyBackend = new MemoryBackend();
    const tiny = createPhoneCacheStore({
      backend: tinyBackend,
      limits: { maxTotalBytes: 1, maxDeviceBytes: 1_000_000 },
    });
    await tiny.save('too-large-globally', data());
    expect(tinyBackend.records.size).toBe(0);
  });

  it('配额/权限/访问失败全部 resolve，失败写不会拆开或覆盖旧正文与游标', async () => {
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({ backend });
    await cache.save('pair-a', data('old'));
    backend.failWrites = true;
    await expect(
      cache.save('pair-a', data('new', [[9, projected('new')]]))
    ).resolves.toBeUndefined();
    const old = await cache.load('pair-a');
    expect(old?.sessions[0]?.id).toBe('old');
    expect(old?.sessions[0]?.view.messages.get(8)?.content[0]).toEqual({
      type: 'text',
      text: 'hello',
    });
    expect(old?.sessions[0]?.cursor).toEqual({ epoch: 'epoch-1', seq: 9 });

    backend.failReads = true;
    await expect(cache.load('pair-a')).resolves.toBeNull();
    backend.failReads = false;
    backend.failRemoves = true;
    await expect(cache.clear('pair-a')).resolves.toBeUndefined();
  });

  it('clear 排在同 pair 在途 save 后，最终不会被旧写复活', async () => {
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({ backend });
    const gate = backend.blockNextWrite();
    const saving = cache.save('pair-a', data());
    await gate.started;
    const clearing = cache.clear('pair-a');
    gate.release();
    await Promise.all([saving, clearing]);
    expect(await cache.load('pair-a')).toBeNull();
    expect(backend.records.has('pair-a')).toBe(false);
  });

  it('IndexedDB 不可用或 open 永不回调时有界降级，不悬挂', async () => {
    const unavailable = createPhoneCacheStore({ indexedDB: undefined });
    await expect(unavailable.load('pair-a')).resolves.toBeNull();
    await expect(unavailable.save('pair-a', data())).resolves.toBeUndefined();

    const stalled = {
      open: () => ({}) as IDBOpenDBRequest,
    } as unknown as IDBFactory;
    const timed = createPhoneCacheStore({ indexedDB: stalled, openTimeoutMs: 5 });
    await expect(timed.load('pair-a')).resolves.toBeNull();

    const request = {} as IDBOpenDBRequest;
    const blockedFactory = {
      open: () => {
        queueMicrotask(() => request.onblocked?.({} as IDBVersionChangeEvent));
        return request;
      },
    } as unknown as IDBFactory;
    const blocked = createPhoneCacheStore({ indexedDB: blockedFactory, openTimeoutMs: 50 });
    await expect(blocked.load('pair-a')).resolves.toBeNull();
  });

  it('单条脏消息不丢掉整段可解析正文', async () => {
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({ backend });
    const mixed = data('session-1', [
      [8, projected('hello')],
      [9, { role: 'assistant', content: [{ type: 'text', text: 42 }] } as never],
    ]);
    await cache.save('pair-a', mixed);
    const loaded = await cache.load('pair-a');
    expect(loaded?.sessions[0]?.view.messages.get(8)?.content[0]).toEqual({
      type: 'text',
      text: 'hello',
    });
    expect(loaded?.sessions[0]?.view.messages.has(9)).toBe(false);
  });

  it('目录里个别脏条目仍保存其余会话和游标', async () => {
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({ backend });
    const mixed = data();
    mixed.catalog = [...mixed.catalog, { id: 1 } as never];
    await cache.save('pair-a', mixed);
    const loaded = await cache.load('pair-a');
    expect(loaded?.catalog.map((entry) => entry.id)).toEqual(['session-1']);
    expect(loaded?.sessions[0]?.cursor).toEqual({ epoch: 'epoch-1', seq: 9 });
  });

  it('占用与统计脏值只丢该字段，不丢目录条目', async () => {
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({ backend });
    const dirty = data();
    Object.assign(dirty.catalog[0], {
      context: { used: -1, window: 'x' },
      usageTotals: { inputTokens: -1, outputTokens: 'x' },
    });
    await cache.save('pair-a', dirty);
    const loaded = await cache.load('pair-a');
    expect(loaded?.catalog[0]?.id).toBe('session-1');
    expect(loaded?.catalog[0]).not.toHaveProperty('context');
    expect(loaded?.catalog[0]).not.toHaveProperty('usageTotals');
  });

  it('编码失败时保留旧缓存，不能把已有正文删成打开后再读历史', async () => {
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({ backend });
    await cache.save('pair-a', data());
    await cache.save('pair-a', {
      ...data(),
      sessions: undefined as unknown as PhoneCacheData['sessions'],
    });
    const loaded = await cache.load('pair-a');
    expect(loaded?.sessions[0]?.view.messages.get(8)?.content[0]).toEqual({
      type: 'text',
      text: 'hello',
    });
  });

  it('手机瘦身帧（项目无 path、非订阅无 projectName）仍保存目录、项目和游标', async () => {
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({ backend });
    const slim = data();
    delete (slim.projects[0] as { path?: string }).path;
    slim.catalog.push({
      id: 'other',
      title: 'Other',
      projectId: 'project-1',
      status: 'idle',
    } as PhoneCacheData['catalog'][number]);
    await cache.save('pair-a', slim);
    const loaded = await cache.load('pair-a');
    expect(loaded?.sessions[0]?.cursor).toEqual({ epoch: 'epoch-1', seq: 9 });
    expect(loaded?.projects[0]).toMatchObject({ id: 'project-1', name: 'Enso' });
    expect(loaded?.catalog.map((entry) => entry.id).sort()).toEqual(['other', 'session-1']);
  });

  it('元数据数组全部不可解析时仍保存会话游标', async () => {
    const backend = new MemoryBackend();
    const cache = createPhoneCacheStore({ backend });
    await cache.save('pair-a', {
      ...data(),
      catalog: [{ id: 1 }] as unknown as PhoneCacheData['catalog'],
      projects: [{ id: 1 }] as unknown as PhoneCacheData['projects'],
      projectGroups: [{ id: 1 }] as unknown as PhoneCacheData['projectGroups'],
      providers: [{ id: 1 }] as unknown as PhoneCacheData['providers'],
    });
    const loaded = await cache.load('pair-a');
    expect(loaded?.sessions[0]?.cursor).toEqual({ epoch: 'epoch-1', seq: 9 });
    expect(loaded?.catalog).toEqual([]);
    expect(loaded?.projects).toEqual([]);
  });
});
