import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MEMORY_SCHEMA_VERSION, openMemoryDb, VEC_CHUNK_SIZE, vecTableName } from './db';
import { getHitStats, listStaleMemories, planVecCompaction, runVecCompaction } from './maintenance';
import { searchMemories } from './search';
import { createMemory, encodeEmbedding, vecInsert } from './store';
import type { Embedder } from './types';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-memory-maint-'));
  db = openMemoryDb(path.join(dir, 'memory.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 直接落库 + 入向量索引，绕过创建路径的去重/候选网，便于构造确定的库状态 */
function put(
  conn: Database.Database,
  id: string,
  opts: { spaceId?: string; createdAt?: string; vec?: Float32Array | null } = {}
): void {
  const spaceId = opts.spaceId ?? 'global';
  const at = opts.createdAt ?? '2025-01-01T00:00:00.000Z';
  const vec = opts.vec ?? null;
  const blob = vec ? encodeEmbedding(vec) : null;
  conn
    .prepare(
      `INSERT INTO memories (id, title, content, semantic_field, space_id, created_at, updated_at,
         last_accessed_at, embedding, embedding_model, embedding_dim, embedding_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      id,
      `body ${id}`,
      `${id}\nbody ${id}`,
      spaceId,
      at,
      at,
      at,
      blob,
      vec ? 'kw' : null,
      vec ? vec.length : null,
      vec ? 1 : null
    );
  if (!vec || !blob) return;
  const rowid = (
    conn.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number }
  ).rowid;
  vecInsert(conn, rowid, { blob, model: 'kw', dim: vec.length }, spaceId);
}

const chunkSizeOf = (conn: Database.Database, dim: number): number | null =>
  (
    conn.prepare(`SELECT max(size) AS size FROM ${vecTableName(dim)}_chunks`).get() as {
      size: number | null;
    }
  ).size;

const vecRowCount = (conn: Database.Database, dim: number): number =>
  (conn.prepare(`SELECT count(*) AS n FROM ${vecTableName(dim)}_rowids`).get() as { n: number }).n;

/** 退回到 v9 的向量表布局：默认 chunk_size（1024），partition key 不变 */
function downgradeVecLayout(conn: Database.Database, dim: number): void {
  const table = vecTableName(dim);
  conn.exec(`DROP TABLE IF EXISTS ${table}`);
  conn.exec(
    `CREATE VIRTUAL TABLE ${table}
     USING vec0(embedding float[${dim}] distance_metric=cosine,
                model text partition key, space_id text partition key)`
  );
  const rows = conn
    .prepare(
      `SELECT rowid, embedding, embedding_model, space_id FROM memories
       WHERE embedding IS NOT NULL AND embedding_dim = ? AND is_latest = 1`
    )
    .all(dim) as { rowid: number; embedding: Buffer; embedding_model: string; space_id: string }[];
  const insert = conn.prepare(
    `INSERT INTO ${table}(rowid, embedding, model, space_id) VALUES (?, ?, ?, ?)`
  );
  for (const r of rows) insert.run(BigInt(r.rowid), r.embedding, r.embedding_model, r.space_id);
}

function knnRowids(conn: Database.Database, dim: number, probe: Float32Array, spaceId: string) {
  return (
    conn
      .prepare(
        `SELECT rowid FROM ${vecTableName(dim)}
         WHERE embedding MATCH ? AND k = 5 AND model = 'kw' AND space_id = ?`
      )
      .all(encodeEmbedding(probe), spaceId) as { rowid: number }[]
  ).map((r) => r.rowid);
}

function keywordEmbedder(keys: string[]): Embedder {
  return {
    model: 'kw',
    dim: keys.length,
    embed: async (text) => {
      const v = Float32Array.from(keys.map((k) => (text.toLowerCase().includes(k) ? 1 : 0)));
      return v.some((x) => x > 0) ? v : null;
    },
  };
}

describe('v10 迁移：向量表 chunk 布局', () => {
  it('旧 chunk_size 的表重建为 VEC_CHUNK_SIZE，向量与 KNN 结果不变，且可重入', () => {
    const file = path.join(dir, 'migrate.db');
    let conn = openMemoryDb(file);
    const probe = Float32Array.from([1, 0, 0, 0]);
    put(conn, 'a', { spaceId: 'proj:x', vec: probe });
    put(conn, 'b', { spaceId: 'proj:x', vec: Float32Array.from([0, 1, 0, 0]) });
    put(conn, 'c', { spaceId: 'proj:y', vec: Float32Array.from([0, 0, 1, 0]) });
    const before = knnRowids(conn, 4, probe, 'proj:x');
    downgradeVecLayout(conn, 4);
    expect(chunkSizeOf(conn, 4)).toBe(1024);
    conn.pragma('user_version = 9');
    conn.close();

    conn = openMemoryDb(file);
    expect(conn.pragma('user_version', { simple: true })).toBe(MEMORY_SCHEMA_VERSION);
    expect(chunkSizeOf(conn, 4)).toBe(VEC_CHUNK_SIZE);
    expect(vecRowCount(conn, 4)).toBe(3);
    expect(knnRowids(conn, 4, probe, 'proj:x')).toEqual(before);
    expect(planVecCompaction(conn).needsRebuild).toBe(false);
    conn.close();

    // 可重入：再开一次不会把表搬坏、也不会丢向量
    conn = openMemoryDb(file);
    expect(chunkSizeOf(conn, 4)).toBe(VEC_CHUNK_SIZE);
    expect(vecRowCount(conn, 4)).toBe(3);
    expect(knnRowids(conn, 4, probe, 'proj:x')).toEqual(before);
    conn.close();
  });

  it('老数据 last_hit_at 为 null、hit_count 为 0', () => {
    const file = path.join(dir, 'legacy.db');
    let conn = openMemoryDb(file);
    put(conn, 'legacy', {});
    conn.exec('ALTER TABLE memories DROP COLUMN last_hit_at');
    conn.exec('ALTER TABLE memories DROP COLUMN hit_count');
    conn.pragma('user_version = 9');
    conn.close();

    conn = openMemoryDb(file);
    const row = conn
      .prepare('SELECT last_hit_at AS lastHitAt, hit_count AS hitCount FROM memories')
      .get() as { lastHitAt: string | null; hitCount: number };
    expect(row).toEqual({ lastHitAt: null, hitCount: 0 });
    conn.close();
  });
});

describe('向量表压缩', () => {
  /** 60 个 space × 4 行：旧布局每个 partition 一个 1024 槽 chunk，足够撑出可回收空间 */
  function seedLegacy(file: string, dim = 64): Database.Database {
    const conn = openMemoryDb(file);
    for (let s = 0; s < 60; s++) {
      for (let i = 0; i < 4; i++) {
        const vec = new Float32Array(dim);
        vec[i % dim] = 1;
        put(conn, `m${s}-${i}`, { spaceId: `proj:s${s}`, vec });
      }
    }
    downgradeVecLayout(conn, dim);
    return conn;
  }

  it('dry-run 只报告，不写备份也不改库', () => {
    const file = path.join(dir, 'dry.db');
    const conn = seedLegacy(file);
    const before = statSync(file).size;
    const files = readdirSync(dir).sort();
    const result = runVecCompaction(conn, file, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.plan.needsRebuild).toBe(true);
    expect(result.plan.reclaimableBytes).toBeGreaterThan(0);
    expect(result.plan.actions.join('\n')).toContain(`chunk_size 1024 → ${VEC_CHUNK_SIZE}`);
    expect(statSync(file).size).toBe(before);
    expect(readdirSync(dir).sort()).toEqual(files);
    expect(
      conn.prepare('SELECT count(*) AS n FROM memory_maintenance').get() as { n: number }
    ).toEqual({ n: 0 });
    expect(chunkSizeOf(conn, 64)).toBe(1024);
    conn.close();
  });

  it('备份 → 重建 → VACUUM，向量不丢，第二次运行是空操作', () => {
    const file = path.join(dir, 'compact.db');
    const conn = seedLegacy(file);
    const beforeBytes = statSync(file).size;
    const result = runVecCompaction(conn, file);
    expect(result.error).toBeNull();
    expect(result.phase).toBe('done');
    expect(result.vacuumed).toBe(true);
    expect(result.rebuiltTables).toEqual(['memory_vec_64']);
    expect(result.backupPath).not.toBeNull();
    expect(existsSync(result.backupPath as string)).toBe(true);
    expect(chunkSizeOf(conn, 64)).toBe(VEC_CHUNK_SIZE);
    expect(vecRowCount(conn, 64)).toBe(240);
    expect(result.afterBytes).toBeLessThan(beforeBytes);
    expect(result.reclaimedBytes).toBeGreaterThan(0);

    // 重入：阶段已 done，什么都不再干
    const again = runVecCompaction(conn, file);
    expect(again.resumedFrom).toBe('done');
    expect(again.rebuiltTables).toEqual([]);
    expect(again.vacuumed).toBe(false);
    conn.close();
  });

  it('中断后从断点续跑：停在 vacuum 阶段时只补 VACUUM，不再重建也不再写备份', () => {
    const file = path.join(dir, 'resume.db');
    const conn = seedLegacy(file);
    conn
      .prepare(
        "INSERT INTO memory_maintenance (kind, phase, detail, updated_at) VALUES ('vec_compact', 'vacuum', NULL, ?)"
      )
      .run('2025-01-01T00:00:00.000Z');
    const result = runVecCompaction(conn, file);
    expect(result.resumedFrom).toBe('vacuum');
    expect(result.phase).toBe('done');
    expect(result.rebuiltTables).toEqual([]);
    expect(result.vacuumed).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(chunkSizeOf(conn, 64)).toBe(1024);
    conn.close();
  });

  it('已是当前布局且没有值得回收的空间时直接标 done', () => {
    const file = path.join(dir, 'nothing.db');
    const conn = openMemoryDb(file);
    put(conn, 'tiny', { vec: Float32Array.from([1, 0]) });
    const result = runVecCompaction(conn, file);
    expect(result.phase).toBe('done');
    expect(result.backupPath).toBeNull();
    expect(result.vacuumed).toBe(false);
    conn.close();
  });
});

describe('命中采集', () => {
  async function seed() {
    const embedder = keywordEmbedder(['alpha', 'beta']);
    const a = await createMemory(
      db,
      { content: 'alpha one', spaceId: 'global', force: true },
      { embedder }
    );
    const b = await createMemory(
      db,
      { content: 'alpha two', spaceId: 'global', force: true },
      { embedder }
    );
    const c = await createMemory(
      db,
      { content: 'beta three', spaceId: 'global', force: true },
      { embedder }
    );
    if (a.status !== 'inserted' || b.status !== 'inserted' || c.status !== 'inserted') {
      throw new Error('seed failed');
    }
    return { a: a.memory, b: b.memory, c: c.memory };
  }

  const hitRows = (conn: Database.Database) =>
    conn
      .prepare(
        'SELECT id, hit_count AS hitCount, last_hit_at AS lastHitAt FROM memories ORDER BY id'
      )
      .all() as { id: string; hitCount: number; lastHitAt: string | null }[];

  it('只给最终返回的命中写 lastHitAt / hitCount，被 limit 截掉的候选不算', async () => {
    const { c } = await seed();
    const now = new Date('2025-06-01T00:00:00.000Z');
    const hits = await searchMemories(db, {
      q: 'alpha',
      spaceIds: ['global'],
      limit: 1,
      now,
      mmr: false,
    });
    expect(hits).toHaveLength(1);
    const hitId = hits[0].memory.id;
    for (const row of hitRows(db)) {
      if (row.id === hitId) {
        expect(row.hitCount).toBe(1);
        expect(row.lastHitAt).toBe(now.toISOString());
      } else {
        expect(row.hitCount).toBe(0);
        expect(row.lastHitAt).toBeNull();
      }
    }
    // 未命中 alpha 的记忆一次都没被写
    expect(hitRows(db).find((r) => r.id === c.id)?.hitCount).toBe(0);
  });

  it('累计命中次数，并作为下一轮衰减的输入', async () => {
    await seed();
    const now = new Date('2025-06-01T00:00:00.000Z');
    const opts = { q: 'alpha', spaceIds: ['global'], now, mmr: false };
    const first = await searchMemories(db, opts);
    const second = await searchMemories(db, opts);
    // 命中写在排序之后，所以一次查询不影响它自己的名次；已累计的命中会抬高下一轮的 decay
    expect(second.map((h) => h.memory.id)).toEqual(first.map((h) => h.memory.id));
    for (const [i, hit] of second.entries()) {
      expect(hit.decay).toBeGreaterThan(first[i].decay);
      expect(hit.score).toBeGreaterThan(first[i].score);
    }
    expect(hitRows(db).filter((r) => r.hitCount > 0)).toHaveLength(first.length);
    expect(Math.max(...hitRows(db).map((r) => r.hitCount))).toBe(2);

    // 把命中次数拉满：频率项到 1，decay 顶到上限
    db.exec("UPDATE memories SET hit_count = 999, last_hit_at = '2025-06-01T00:00:00.000Z'");
    const third = await searchMemories(db, opts);
    expect(third[0].decay).toBeGreaterThan(second[0].decay);
    expect(third[0].decay).toBeLessThanOrEqual(1);
  });

  it('按未命中天数筛选：从未命中的按创建时间算，归档与近期命中的不算', () => {
    const old = '2025-01-01T00:00:00.000Z';
    put(db, 'old-never', { createdAt: old });
    put(db, 'recent', { createdAt: '2025-05-30T00:00:00.000Z' });
    put(db, 'hit-recently', { createdAt: old });
    put(db, 'hit-long-ago', { createdAt: old });
    put(db, 'archived', { createdAt: old });
    db.prepare(
      "UPDATE memories SET hit_count = 1, last_hit_at = '2025-05-31T00:00:00.000Z' WHERE id = 'hit-recently'"
    ).run();
    db.prepare(
      "UPDATE memories SET hit_count = 1, last_hit_at = '2025-01-02T00:00:00.000Z' WHERE id = 'hit-long-ago'"
    ).run();
    db.prepare("UPDATE memories SET lifecycle_state = 'archived' WHERE id = 'archived'").run();

    const now = new Date('2025-06-01T00:00:00.000Z');
    const stale = listStaleMemories(db, { olderThanDays: 7, now });
    expect(stale.items.map((m) => m.id)).toEqual(['old-never', 'hit-long-ago']);
    expect(stale.total).toBe(2);
    // 排序：最久没被碰过的在前
    expect(
      listStaleMemories(db, { olderThanDays: 7, now, limit: 1 }).items.map((m) => m.id)
    ).toEqual(['old-never']);
    expect(listStaleMemories(db, { olderThanDays: 7, now, spaceIds: ['proj:none'] }).total).toBe(0);
    expect(() => listStaleMemories(db, { olderThanDays: -1 })).toThrow();
  });

  it('统计从未命中与近 7 天新增', () => {
    put(db, 'old', { createdAt: '2025-01-01T00:00:00.000Z' });
    put(db, 'new-1', { createdAt: '2025-05-30T00:00:00.000Z' });
    put(db, 'new-2', { createdAt: '2025-05-31T00:00:00.000Z' });
    db.prepare("UPDATE memories SET hit_count = 3 WHERE id = 'new-1'").run();
    db.prepare("UPDATE memories SET lifecycle_state = 'deleted' WHERE id = 'new-2'").run();
    expect(getHitStats(db, new Date('2025-06-01T00:00:00.000Z'))).toEqual({
      neverHit: 1,
      addedLast7Days: 1,
    });
  });
});
