import { randomUUID } from 'node:crypto';
import { CRYSTAL_MIN_SOURCES, type UnitType } from '@shared/memory/constants';
import type { MemoryDeletionImpact } from '@shared/memory/dto';
import { normalizeEntityName } from '@shared/memory/entityNormalize';
import type Database from 'better-sqlite3';
import { deleteMemoryPermanently, deleteOrphanEntities } from '../memoryAdmin';
import { getMemory, tryEmbed, updateMemory, vecDelete, vecInsert } from './store';
import type { Embedder, Memory } from './types';

/**
 * 用户在设置页手动维护记忆。编辑是原地修改（id 不变）：crystal 来源边、evolves 边、mentions 都按 id 挂着，
 * 新开版本会让这些引用指向旧行，且旧正文仍留在库里能被精确搜索翻出来。
 */

export interface ManualEditPatch {
  title?: string;
  content?: string;
  unitType?: UnitType;
  importance?: number;
}

export interface ManualEditResult {
  before: Memory;
  memory: Memory;
  /** 标题或正文变了（三类索引都要重建） */
  semanticChanged: boolean;
  /** 向量已在本次同步重建；false 时由后台重嵌补齐（旧向量已删，不会被搜到） */
  embedded: boolean;
}

export async function applyManualEdit(
  db: Database.Database,
  id: string,
  patch: ManualEditPatch,
  embedder: Embedder | null
): Promise<ManualEditResult | null> {
  const before = getMemory(db, id);
  if (!before || before.lifecycleState === 'deleted') return null;
  const updated = updateMemory(db, id, patch);
  if (!updated) return null;
  const semanticChanged = updated.title !== before.title || updated.content !== before.content;
  if (!semanticChanged) return { before, memory: updated, semanticChanged, embedded: false };
  // 正文变了 updateMemory 已清掉全部提及。只改标题时提及保留（KG 关闭时不会重抽，全删会丢掉正文里的实体），
  // 但只出现在旧标题、新标题与正文都不再提到的实体要立刻解除，否则旧标题仍能经实体通道搜到
  db.transaction(() => {
    if (updated.content === before.content) pruneTitleMentions(db, before, updated);
    deleteOrphanEntities(db);
  }).immediate();
  const embedded = await reembedOne(db, updated, embedder);
  return { before, memory: getMemory(db, id) ?? updated, semanticChanged, embedded };
}

