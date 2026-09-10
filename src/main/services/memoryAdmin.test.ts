import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from './memory/db';
import { applyExtraction } from './memory/kg';
import { createMemory, getMemory } from './memory/store';
import type { Embedder } from './memory/types';
import {
  archiveMemory,
  clearFinishedMemoryJobs,
  deleteMemoryPermanently,
  listMemoriesForAdmin,
  openExistingMemoryDb,
  restoreMemory,
  searchMemoriesForAdmin,
} from './memoryAdmin';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-memory-admin-'));
  db = openMemoryDb(path.join(dir, 'memory.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function add(content: string, spaceId = 'global') {
  const result = await createMemory(db, { content, spaceId, force: true });
  if (result.status !== 'inserted') throw new Error('memory was not inserted');
  return result.memory;
}

describe('memory admin — 语义搜索模式', () => {
  const embedder: Embedder = {
    model: 'kw',
    dim: 1,
    embed: async () => Float32Array.from([1]),
  };

  it('embedder 为 null 时降级而不报错，并如实报告 vectorsUsed=false', async () => {
    await add('我们决定用 Postgres 做主库');
    const result = await searchMemoriesForAdmin(
      db,
      { query: 'Postgres', limit: 10, offset: 0, mode: 'fast' },
      null
    );
    expect(result.vectorsUsed).toBe(false);
    expect(result.approximate).toBe(true);
    expect(result.items).toHaveLength(1);
  });

  it('实体通道生效：正文没有该词但 MENTIONS 同实体的记忆也能搜到', async () => {
    const literal = await add('Kubernetes 上线流程已跑通');
    const paraphrase = await add('集群编排方案确定，后续按此推进');
    for (const memory of [literal, paraphrase]) {
      applyExtraction(db, memory, {
        entities: [
          { name: 'Kubernetes', type: 'PRODUCT', description: null, confidence: 0.9, aliases: [] },
        ],
        relations: [],
      });
    }
    const semantic = await searchMemoriesForAdmin(
      db,
      { query: 'Kubernetes', limit: 10, offset: 0, mode: 'fast' },
      embedder
    );
    expect(semantic.items.map((i) => i.id).sort()).toEqual([literal.id, paraphrase.id].sort());
    // 精确模式只能命中字面那条——两条路径的差异就在这里
    const exact = listMemoriesForAdmin(db, { query: 'Kubernetes', limit: 10, offset: 0 });
    expect(exact.items.map((i) => i.id)).toEqual([literal.id]);
  });

  it('空查询不跑检索；unitType 在结果上后过滤', async () => {
    await add('Postgres 主库决策');
    expect(
      (await searchMemoriesForAdmin(db, { query: '  ', limit: 10, offset: 0 }, embedder)).items
    ).toEqual([]);
    const filtered = await searchMemoriesForAdmin(
      db,
      { query: 'Postgres', limit: 10, offset: 0, unitType: 'procedure' },
      embedder
    );
    expect(filtered.items).toEqual([]);
  });
});

describe('memory admin', () => {
  it('returns correct total independently of pagination and escapes FTS syntax', async () => {
    await add('alpha (special) one');
    await add('alpha "special" two');
    await add('unrelated');

    const result = listMemoriesForAdmin(db, {
      query: 'alpha ("special")',
      limit: 1,
      offset: 0,
    });
    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].contentSummary.length).toBeLessThanOrEqual(241);
  });

  it('archives and restores without deleting the row', async () => {
    const memory = await add('keep this row');
    expect(archiveMemory(db, memory.id)?.lifecycleState).toBe('archived');
    expect(getMemory(db, memory.id)).not.toBeNull();
    expect(restoreMemory(db, memory.id)?.lifecycleState).toBe('active');
  });

  it('permanent delete removes mentions, vector rows, and crystal edges in one operation', async () => {
    const source = await add('source memory');
    const crystal = await add('crystal memory');
    applyExtraction(db, source, {
      entities: [
        { name: 'SQLite', type: 'TECHNOLOGY', description: null, confidence: 1, aliases: [] },
      ],
      relations: [],
    });
    db.prepare('UPDATE memories SET is_crystal = 1 WHERE id = ?').run(crystal.id);
    db.prepare(
      `INSERT INTO crystallized_from (crystal_id, source_id, contribution_weight, created_at)
       VALUES (?, ?, 1, ?)`
    ).run(crystal.id, source.id, new Date().toISOString());

    expect(deleteMemoryPermanently(db, source.id)).toBe(true);
    expect(getMemory(db, source.id)).toBeNull();
    expect(db.prepare('SELECT 1 FROM mentions WHERE memory_id = ?').get(source.id)).toBeUndefined();
    expect(
      db.prepare('SELECT 1 FROM crystallized_from WHERE source_id = ?').get(source.id)
    ).toBeUndefined();
  });

  it('does not create a database when the file does not exist', () => {
    const missing = path.join(dir, 'missing', 'memory.db');
    expect(openExistingMemoryDb(missing)).toBeNull();
    expect(() => openMemoryDb(missing).close()).not.toThrow();
  });
});

function insertJob(
  kind: string,
  target: string,
  status: string,
  error: string | null = null
): number {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO memory_jobs (kind, target, status, cursor, total, done, failed, error, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?, ?)`
    )
    .run(kind, target, status, error, now, now);
  return Number(info.lastInsertRowid);
}

function jobIds(): number[] {
  return (db.prepare('SELECT id FROM memory_jobs ORDER BY id').all() as { id: number }[]).map(
    (row) => row.id
  );
}

describe('memory admin — 清空历史任务', () => {
  it('deletes done/cancelled (including failed-as-done) and keeps pending/running', () => {
    const pending = insertJob('distill', 'pending-fp', 'pending');
    const running = insertJob('kg', 'mem#kg', 'running');
    insertJob('distill', 'done-fp', 'done');
    insertJob('kg', 'mem#failed', 'done', 'provider down');
    insertJob('reembed', 'local:qwen3', 'cancelled');

    expect(clearFinishedMemoryJobs(db)).toBe(3);
    expect(jobIds()).toEqual([pending, running]);
    expect(
      db.prepare('SELECT status FROM memory_jobs ORDER BY id').all() as { status: string }[]
    ).toEqual([{ status: 'pending' }, { status: 'running' }]);
  });

  it('returns 0 when there is nothing finished to delete', () => {
    const pending = insertJob('distill', 'pending-fp', 'pending');
    expect(clearFinishedMemoryJobs(db)).toBe(0);
    expect(jobIds()).toEqual([pending]);
    expect(clearFinishedMemoryJobs(db)).toBe(0);
  });
});
