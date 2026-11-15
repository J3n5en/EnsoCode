import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SearchLlmGate } from '@shared/memory/searchAssist';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from './memory/db';
import { ensureDistillJob, listResumableDistillJobs } from './memory/distill';
import { applyExtraction } from './memory/kg';
import { createSearchAssist } from './memory/searchLlm';
import { createMemory, getMemory } from './memory/store';
import { type Embedder, projectSpaceId } from './memory/types';
import {
  archiveMemory,
  clearFinishedMemoryJobs,
  deleteMemoryPermanently,
  deleteMemorySpace,
  listMemoriesForAdmin,
  listPendingEvolves,
  openExistingMemoryDb,
  restoreMemory,
  reviewEvolvesEdge,
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

it('deletes all versions and archived memories in a bot space, preserving other spaces', async () => {
  const space = 'bot:11111111-1111-4111-8111-111111111111';
  const first = await add('one', space);
  const second = await add('two', space);
  const other = await add('keep');
  archiveMemory(db, second.id);
  ensureDistillJob(
    db,
    { sessionId: 'old', sessionFile: 'old.jsonl', projectId: null, botId: space.slice(4) },
    'old#hash'
  );
  expect(deleteMemorySpace(db, space)).toBe(2);
  expect(getMemory(db, first.id)).toBeNull();
  expect(getMemory(db, second.id)).toBeNull();
  expect(getMemory(db, other.id)).not.toBeNull();
  expect(listResumableDistillJobs(db)).toEqual([]);
});

it('deleting a chat space keeps pending member jobs but stops them routing into the chat', async () => {
  const chatId = '33333333-3333-4333-8333-333333333333';
  const kept = await add('member note', 'bot:11111111-1111-4111-8111-111111111111');
  await add('group note', `chat:${chatId}`);
  ensureDistillJob(
    db,
    {
      sessionId: 'g',
      sessionFile: 'g.jsonl',
      projectId: null,
      botId: '11111111-1111-4111-8111-111111111111',
      chatId,
    },
    'g#hash'
  );
  expect(deleteMemorySpace(db, `chat:${chatId}`)).toBe(1);
  expect(getMemory(db, kept.id)).not.toBeNull();
  const [job] = listResumableDistillJobs(db);
  expect(job.payload.botId).toBe('11111111-1111-4111-8111-111111111111');
  expect(job.payload).not.toHaveProperty('chatId');
});

it('deletes only the requested project space', async () => {
  const keep = await add('keep', projectSpaceId('p1'));
  await add('secretary note', projectSpaceId('secretary'));
  expect(deleteMemorySpace(db, projectSpaceId('secretary'))).toBe(1);
  expect(getMemory(db, keep.id)).not.toBeNull();
});

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

  it('列表项带被检索次数（appearances），不用从不写入的 access_count（#169）', async () => {
    const m = await add('Redis 缓存策略');
    db.prepare('UPDATE memories SET appearances = 7 WHERE id = ?').run(m.id);
    const [item] = listMemoriesForAdmin(db, { limit: 10, offset: 0 }).items;
    expect(item).toMatchObject({ id: m.id, appearances: 7 });
    expect(item).not.toHaveProperty('accessCount');
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

  it('fast 为 assist off；deep 成功为 llm，调用失败为 fallback', async () => {
    await add('我们决定用 Postgres 做主库');
    let fastCalls = 0;
    const fast = await searchMemoriesForAdmin(
      db,
      { query: 'Postgres', limit: 10, offset: 0, mode: 'fast' },
      null,
      createSearchAssist(async () => {
        fastCalls += 1;
        throw new Error('fast must not call the model');
      })
    );
    expect(fastCalls).toBe(0);
    expect(fast.assist).toBe('off');
    expect(fast.assistReason).toBeUndefined();

    const llm = await searchMemoriesForAdmin(
      db,
      { query: 'Postgres', limit: 10, offset: 0, mode: 'deep' },
      null,
      createSearchAssist(async () => '{"intent":"factual_query","confidence":1}')
    );
    expect(llm.assist).toBe('llm');
    expect(llm.assistReason).toBeUndefined();

    const failed = await searchMemoriesForAdmin(
      db,
      { query: 'Postgres', limit: 10, offset: 0, mode: 'deep' },
      null,
      createSearchAssist(
        async () => {
          throw new Error('down');
        },
        { gate: new SearchLlmGate() }
      )
    );
    expect(failed).toMatchObject({ assist: 'fallback', assistReason: 'error' });
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

  it('staleDays 只列超过 N 天没被检索命中的记忆（从未命中的按创建时间算）', async () => {
    const stale = await add('stale one');
    const fresh = await add('fresh one');
    const hit = await add('hit one');
    db.prepare("UPDATE memories SET created_at = '2025-01-01T00:00:00.000Z'").run();
    db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      fresh.id
    );
    db.prepare('UPDATE memories SET hit_count = 1, last_hit_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      hit.id
    );
    const result = listMemoriesForAdmin(db, { staleDays: 7, limit: 50, offset: 0 });
    expect(result.items.map((item) => item.id)).toEqual([stale.id]);
    expect(result.total).toBe(1);
    // 不带筛选时三条都在
    expect(listMemoriesForAdmin(db, { limit: 50, offset: 0 }).total).toBe(3);
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

it('lists only the given spaces when spaceIds is set; an empty list matches nothing', async () => {
  const a = await add('alpha note', projectSpaceId('11111111-1111-4111-8111-111111111111'));
  await add('beta note', 'global');
  const ids = (spaceIds: string[]) =>
    listMemoriesForAdmin(db, { spaceIds, limit: 10, offset: 0 }).items.map((i) => i.id);
  expect(ids([a.spaceId])).toEqual([a.id]);
  expect(ids([])).toEqual([]);
});

describe('memory admin — 待审阅的矛盾', () => {
  const space = projectSpaceId('22222222-2222-4222-8222-222222222222');

  async function pair(reason: string | null = '两条结论相反') {
    const older = await add('脚本 workflow 已删除，不要再加回来', space);
    const created = await createMemory(db, {
      content: '需要一个 DeepSeek 式脚本 workflow',
      spaceId: space,
      evolvesFromId: older.id,
      evolvesRelation: 'challenges',
      evolvesReason: reason,
    });
    if (created.status !== 'inserted') throw new Error('memory was not inserted');
    return { older, newer: created.memory };
  }

  it('两端记忆的标题、摘要与理由一起返回，只给 id 用户没法判断', async () => {
    const { older } = await pair();
    const [item] = listPendingEvolves(db);
    expect(item.edge.olderId).toBe(older.id);
    expect(item.edge.reviewState).toBe('pending');
    expect(item.edge.reason).toBe('两条结论相反');
    expect(item.older.title).toBe('脚本 workflow 已删除，不要再加回来');
    expect(item.older.contentSummary).toContain('脚本 workflow 已删除');
    expect(item.newer.title).toBe('需要一个 DeepSeek 式脚本 workflow');
    expect(item.newer.contentSummary).toContain('DeepSeek');
    // 空间由 ipc 层填真实名字，这里只保证是同一个空间
    expect(item.older.spaceId).toBe(space);
    expect(item.newer.spaceId).toBe(space);
  });

  it('审阅后不再出现在待审阅里，两条记忆都还在', async () => {
    const { older, newer } = await pair();
    const [item] = listPendingEvolves(db);
    reviewEvolvesEdge(db, item.edge.id, 'accepted');
    expect(listPendingEvolves(db)).toEqual([]);
    expect(getMemory(db, older.id)?.isLatest).toBe(true);
    expect(getMemory(db, newer.id)?.isLatest).toBe(true);
  });

  it('任一端已删除的边不出现，避免点开是空的', async () => {
    const { older } = await pair();
    deleteMemoryPermanently(db, older.id);
    expect(listPendingEvolves(db)).toEqual([]);
  });
});
