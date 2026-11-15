import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listMemoriesForAdmin } from '../memoryAdmin';
import { openMemoryDb } from './db';
import { applyExtraction, listEntityNames } from './kg';
import { applyManualEdit, deleteMemoriesManually, planMemoryDeletion } from './manual';
import { searchMemories } from './search';
import { createMemory, encodeEmbedding, getMemory, listEvolves } from './store';
import type { Embedder, Memory } from './types';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-memory-manual-'));
  db = openMemoryDb(path.join(dir, 'memory.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const KEYS = ['kubernetes', 'nomad', 'postgres', 'redis'];
function keywordEmbedder(): Embedder {
  return {
    model: 'kw',
    dim: KEYS.length,
    embed: async (text) => {
      const v = Float32Array.from(KEYS.map((k) => (text.toLowerCase().includes(k) ? 1 : 0)));
      return v.some((x) => x > 0) ? v : null;
    },
  };
}
const embedder = keywordEmbedder();

async function add(content: string, extra: Record<string, unknown> = {}): Promise<Memory> {
  const r = await createMemory(
    db,
    { content, spaceId: 'global', force: true, ...extra },
    { embedder }
  );
  if (r.status !== 'inserted') throw new Error('not inserted');
  return r.memory;
}

const search = async (q: string, withVectors = true) =>
  (
    await searchMemories(db, {
      q,
      spaceIds: ['global'],
      limit: 20,
      embedder: withVectors ? embedder : null,
    })
  ).map((h) => h.memory.id);
const exact = (q: string) =>
  listMemoriesForAdmin(db, { query: q, limit: 50, offset: 0 }).items.map((i) => i.id);
const vecRows = (dim: number) =>
  (db.prepare(`SELECT count(*) AS n FROM memory_vec_${dim}`).get() as { n: number }).n;
/** 向量通道不按余弦截断（KNN 总会返回最近的），所以直接看索引里这条的余弦距离：1 = 与查询正交 */
async function vecDistance(memory: Memory, q: string): Promise<number | undefined> {
  const query = await embedder.embed(q, 'query');
  if (!query) return undefined;
  const row = db
    .prepare(
      `SELECT v.distance AS distance FROM memory_vec_${KEYS.length} v
       JOIN memories m ON m.rowid = v.rowid
       WHERE v.embedding MATCH ? AND k = 10 AND v.model = 'kw' AND v.space_id = 'global' AND m.id = ?`
    )
    .get(encodeEmbedding(query), memory.id) as { distance: number } | undefined;
  return row?.distance;
}

function mention(memory: Memory, name: string) {
  applyExtraction(db, memory, {
    entities: [{ name, type: 'TECHNOLOGY', description: null, confidence: 1, aliases: [] }],
    relations: [],
  });
}

describe('applyManualEdit', () => {
  it('编辑后新内容能被全文、向量、管理页搜到，旧内容任何通道都搜不到', async () => {
    const memory = await add('we deploy with Kubernetes clusters', { title: 'Deploy stack' });
    mention(memory, 'Kubernetes');
    expect(await search('Kubernetes')).toContain(memory.id);
    expect(await vecDistance(memory, 'Kubernetes')).toBeCloseTo(0);

    const result = await applyManualEdit(
      db,
      memory.id,
      { title: 'Deploy stack', content: 'we deploy with Nomad jobs' },
      embedder
    );
    expect(result?.embedded).toBe(true);
    // 全文 + 实体 + 社区通道都不再命中旧词；向量索引里这条已与旧词正交
    expect(await search('Kubernetes', false)).not.toContain(memory.id);
    expect(await vecDistance(memory, 'Kubernetes')).toBeCloseTo(1);
    expect(exact('Kubernetes')).not.toContain(memory.id);
    expect(await search('Nomad')).toContain(memory.id);
    expect(await search('Nomad', false)).toContain(memory.id);
    expect(await vecDistance(memory, 'Nomad')).toBeCloseTo(0);
    expect(exact('Nomad')).toContain(memory.id);
    // 向量已按新正文重建，不必等后台重嵌
    expect(getMemory(db, memory.id)?.embeddingModel).toBe('kw');
    expect(vecRows(KEYS.length)).toBe(1);
    // 旧实体提及与孤儿实体一并清掉
    expect(listEntityNames(db, memory.id)).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM entities').get()).toEqual({ n: 0 });
  });

  it('只改标题也清掉旧实体提及，旧标题搜不到', async () => {
    const memory = await add('primary database notes', { title: 'Postgres primary' });
    mention(memory, 'Postgres');
    await applyManualEdit(db, memory.id, { title: 'Main database', content: '' }, embedder);
    expect(await search('Postgres', false)).not.toContain(memory.id);
    expect(await vecDistance(memory, 'Postgres')).toBeUndefined();
    expect(exact('Postgres')).not.toContain(memory.id);
    expect(exact('Main database')).toContain(memory.id);
  });

  it('只改标题时正文里仍提到的实体保留（KG 关闭时不会重抽）', async () => {
    const memory = await add('cache with Redis cluster', { title: 'Cache' });
    mention(memory, 'Redis');
    await applyManualEdit(db, memory.id, { title: 'Cache layer', content: '' }, embedder);
    expect(listEntityNames(db, memory.id)).toEqual(['Redis']);
  });

  it('只改类型和重要度不动向量与实体', async () => {
    const memory = await add('cache with Redis', { title: 'Cache' });
    mention(memory, 'Redis');
    const result = await applyManualEdit(
      db,
      memory.id,
      { unitType: 'decision', importance: 0.9 },
      embedder
    );
    expect(result?.semanticChanged).toBe(false);
    expect(result?.memory.unitType).toBe('decision');
    expect(result?.memory.importance).toBe(0.9);
    expect(listEntityNames(db, memory.id)).toEqual(['Redis']);
    expect(getMemory(db, memory.id)?.embeddingModel).toBe('kw');
  });

  it('不存在的记忆返回 null', async () => {
    expect(await applyManualEdit(db, 'missing', { content: 'x' }, embedder)).toBeNull();
  });
});

describe('deleteMemoriesManually', () => {
  it('删除后全文、向量、实体通道都搜不到', async () => {
    const memory = await add('we deploy with Kubernetes clusters');
    mention(memory, 'Kubernetes');
    const plan = deleteMemoriesManually(db, [memory.id]);
    expect(plan?.deleted.map((d) => d.id)).toEqual([memory.id]);
    expect(await search('Kubernetes')).toEqual([]);
    expect(exact('Kubernetes')).toEqual([]);
    expect(vecRows(KEYS.length)).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM entities').get()).toEqual({ n: 0 });
  });

  it('删最新版本时连同被它替换的历史版本一起删，不留不可见的旧行', async () => {
    const v1 = await add('redis v1 notes');
    const v2 = await add('redis v2 notes', { evolvesFromId: v1.id, evolvesRelation: 'replaces' });
    const v3 = await add('redis v3 notes', { evolvesFromId: v2.id, evolvesRelation: 'replaces' });
    const plan = planMemoryDeletion(db, [v3.id]);
    expect(plan?.deleted.map((d) => [d.id, d.role])).toEqual([
      [v3.id, 'target'],
      [v2.id, 'history'],
      [v1.id, 'history'],
    ]);
    deleteMemoriesManually(db, [v3.id]);
    for (const m of [v1, v2, v3]) expect(getMemory(db, m.id)).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM evolves').get()).toEqual({ n: 0 });
  });

  it('删中间版本时把前后版本重新接上', async () => {
    const v1 = await add('redis v1 notes');
    const v2 = await add('redis v2 notes', { evolvesFromId: v1.id, evolvesRelation: 'replaces' });
    const v3 = await add('redis v3 notes', { evolvesFromId: v2.id, evolvesRelation: 'replaces' });
    const plan = deleteMemoriesManually(db, [v2.id]);
    expect(plan?.deleted.map((d) => d.id)).toEqual([v2.id]);
    expect(plan?.bridges).toEqual([{ olderId: v1.id, newerId: v3.id }]);
    const edges = listEvolves(db, v1.id);
    expect(edges.map((e) => [e.olderId, e.newerId, e.relation])).toEqual([
      [v1.id, v3.id, 'replaces'],
    ]);
    expect(getMemory(db, v3.id)?.isLatest).toBe(true);
  });

  it('非替换关系只解除边，另一端记忆保留', async () => {
    const base = await add('postgres base fact');
    const extra = await add('postgres extra detail', {
      evolvesFromId: base.id,
      evolvesRelation: 'enriches',
    });
    const plan = deleteMemoriesManually(db, [base.id]);
    expect(plan?.deleted.map((d) => d.id)).toEqual([base.id]);
    expect(plan?.relations).toEqual([
      { memoryId: extra.id, title: extra.title, relation: 'enriches' },
    ]);
    expect(getMemory(db, extra.id)).not.toBeNull();
    expect(listEvolves(db, extra.id)).toEqual([]);
  });

  it('crystal 的来源被删：来源仍够则更新计数与权重，不够则降为普通记忆', async () => {
    const sources = await Promise.all(['a', 'b', 'c', 'd'].map((x) => add(`source ${x} note`)));
    const crystal = await add('crystal synthesis');
    db.prepare(
      "UPDATE memories SET is_crystal = 1, crystal_title = 'C', source_unit_count = 4 WHERE id = ?"
    ).run(crystal.id);
    const edge = db.prepare(
      'INSERT INTO crystallized_from (crystal_id, source_id, contribution_weight, created_at) VALUES (?, ?, 0.25, ?)'
    );
    for (const s of sources) edge.run(crystal.id, s.id, new Date().toISOString());

    const first = deleteMemoriesManually(db, [sources[0].id]);
    expect(first?.crystalsUpdated).toEqual([
      { id: crystal.id, title: crystal.title, remaining: 3 },
    ]);
    const weights = db
      .prepare('SELECT contribution_weight AS w FROM crystallized_from WHERE crystal_id = ?')
      .all(crystal.id) as { w: number }[];
    expect(weights.map((r) => r.w)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(getMemory(db, crystal.id)?.sourceUnitCount).toBe(3);

    const second = planMemoryDeletion(db, [sources[1].id]);
    expect(second?.crystalsDemoted).toEqual([
      { id: crystal.id, title: crystal.title, remaining: 2 },
    ]);
    deleteMemoriesManually(db, [sources[1].id]);
    const demoted = getMemory(db, crystal.id);
    expect(demoted?.isCrystal).toBe(false);
    expect(demoted?.sourceUnitCount).toBe(0);
    expect(
      db.prepare('SELECT count(*) AS n FROM crystallized_from WHERE crystal_id = ?').get(crystal.id)
    ).toEqual({ n: 0 });
  });

  it('删 crystal 本身只解除来源关系，来源记忆保留', async () => {
    const sources = await Promise.all(['a', 'b', 'c'].map((x) => add(`source ${x} note`)));
    const crystal = await add('crystal synthesis');
    db.prepare('UPDATE memories SET is_crystal = 1, source_unit_count = 3 WHERE id = ?').run(
      crystal.id
    );
    const edge = db.prepare(
      'INSERT INTO crystallized_from (crystal_id, source_id, contribution_weight, created_at) VALUES (?, ?, 0.33, ?)'
    );
    for (const s of sources) edge.run(crystal.id, s.id, new Date().toISOString());
    const plan = deleteMemoriesManually(db, [crystal.id]);
    expect(plan?.releasedSources).toBe(3);
    for (const s of sources) expect(getMemory(db, s.id)).not.toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM crystallized_from').get()).toEqual({ n: 0 });
  });

  it('目标都不存在返回 null', () => {
    expect(planMemoryDeletion(db, ['ghost'])).toBeNull();
    expect(deleteMemoriesManually(db, ['ghost'])).toBeNull();
  });
});
