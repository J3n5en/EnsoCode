import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from './db';
import { applyExtraction } from './kg';
import { buildFtsMatchQuery, searchMemories } from './search';
import { createMemory, updateMemory } from './store';
import { type Embedder, projectSpaceId } from './types';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-memory-search-'));
  db = openMemoryDb(path.join(dir, 'memory.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 按关键字表打向量：文本含 key 则该维=1，便于构造可预测的余弦排序 */
function keywordEmbedder(keys: string[], opts: { failOn?: 'query' | 'passage' } = {}): Embedder {
  return {
    model: 'kw',
    dim: keys.length,
    embed: async (text, kind) => {
      if (opts.failOn === kind) throw new Error('embed failed');
      const v = Float32Array.from(keys.map((k) => (text.toLowerCase().includes(k) ? 1 : 0)));
      return v.some((x) => x > 0) ? v : null;
    },
  };
}

async function add(content: string, spaceId = 'global', embedder?: Embedder, extra = {}) {
  const r = await createMemory(db, { content, spaceId, ...extra }, { embedder });
  if (r.status !== 'inserted') throw new Error();
  return r.memory;
}

const ids = (hits: { memory: { id: string } }[]) => hits.map((h) => h.memory.id);

describe('buildFtsMatchQuery', () => {
  it('quotes tokens and escapes embedded double quotes', () => {
    expect(buildFtsMatchQuery('post"gres data* x (y)')).toEqual({
      match: '"post" OR "gres" OR "data"',
      short: ['x', 'y'],
    });
  });

  it('routes tokens shorter than 3 chars to LIKE fallback (trigram limit)', () => {
    expect(buildFtsMatchQuery('主库 Postgres')).toEqual({ match: '"Postgres"', short: ['主库'] });
    expect(buildFtsMatchQuery('  ')).toEqual({ match: '', short: [] });
  });
});

describe('searchMemories — FTS channel', () => {
  it('finds Chinese memories by 2-char and 4-char substrings', async () => {
    const m = await add('我们决定用 Postgres 做主库，读写分离后续再议');
    await add('偏好深色主题');
    expect(ids(await searchMemories(db, { q: '主库', spaceIds: ['global'] }))).toEqual([m.id]);
    expect(ids(await searchMemories(db, { q: '读写分离', spaceIds: ['global'] }))).toEqual([m.id]);
    expect(ids(await searchMemories(db, { q: 'Postgres', spaceIds: ['global'] }))).toEqual([m.id]);
  });

  it('finds English memories including substring forms', async () => {
    const m = await add('Use PostgreSQL as the primary database after benchmarking');
    await add('偏好深色主题');
    expect(ids(await searchMemories(db, { q: 'postgres', spaceIds: ['global'] }))).toEqual([m.id]);
    expect(ids(await searchMemories(db, { q: 'primary database', spaceIds: ['global'] }))).toEqual([
      m.id,
    ]);
  });

  it('does not throw on FTS special characters', async () => {
    const m = await add('quote " star * paren ( colon : dash -');
    await expect(searchMemories(db, { q: '"*(:-', spaceIds: ['global'] })).resolves.toBeDefined();
    expect(ids(await searchMemories(db, { q: 'star*', spaceIds: ['global'] }))).toEqual([m.id]);
  });

  it('returns empty for blank query or no matches', async () => {
    await add('something');
    expect(await searchMemories(db, { q: '   ', spaceIds: ['global'] })).toEqual([]);
    expect(await searchMemories(db, { q: 'zzzzzz', spaceIds: ['global'] })).toEqual([]);
  });
});

describe('searchMemories — filters', () => {
  it('hides non-latest and non-active rows', async () => {
    const old = await add('Postgres v1 决策');
    const cur = await add('Postgres v2 决策');
    const archived = await add('Postgres archived');
    updateMemory(db, old.id, { isLatest: false });
    updateMemory(db, archived.id, { lifecycleState: 'archived' });
    const hits = await searchMemories(db, { q: 'Postgres', spaceIds: ['global'] });
    expect(ids(hits)).toEqual([cur.id]);
    expect(hits.every((h) => h.memory.isLatest)).toBe(true);
  });

  it('isolates projects but merges global', async () => {
    const p1 = projectSpaceId('p1');
    const p2 = projectSpaceId('p2');
    const g = await add('k8s cluster notes global', 'global');
    const a = await add('k8s cluster notes for p1', p1);
    await add('k8s cluster notes for p2', p2);
    expect(ids(await searchMemories(db, { q: 'k8s', spaceIds: [p1] }))).toEqual([a.id]);
    const merged = ids(await searchMemories(db, { q: 'k8s', spaceIds: ['global', p1] }));
    expect(merged).toHaveLength(2);
    expect(merged).toEqual(expect.arrayContaining([g.id, a.id]));
    expect(await searchMemories(db, { q: 'k8s', spaceIds: [] })).toEqual([]);
  });
});

describe('searchMemories — 双时间检索', () => {
  const NOW = new Date('2025-06-15T00:00:00Z');
  const search = (extra: Record<string, unknown>) =>
    searchMemories(db, { q: 'x', spaceIds: ['global'], now: NOW, ...extra });

  it('按年过滤事件日期：event_start=2020 存 2020-01-01/year，按年查到', async () => {
    const m = await add('x 2020 年的决定', 'global', undefined, { eventStart: '2020' });
    await add('x 无日期');
    expect(m.eventStart).toBe('2020-01-01');
    expect(m.temporalPrecision).toBe('year');
    expect(ids(await search({ eventDateFrom: '2020', eventDateTo: '2020' }))).toEqual([m.id]);
    expect(await search({ eventDateFrom: '2021', eventDateTo: '2021' })).toEqual([]);
  });

  it('区间相交：记忆区间按精度补齐，查询区间也按精度补齐；只给 from / 只给 to', async () => {
    const yr = await add('x 2020 全年', 'global', undefined, { eventStart: '2020' });
    const range = await add('x 2019-11 到 2020-02', 'global', undefined, {
      eventStart: '2019-11',
      eventEnd: '2020-02',
    });
    const day = await add('x 2021-03-05', 'global', undefined, { eventStart: '2021-03-05' });
    // 2020-12 与 year=2020 区间 [2020-01-01, 2020-12-31] 相交；与 range 不相交
    expect(ids(await search({ eventDateFrom: '2020-12', eventDateTo: '2020-12' }))).toEqual([
      yr.id,
    ]);
    // 2020-01 与 yr 和 range 都相交
    expect(ids(await search({ eventDateFrom: '2020-01', eventDateTo: '2020-01' })).sort()).toEqual(
      [yr.id, range.id].sort()
    );
    // 只给 from：2021 及以后
    expect(ids(await search({ eventDateFrom: '2021' }))).toEqual([day.id]);
    // 只给 to：2019 年内结束前开始的 → range 从 2019-11 开始
    expect(ids(await search({ eventDateTo: '2019' }))).toEqual([range.id]);
    // day 精度查询命中 day 精度记忆
    expect(ids(await search({ eventDateFrom: '2021-03-05', eventDateTo: '2021-03-05' }))).toEqual([
      day.id,
    ]);
    expect(await search({ eventDateFrom: '2021-03-06', eventDateTo: '2021-03-06' })).toEqual([]);
  });

  it('timeless 不命中事件日期过滤，即使带 event_start', async () => {
    const tl = await add('x timeless 但有日期', 'global', undefined, {
      eventStart: '2020',
      temporalContext: 'timeless',
    });
    expect(tl.eventStart).toBe('2020-01-01');
    expect(await search({ eventDateFrom: '2020', eventDateTo: '2020' })).toEqual([]);
    expect(ids(await search({}))).toEqual([tl.id]);
  });

  it('recorded_date 滤 created_at，与事件日期无关', async () => {
    const early = await createMemory(
      db,
      { content: 'x early recorded', spaceId: 'global', eventStart: '2030' },
      { now: new Date('2024-01-10T08:00:00Z') }
    );
    const late = await createMemory(
      db,
      { content: 'x late recorded', spaceId: 'global' },
      { now: new Date('2025-05-01T08:00:00Z') }
    );
    if (early.status !== 'inserted' || late.status !== 'inserted') throw new Error();
    expect(ids(await search({ recordedDateFrom: '2024', recordedDateTo: '2024' }))).toEqual([
      early.memory.id,
    ]);
    expect(ids(await search({ recordedDateFrom: '2025-05' }))).toEqual([late.memory.id]);
    expect(ids(await search({ recordedDateTo: '2024-01-10' }))).toEqual([early.memory.id]);
  });

  it('混用 / 非法日期 / 结束早于开始 → 校验错误', async () => {
    await expect(search({ eventDateFrom: '2020', recordedDateTo: '2020' })).rejects.toMatchObject({
      code: 'temporal_filter_conflict',
    });
    await expect(search({ eventDateFrom: 'yesterday' })).rejects.toMatchObject({
      code: 'invalid_date',
    });
    await expect(search({ eventDateFrom: '2021', eventDateTo: '2020' })).rejects.toMatchObject({
      code: 'date_range',
    });
    await expect(
      search({ recordedDateFrom: '2021-02', recordedDateTo: '2021-01' })
    ).rejects.toMatchObject({ code: 'date_range' });
  });

  it('时间意图（正则门）：年份匹配的记忆获得 temporal boost，进入 finalScore 第三参', async () => {
    const hit = await add('postgres decision made', 'global', undefined, { eventStart: '2020' });
    const other = await add('postgres decision revisited', 'global', undefined, {
      eventStart: '2023',
    });
    const plain = await add('postgres decision undated');
    const hits = await searchMemories(db, {
      q: 'postgres decision 2020',
      spaceIds: ['global'],
      now: NOW,
    });
    expect(hits).toHaveLength(3);
    expect(hits[0].memory.id).toBe(hit.id);
    expect(hits[0].score).toBeGreaterThan(1);
    // 无 event_start 的记忆 boost=0，走无意图公式，不可能超过 1
    expect(hits.find((h) => h.memory.id === plain.id)!.score).toBeLessThanOrEqual(1);
    expect(hits.find((h) => h.memory.id === other.id)!.score).toBeLessThan(hits[0].score);
    // 单结果 semantic=1：年份匹配的精确公式 0.7 + decay*0.15 + (recency*0.3 + 0.8*conf*0.7)
    const [only] = await searchMemories(db, { q: 'made 2020', spaceIds: ['global'], now: NOW });
    expect(only.memory.id).toBe(hit.id);
    const days = (NOW.getTime() - Date.parse('2020-01-01T00:00:00Z')) / 86_400_000;
    const boost = (1 / (1 + days / 365)) * 0.3 + 0.8 * 1 * 0.7;
    expect(only.score).toBeCloseTo(0.7 + 0.15 * only.decay + boost, 9);
    // 没有时间意图时不加 boost
    const [plainHit] = await searchMemories(db, { q: 'made', spaceIds: ['global'], now: NOW });
    expect(plainHit.score).toBeCloseTo(0.85 + 0.15 * plainHit.decay, 9);
  });
});

describe('searchMemories — hybrid', () => {
  it('single result gets semantic=1.0 and score = finalScore(1, decay)', async () => {
    const m = await add('only one memory about Redis');
    const [hit] = await searchMemories(db, { q: 'Redis', spaceIds: ['global'] });
    expect(hit.memory.id).toBe(m.id);
    expect(hit.rrf).toBeCloseTo(1 / 61, 9);
    expect(hit.score).toBeCloseTo(0.85 + 0.15 * hit.decay, 9);
  });

  it('fuses FTS and vector channels with RRF', async () => {
    const emb = keywordEmbedder(['redis', 'cache']);
    // 只有向量能召回：正文无 "cache" 字样但 embedding 落在 cache 维
    const vecOnly = await add('Redis 用来做缓存层', 'global', {
      ...emb,
      embed: async () => Float32Array.from([0, 1]),
    });
    // 只有 FTS 能召回：正文含 cache，但向量与查询正交
    const ftsOnly = await add('cache invalidation strategy', 'global', {
      ...emb,
      embed: async () => Float32Array.from([1, 0]),
    });
    // 两路都命中
    const both = await add('Redis cache eviction policy', 'global', emb);
    const hits = await searchMemories(db, { q: 'cache', spaceIds: ['global'], embedder: emb });
    expect(hits[0].memory.id).toBe(both.id);
    expect(ids(hits)).toEqual(expect.arrayContaining([vecOnly.id, ftsOnly.id]));
    expect(hits).toHaveLength(3);
  });

  it('ignores vectors from a different embedding model', async () => {
    const other: Embedder = {
      ...keywordEmbedder(['cache']),
      embed: async () => Float32Array.from([1]),
    };
    const m = await add('Redis 缓存', 'global', other);
    const current: Embedder = { ...keywordEmbedder(['cache']), model: 'kw-v2' };
    expect(
      await searchMemories(db, { q: 'cache', spaceIds: ['global'], embedder: current })
    ).toEqual([]);
    expect(
      ids(await searchMemories(db, { q: 'cache', spaceIds: ['global'], embedder: other }))
    ).toEqual([m.id]);
  });

  it('sqlite-vec 不可用时：落库仍带 BLOB，检索降级纯 FTS，不抛错', async () => {
    db.close();
    db = openMemoryDb(path.join(dir, 'novec.db'), { vecExtensionPath: null });
    const emb = keywordEmbedder(['cache']);
    const vecOnly = await add('Redis 缓存层', 'global', {
      ...emb,
      embed: async () => Float32Array.from([1]),
    });
    const ftsHit = await add('cache invalidation', 'global', emb);
    expect(vecOnly.embeddingModel).toBe('kw');
    const hits = await searchMemories(db, { q: 'cache', spaceIds: ['global'], embedder: emb });
    expect(ids(hits)).toEqual([ftsHit.id]);
    expect(hits[0].rrf).toBeCloseTo(1 / 61, 10);
  });

  it('vec 表随内容更新清除：改正文后旧向量不再被 KNN 召回', async () => {
    const emb = keywordEmbedder(['cache']);
    const m = await add('Redis cache layer', 'global', emb);
    updateMemory(db, m.id, { content: 'totally unrelated text' });
    db.exec('DROP TABLE memories_fts');
    expect(await searchMemories(db, { q: 'cache', spaceIds: ['global'], embedder: emb })).toEqual(
      []
    );
  });

  it('falls back to FTS when the vector channel fails', async () => {
    const emb = keywordEmbedder(['cache'], { failOn: 'query' });
    const m = await add('cache invalidation', 'global', emb);
    expect(
      ids(await searchMemories(db, { q: 'cache', spaceIds: ['global'], embedder: emb }))
    ).toEqual([m.id]);
  });

  it('生产路径（无 embedder）：向量通道为空，纯 FTS 单通道仍出结果', async () => {
    const m = await add('cache invalidation strategy');
    const hits = await searchMemories(db, { q: 'cache', spaceIds: ['global'] });
    expect(ids(hits)).toEqual([m.id]);
    // 单通道 RRF：1/(60+1)
    expect(hits[0].rrf).toBeCloseTo(1 / 61, 10);
  });

  it('MATCH 抛错时 LIKE 回退仍执行（短词/中文不因 FTS 故障丢失）', async () => {
    const m = await add('我们决定用 Postgres 做主库');
    await add('偏好深色主题');
    db.exec('DROP TABLE memories_fts');
    // 'Postgres' 走 MATCH（表已不存在→抛错），'主库' 走 LIKE
    expect(ids(await searchMemories(db, { q: 'Postgres 主库', spaceIds: ['global'] }))).toEqual([
      m.id,
    ]);
  });

  it('falls back to vector when the FTS channel fails', async () => {
    const emb = keywordEmbedder(['cache']);
    const m = await add('Redis cache layer', 'global', emb);
    db.exec('DROP TABLE memories_fts');
    expect(
      ids(await searchMemories(db, { q: 'cache', spaceIds: ['global'], embedder: emb }))
    ).toEqual([m.id]);
  });

  it('keeps RRF order when decay is equal', async () => {
    const emb = keywordEmbedder(['cache']);
    const strong = await add('cache cache cache layer', 'global', emb);
    const weak = await add(
      'a note that mentions cache once among many other unrelated words',
      'global'
    );
    const hits = await searchMemories(db, { q: 'cache', spaceIds: ['global'], embedder: emb });
    expect(ids(hits)).toEqual([strong.id, weak.id]);
    expect(hits[0].decay).toBe(hits[1].decay);
  });

  it('prefers higher decay when RRF ties', async () => {
    // A 只在 FTS 命中 rank1，B 只在向量命中 rank1 → RRF 相同
    const emb = keywordEmbedder(['zebra']);
    const a = await add('zebra note', 'global');
    const b = await add('striped animal', 'global', {
      ...emb,
      embed: async () => Float32Array.from([1]),
    });
    const stale =
      "UPDATE memories SET last_accessed_at = '2000-01-01T00:00:00.000Z', importance = ? WHERE id = ?";
    db.prepare(stale).run(0, a.id);
    db.prepare(stale).run(1, b.id);
    let hits = await searchMemories(db, { q: 'zebra', spaceIds: ['global'], embedder: emb });
    expect(hits.map((h) => h.rrf)).toEqual([1 / 61, 1 / 61]);
    expect(ids(hits)).toEqual([b.id, a.id]);

    db.prepare(stale).run(1, a.id);
    db.prepare(stale).run(0, b.id);
    hits = await searchMemories(db, { q: 'zebra', spaceIds: ['global'], embedder: emb });
    expect(ids(hits)).toEqual([a.id, b.id]);
  });

  it('increments appearances for returned hits (best-effort)', async () => {
    const m = await add('appearance counter');
    await searchMemories(db, { q: 'appearance', spaceIds: ['global'] });
    await searchMemories(db, { q: 'appearance', spaceIds: ['global'] });
    const row = db.prepare('SELECT appearances FROM memories WHERE id = ?').get(m.id) as {
      appearances: number;
    };
    expect(row.appearances).toBe(2);
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) await add(`limit test ${i}`);
    expect(
      await searchMemories(db, { q: 'limit test', spaceIds: ['global'], limit: 2 })
    ).toHaveLength(2);
  });
});

describe('searchMemories — MMR 去冗余', () => {
  // 三条 redis 近似记忆共享同一向量方向，一条 kafka 异题但与查询仍有中等相关；再加一条只命中 FTS
  // 的长杂项垄底（min-max 归一化后它是 0，避免 kafka 被归一化压到 0 失去可比性）
  const emb: Embedder = {
    model: 'kw',
    dim: 3,
    embed: async (text, kind) => {
      if (kind === 'query') return Float32Array.from([0.9, 0, 0.44]);
      const t = text.toLowerCase();
      if (t.includes('kafka')) return Float32Array.from([0, 0, 1]);
      if (t.includes('redis')) return Float32Array.from([1, t.includes('cluster') ? 0.1 : 0, 0]);
      return Float32Array.from([0, 1, 0]);
    },
  };
  async function seed() {
    const r1 = await add('note redis cache primary', 'global', emb);
    const r2 = await add('note redis cache replica', 'global', emb);
    const r3 = await add('note redis cluster cache', 'global', emb);
    const k = await add('note kafka broker topic', 'global', emb);
    const filler = await add('note misc misc misc misc misc misc misc misc', 'global', emb);
    return { redis: [r1.id, r2.id, r3.id], kafka: k.id, filler: filler.id };
  }

  it('mmr 开：limit=2 结果包含异题 kafka；关：两条都是 redis', async () => {
    const { redis, kafka } = await seed();
    const on = await searchMemories(db, {
      q: 'note redis',
      spaceIds: ['global'],
      embedder: emb,
      limit: 2,
      mmr: true,
    });
    expect(on).toHaveLength(2);
    expect(ids(on)).toContain(kafka);
    expect(redis).toContain(ids(on)[0]);
    const off = await searchMemories(db, {
      q: 'note redis',
      spaceIds: ['global'],
      embedder: emb,
      limit: 2,
      mmr: false,
    });
    expect(ids(off).every((id) => redis.includes(id))).toBe(true);
  });

  it('降级：无 embedder（无向量可比）时 mmr 为空操作，顺序与关掉时一致', async () => {
    await add('note redis cache primary');
    await add('note redis cache replica');
    await add('note kafka broker topic');
    const on = await searchMemories(db, { q: 'note', spaceIds: ['global'], limit: 2, mmr: true });
    const off = await searchMemories(db, { q: 'note', spaceIds: ['global'], limit: 2, mmr: false });
    expect(ids(on)).toEqual(ids(off));
    expect(on).toHaveLength(2);
  });

  it('mmr 只在候选池内重排：limit ≥ 命中数时不丢条、首位不变', async () => {
    const { redis, kafka, filler } = await seed();
    const on = await searchMemories(db, {
      q: 'note',
      spaceIds: ['global'],
      embedder: emb,
      limit: 10,
      mmr: true,
    });
    expect(ids(on).sort()).toEqual([...redis, kafka, filler].sort());
    const off = await searchMemories(db, {
      q: 'note',
      spaceIds: ['global'],
      embedder: emb,
      limit: 10,
      mmr: false,
    });
    expect(ids(on)[0]).toBe(ids(off)[0]);
  });
});

describe('searchMemories — 向量通道按 space 分区', () => {
  // 接近向量：文本含 'near' 的行 cos 更高；本 space 行只含 'topic' 但仍与查询正相关
  const emb: Embedder = {
    model: 'kw',
    dim: 2,
    embed: async (text) =>
      text.includes('near') ? Float32Array.from([1, 0.1]) : Float32Array.from([1, 1]),
  };
  const proj = projectSpaceId('p1');

  it('大量外 space 行更接近查询时，项目内查询仍能靠向量通道召回本 space 记忆（Major 4）', async () => {
    // 200 条 global 行都比项目行更贴近查询；若 KNN 不按 space 分区，top-k 全是 global，项目行被 JOIN 滤掉后通道为空
    for (let i = 0; i < 200; i++) await add(`near filler ${i}`, 'global', emb);
    const mine = await add('topic only in project', proj, emb);
    // 查询词不在正文里：FTS/LIKE 必定零命中，命中只可能来自向量通道
    const hits = await searchMemories(db, { q: 'zzz near', spaceIds: [proj], embedder: emb });
    expect(ids(hits)).toEqual([mine.id]);
  });

  it('多 space 查询时两边都能进 KNN', async () => {
    const g = await add('near global', 'global', emb);
    const p = await add('near project', proj, emb);
    const hits = await searchMemories(db, {
      q: 'zzz near',
      spaceIds: ['global', proj],
      embedder: emb,
    });
    expect(ids(hits).sort()).toEqual([g.id, p.id].sort());
  });

  it('基表行删除 / 取消 is_latest 后，vec 行不再占 KNN 名额（Minor 6）', async () => {
    const dead = await add('near dead', 'global', emb);
    const old = await add('near superseded', 'global', emb);
    const live = await add('topic live', 'global', emb);
    db.prepare('DELETE FROM memories WHERE id = ?').run(dead.id);
    updateMemory(db, old.id, { isLatest: false });
    const count = () =>
      (db.prepare('SELECT count(*) AS n FROM memory_vec_2').get() as { n: number }).n;
    // 取消 is_latest 在事务内同步删 vec 行；裸 DELETE 的孤儿由重开库的 syncVecTables 清理
    expect(count()).toBe(2);
    db.close();
    db = openMemoryDb(path.join(dir, 'memory.db'));
    expect(count()).toBe(1);
    const hits = await searchMemories(db, {
      q: 'zzz near',
      spaceIds: ['global'],
      embedder: emb,
      limit: 1,
    });
    expect(ids(hits)).toEqual([live.id]);
  });
});

describe('searchMemories — 实体通道（三通道并集）', () => {
  const entity = (memory: { id: string; spaceId: string }, name: string, aliases: string[] = []) =>
    applyExtraction(db, memory, {
      entities: [{ name, type: 'PRODUCT', description: null, confidence: 0.9, aliases }],
      relations: [],
    });

  it('正文不含该词、只 MENTIONS 同一实体的记忆也被召回', async () => {
    const literal = await add('Kubernetes 上线流程已经跑通');
    const paraphrase = await add('集群编排方案确定，后续按此推进');
    entity(literal, 'Kubernetes');
    entity(paraphrase, 'Kubernetes');
    const hits = ids(await searchMemories(db, { q: 'Kubernetes', spaceIds: ['global'] }));
    expect(hits.sort()).toEqual([literal.id, paraphrase.id].sort());
    // 没有实体层时这条查询只能命中字面那条
    db.exec('DELETE FROM mentions');
    expect(ids(await searchMemories(db, { q: 'Kubernetes', spaceIds: ['global'] }))).toEqual([
      literal.id,
    ]);
  });

  it('别名与不同书写命中同一实体', async () => {
    const m = await add('集群编排方案确定');
    entity(m, 'K8s', ['Kubernetes']);
    for (const q of ['Kubernetes', 'kubernetes', 'k8s', '用 K-8-S 部署吗']) {
      expect(ids(await searchMemories(db, { q, spaceIds: ['global'] }))).toEqual([m.id]);
    }
  });

  it('实体按 space 隔离，也不召回非最新 / 非活动记忆', async () => {
    const proj = projectSpaceId('p1');
    const mine = await add('集群编排方案确定', proj);
    const other = await add('别的项目的编排方案', 'global');
    const stale = await add('旧的编排方案', proj);
    entity(mine, 'Kubernetes');
    entity(other, 'Kubernetes');
    entity(stale, 'Kubernetes');
    updateMemory(db, stale.id, { isLatest: false });
    expect(ids(await searchMemories(db, { q: 'Kubernetes', spaceIds: [proj] }))).toEqual([mine.id]);
  });

  it('单字实体不参与匹配（噪声下限）', async () => {
    const m = await add('集群编排方案确定');
    entity(m, 'K');
    expect(await searchMemories(db, { q: 'K 方案怎么定的', spaceIds: ['global'] })).toEqual([]);
  });

  it('实体表缺失时通道降级为空，FTS 结果不受影响', async () => {
    const m = await add('Kubernetes 上线流程已经跑通');
    db.exec('DROP TABLE mentions');
    expect(ids(await searchMemories(db, { q: 'Kubernetes', spaceIds: ['global'] }))).toEqual([
      m.id,
    ]);
  });
});

describe('searchMemories — mode fast vs deep', () => {
  it('fast 等权 RRF 保持 FTS 优先；deep 关系问句抬实体通道', async () => {
    // 先写实体-only，再写 FTS-only：等权时 min-max 拉平 RRF，updated_at 让较新的字面命中排前。
    const paraphrase = await add('集群编排方案确定，后续按此推进');
    applyExtraction(db, paraphrase, {
      entities: [
        { name: 'Postgres', type: 'PRODUCT', description: null, confidence: 0.9, aliases: [] },
      ],
      relations: [],
    });
    const literal = await add('We chose Postgres as the primary database');
    const q = 'how Postgres relates to the database choice';
    const fast = ids(await searchMemories(db, { q, spaceIds: ['global'] }));
    const deep = ids(await searchMemories(db, { q, spaceIds: ['global'], mode: 'deep' }));
    expect(fast[0]).toBe(literal.id);
    expect(deep[0]).toBe(paraphrase.id);
    expect(new Set(fast)).toEqual(new Set([literal.id, paraphrase.id]));
    expect(new Set(deep)).toEqual(new Set([literal.id, paraphrase.id]));
  });
});

describe('searchMemories — decay 在候选池上生效', () => {
  // 12 条都命中 LIKE 通道（2 字查询），RRF 名次 = updated_at 倒序：#11 rank1、#10 rank2、#9 rank3。
  // 全部 importance=0、200 天未访问 → decay 落到 floor 0.3；只把 rank3 提成「刚访问 + 访问 100 次」→ decay 1.0。
  // 旧逻辑先截 limit=2 再混分，rank3 永远进不来；扩池后 rank3 的 0.85*sem+0.15 > rank2 的 0.85*sem+0.045。
  const SEARCH_NOW = new Date('2025-08-01T00:00:00Z');
  const BASE = new Date('2025-01-10T00:00:00Z');

  async function seed() {
    const created: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await createMemory(
        db,
        { content: `pg note ${i}`, spaceId: 'global', importance: 0 },
        { now: new Date(BASE.getTime() + i * 60_000) }
      );
      if (r.status !== 'inserted') throw new Error();
      created.push(r.memory.id);
    }
    const rank1 = created[11];
    const rank2 = created[10];
    const rank3 = created[9];
    const tail = created[0];
    db.prepare('UPDATE memories SET last_accessed_at = ?, access_count = 100 WHERE id = ?').run(
      SEARCH_NOW.toISOString(),
      rank3
    );
    return { rank1, rank2, rank3, tail };
  }

  it('RRF 排在 limit 之外但 decay 高的记忆能进最终结果', async () => {
    const { rank1, rank2, rank3 } = await seed();
    const hits = await searchMemories(db, {
      q: 'pg',
      spaceIds: ['global'],
      limit: 2,
      now: SEARCH_NOW,
    });
    expect(ids(hits)).toEqual([rank1, rank3]);
    expect(ids(hits)).not.toContain(rank2);
    // RRF 仍按原名次报告，证明是 decay 而非通道顺序把它拉进来的
    expect(hits[0].rrf).toBeGreaterThan(hits[1].rrf);
    expect(hits[1].decay).toBeGreaterThan(hits[0].decay);
  });

  it('appearances 只对最终返回的条目 +1，不对整个候选池计数', async () => {
    const { rank1, rank2, rank3, tail } = await seed();
    await searchMemories(db, { q: 'pg', spaceIds: ['global'], limit: 2, now: SEARCH_NOW });
    const count = (id: string) =>
      (
        db.prepare('SELECT appearances FROM memories WHERE id = ?').get(id) as {
          appearances: number;
        }
      ).appearances;
    expect(count(rank1)).toBe(1);
    expect(count(rank3)).toBe(1);
    expect(count(rank2)).toBe(0);
    expect(count(tail)).toBe(0);
  });
});