function pruneTitleMentions(db: Database.Database, before: Memory, after: Memory): void {
  const oldTitle = normalizeEntityName(before.title);
  const now = normalizeEntityName(`${after.title}\n${after.content}`);
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.normalized_name AS name, a.normalized_alias AS alias
       FROM mentions mn JOIN entities e ON e.id = mn.entity_id
       LEFT JOIN entity_aliases a ON a.entity_id = e.id
       WHERE mn.memory_id = ?`
    )
    .all(after.id) as { id: string; name: string; alias: string | null }[];
  const keys = new Map<string, string[]>();
  for (const row of rows) {
    const list = keys.get(row.id) ?? [row.name];
    if (row.alias) list.push(row.alias);
    keys.set(row.id, list);
  }
  const drop = db.prepare('DELETE FROM mentions WHERE memory_id = ? AND entity_id = ?');
  for (const [entityId, names] of keys) {
    const literal = names.filter((n) => n.length > 0);
    if (literal.some((n) => now.includes(n))) continue;
    if (literal.some((n) => oldTitle.includes(n))) drop.run(after.id, entityId);
  }
}

/** 与后台重嵌同一写回条件：只给最新 active 行建向量，算完重读确认正文没被并发改掉 */
async function reembedOne(
  db: Database.Database,
  memory: Memory,
  embedder: Embedder | null
): Promise<boolean> {
  if (!memory.isLatest || memory.lifecycleState !== 'active') return false;
  const field = semanticFieldOf(db, memory.id);
  if (field === null) return false;
  const emb = await tryEmbed(embedder, field);
  if (!emb) return false;
  return db
    .transaction(() => {
      const row = db
        .prepare(
          `SELECT rowid, semantic_field AS field, embedding_dim AS dim FROM memories
           WHERE id = ? AND is_latest = 1 AND lifecycle_state = 'active'`
        )
        .get(memory.id) as { rowid: number; field: string; dim: number | null } | undefined;
      if (row?.field !== field) return false;
      vecDelete(db, row.rowid, row.dim);
      db.prepare(
        `UPDATE memories SET embedding = ?, embedding_model = ?, embedding_dim = ?, embedding_version = 1
         WHERE rowid = ?`
      ).run(emb.blob, emb.model, emb.dim, row.rowid);
      vecInsert(db, row.rowid, emb, memory.spaceId);
      return true;
    })
    .immediate();
}

function semanticFieldOf(db: Database.Database, id: string): string | null {
  const row = db.prepare('SELECT semantic_field AS field FROM memories WHERE id = ?').get(id) as
    | { field: string }
    | undefined;
  return row?.field ?? null;
}

// ---------------------------------------------------------------------------
// 删除：先算影响再执行，同一份计划给确认框展示、给审计落盘
// ---------------------------------------------------------------------------

interface EdgeRow {
  olderId: string;
  newerId: string;
  relation: string;
}

function titleOf(db: Database.Database, id: string): string {
  return (
    (db.prepare('SELECT title FROM memories WHERE id = ?').get(id) as { title: string } | undefined)
      ?.title ?? ''
  );
}

/**
 * 规则：
 * - 被删行若不再通向任何保留的新版本，被它（递归）替换掉、且没有其他存活后继的历史版本一起删——
 *   历史版本 is_latest=0，单独留着永远不可见也无法再被找回；
 * - 删中间版本时，前驱与最近的保留后继重新以 replaces 接上，历史链不断；
 * - enriches/confirms/challenges 只解除边，另一端保留；
 * - 引用被删来源的 crystal：剩余来源仍 ≥ CRYSTAL_MIN_SOURCES 则更新计数与权重，否则降为普通记忆（正文保留）；
 * - 被删的是 crystal：只解除来源边，来源记忆保留。
 */
export function planMemoryDeletion(
  db: Database.Database,
  ids: readonly string[]
): MemoryDeletionImpact | null {
  const exists = db.prepare('SELECT is_latest AS latest FROM memories WHERE id = ?');
  const targets = [...new Set(ids)].filter((id) => exists.get(id));
  if (targets.length === 0) return null;
  const replaces = db
    .prepare(
      "SELECT older_id AS olderId, newer_id AS newerId, content_relation AS relation FROM evolves WHERE content_relation = 'replaces'"
    )
    .all() as EdgeRow[];
  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  for (const edge of replaces) {
    successors.set(edge.olderId, [...(successors.get(edge.olderId) ?? []), edge.newerId]);
    predecessors.set(edge.newerId, [...(predecessors.get(edge.newerId) ?? []), edge.olderId]);
  }
  const doomed = new Set(targets);
  const history: string[] = [];
  const leadsToSurvivor = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    return (successors.get(id) ?? []).some((s) => !doomed.has(s) || leadsToSurvivor(s, seen));
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of [...doomed]) {
      for (const older of predecessors.get(id) ?? []) {
        if (doomed.has(older)) continue;
        const row = exists.get(older) as { latest: number } | undefined;
        if (!row || row.latest === 1) continue;
        const next = successors.get(older) ?? [];
        if (!next.every((s) => doomed.has(s) && !leadsToSurvivor(s))) continue;
        doomed.add(older);
        history.push(older);
        changed = true;
      }
    }
  }

  const nearestSurvivors = (id: string, seen = new Set<string>()): string[] => {
    if (seen.has(id)) return [];
    seen.add(id);
    return (successors.get(id) ?? []).flatMap((s) =>
      doomed.has(s) ? nearestSurvivors(s, seen) : [s]
    );
  };
  const bridges: MemoryDeletionImpact['bridges'] = [];
  const bridgeKeys = new Set(replaces.map((e) => `${e.olderId}>${e.newerId}`));
  for (const edge of replaces) {
    if (doomed.has(edge.olderId) || !doomed.has(edge.newerId)) continue;
    for (const newerId of nearestSurvivors(edge.newerId)) {
      const key = `${edge.olderId}>${newerId}`;
      if (bridgeKeys.has(key) || edge.olderId === newerId) continue;
      bridgeKeys.add(key);
      bridges.push({ olderId: edge.olderId, newerId });
    }
  }

  const list = [...doomed];
  const marks = list.map(() => '?').join(',');
  const relationRows = db
    .prepare(
      `SELECT older_id AS olderId, newer_id AS newerId, content_relation AS relation FROM evolves
       WHERE content_relation != 'replaces' AND (older_id IN (${marks}) OR newer_id IN (${marks}))
       ORDER BY created_at, id`
    )
    .all(...list, ...list) as EdgeRow[];
  const relations: MemoryDeletionImpact['relations'] = [];
  for (const edge of relationRows) {
    const other = doomed.has(edge.olderId) ? edge.newerId : edge.olderId;
    if (doomed.has(other)) continue;
    relations.push({ memoryId: other, title: titleOf(db, other), relation: edge.relation });
  }

  const crystalRows = db
    .prepare(
      `SELECT crystal_id AS crystalId,
              sum(CASE WHEN source_id IN (${marks}) THEN 0 ELSE 1 END) AS remaining
       FROM crystallized_from
       WHERE crystal_id IN (SELECT crystal_id FROM crystallized_from WHERE source_id IN (${marks}))
       GROUP BY crystal_id ORDER BY crystal_id`
    )
    .all(...list, ...list) as { crystalId: string; remaining: number }[];
  const crystalsUpdated: MemoryDeletionImpact['crystalsUpdated'] = [];
  const crystalsDemoted: MemoryDeletionImpact['crystalsDemoted'] = [];
  for (const row of crystalRows) {
    if (doomed.has(row.crystalId)) continue;
    const entry = {
      id: row.crystalId,
      title: titleOf(db, row.crystalId),
      remaining: row.remaining,
    };
    (row.remaining >= CRYSTAL_MIN_SOURCES ? crystalsUpdated : crystalsDemoted).push(entry);
  }
  const releasedSources = (
    db
      .prepare(
        `SELECT count(*) AS n FROM crystallized_from
         WHERE crystal_id IN (${marks}) AND source_id NOT IN (${marks})`
      )
      .get(...list, ...list) as { n: number }
  ).n;

  const describe = (id: string, role: 'target' | 'history') => {
    const row = db
      .prepare('SELECT title, space_id AS spaceId FROM memories WHERE id = ?')
      .get(id) as {
      title: string;
      spaceId: string;
    };
    return { id, title: row.title, spaceId: row.spaceId, role };
  };
  return {
    deleted: [
      ...targets.map((id) => describe(id, 'target')),
      ...history.map((id) => describe(id, 'history')),
    ],
    bridges,
    relations,
    crystalsUpdated,
    crystalsDemoted,
    releasedSources,
  };
}

/** 计划与执行在同一个 IMMEDIATE 事务里，确认框之后库变了也按当时的真实状态处理 */
export function deleteMemoriesManually(
  db: Database.Database,
  ids: readonly string[]
): MemoryDeletionImpact | null {
  return db
    .transaction((): MemoryDeletionImpact | null => {
      const plan = planMemoryDeletion(db, ids);
      if (!plan) return null;
      const now = new Date().toISOString();
      const bridge = db.prepare(
        `INSERT INTO evolves (id, older_id, newer_id, content_relation, confidence, reason, review_state, reviewed_at, created_at)
         VALUES (?, ?, ?, 'replaces', 1, 'relinked after a version was deleted manually', 'accepted', ?, ?)`
      );
      for (const b of plan.bridges) bridge.run(randomUUID(), b.olderId, b.newerId, now, now);
      const doomed = plan.deleted.map((d) => d.id);
      const marks = doomed.map(() => '?').join(',');
      for (const c of plan.crystalsUpdated) {
        db.prepare(
          `UPDATE crystallized_from SET contribution_weight = ? WHERE crystal_id = ? AND source_id NOT IN (${marks})`
        ).run(1 / c.remaining, c.id, ...doomed);
        db.prepare('UPDATE memories SET source_unit_count = ?, updated_at = ? WHERE id = ?').run(
          c.remaining,
          now,
          c.id
        );
      }
      for (const c of plan.crystalsDemoted) {
        db.prepare('DELETE FROM crystallized_from WHERE crystal_id = ?').run(c.id);
        db.prepare(
          'UPDATE memories SET is_crystal = 0, crystal_title = NULL, source_unit_count = 0, updated_at = ? WHERE id = ?'
        ).run(now, c.id);
      }
      for (const id of doomed) deleteMemoryPermanently(db, id);
      return plan;
    })
    .immediate();
}
