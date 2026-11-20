import { existsSync, statSync } from 'node:fs';
import type {
  CrystalSourceDto,
  DistillJobDto,
  EvolvesEdgeDto,
  KgJobDto,
  MemoryDetail,
  MemoryJobsSnapshot,
  MemoryListItem,
  MemoryListQuery,
  MemoryListResult,
  MemoryStats,
  PendingEvolvesReviewDto,
  ReembedJobDto,
} from '@shared/memory/dto';
import { searchAssistReport } from '@shared/memory/searchAssist';
import type Database from 'better-sqlite3';
import { listCrystalSources } from './memory/crystal';
import { openMemoryDb, vecTableExists } from './memory/db';
import { type DistillJob, listDistillJobs } from './memory/distill';
import { buildFtsMatchQuery } from './memory/fts';
import { countFailedKgJobs, type KgJob, listEntityNames, listKgJobs } from './memory/kg';
import { getHitStats, staleCutoffIso } from './memory/maintenance';
import { getReembedJob, type ReembedJob } from './memory/reembed';
import { searchMemories } from './memory/search';
import {
  getMemory,
  listEvolves,
  listPendingEvolvesEdges,
  MEMORY_COLUMNS,
  type MemoryRow,
  reviewEvolves,
  rowToMemory,
  updateMemory,
  vecDelete,
} from './memory/store';
import type { Embedder, Evolves, Memory, SearchAssist } from './memory/types';

const SUMMARY_CHARS = 240;

function summarize(content: string): string {
  const chars = Array.from(content.replace(/\s+/g, ' ').trim());
  return chars.length <= SUMMARY_CHARS
    ? chars.join('')
    : `${chars.slice(0, SUMMARY_CHARS).join('')}…`;
}

export function toMemoryListItem(memory: Memory): MemoryListItem {
  return {
    id: memory.id,
    title: memory.title,
    contentSummary: summarize(memory.content),
    unitType: memory.unitType,
    spaceId: memory.spaceId,
    // 真实项目名只在 Main 接线层可得（需要 sourceAuthority），这里先放原始 id，由 ipc 层覆盖
    spaceLabel: memory.spaceId,
    importance: memory.importance,
    isCrystal: memory.isCrystal,
    isLatest: memory.isLatest,
    lifecycleState: memory.lifecycleState,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    appearances: memory.appearances,
    lastHitAt: memory.lastHitAt,
    hitCount: memory.hitCount,
    archiveCandidateAt: memory.archiveCandidateAt,
  };
}

function toEvolvesDto(edge: Evolves): EvolvesEdgeDto {
  return { ...edge };
}

function toCrystalSourceDto(
  source: ReturnType<typeof listCrystalSources>[number]
): CrystalSourceDto {
  return { ...toMemoryListItem(source.memory), contributionWeight: source.contributionWeight };
}

export function listMemoriesForAdmin(
  db: Database.Database,
  query: MemoryListQuery
): MemoryListResult {
  const conditions: string[] = ["m.lifecycle_state != 'deleted'"];
  const params: unknown[] = [];
  if (!query.includeArchived) conditions.push("m.lifecycle_state = 'active'");
  if (query.spaceId !== undefined && query.spaceId !== null) {
    conditions.push('m.space_id = ?');
    params.push(query.spaceId);
  } else if (query.spaceIds !== undefined) {
    if (query.spaceIds.length === 0) return { items: [], total: 0 };
    conditions.push(`m.space_id IN (${query.spaceIds.map(() => '?').join(',')})`);
    params.push(...query.spaceIds);
  }
  if (query.unitType !== undefined) {
    conditions.push('m.unit_type = ?');
    params.push(query.unitType);
  }
  if (query.staleDays !== undefined) {
    conditions.push('COALESCE(m.last_hit_at, m.created_at) < ?');
    params.push(staleCutoffIso(query.staleDays));
  }
  if (query.archiveCandidate === true) conditions.push('m.archive_candidate_at IS NOT NULL');
  const text = query.query?.trim() ?? '';
  if (text) {
    const { match, short } = buildFtsMatchQuery(text);
    const textConditions: string[] = [];
    if (match) {
      textConditions.push('m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)');
      params.push(match);
    }
    for (const token of short) {
      textConditions.push("m.semantic_field LIKE ? ESCAPE '\\'");
      params.push(`%${token.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    }
    if (textConditions.length > 0) conditions.push(`(${textConditions.join(' OR ')})`);
  }
  const where = conditions.join(' AND ');
  const total = (
    db.prepare(`SELECT count(*) AS total FROM memories m WHERE ${where}`).get(...params) as {
      total: number;
    }
  ).total;
  const rows = db
    .prepare(
      `SELECT ${MEMORY_COLUMNS.split(', ')
        .map((column) => `m.${column}`)
        .join(', ')} FROM memories m WHERE ${where}
       ORDER BY m.updated_at DESC, m.id ASC LIMIT ? OFFSET ?`
    )
    .all(...params, query.limit, query.offset) as MemoryRow[];
  return { items: rows.map(rowToMemory).map(toMemoryListItem), total };
}

/**
 * 语义模式：直接复用 agent 那条检索路径，保证「管理页搜得到 = agent 搜得到」。
 * 代价是没有精确 total、不能深分页（RRF 只给 top-N），也看不到已归档行（searchMemories 只查 active + latest）。
 * embedder 为 null 时 searchMemories 自动降级为 FTS + 实体两通道，不报错。
 */
export async function searchMemoriesForAdmin(
  db: Database.Database,
  query: MemoryListQuery,
  embedder: Embedder | null,
  assist?: SearchAssist | null
): Promise<MemoryListResult> {
  const text = query.query?.trim() ?? '';
  if (!text) return { items: [], total: 0, approximate: true, vectorsUsed: false, assist: 'off' };
  const explicit =
    query.spaceId !== undefined && query.spaceId !== null ? [query.spaceId] : query.spaceIds;
  if (explicit?.length === 0) {
    return { items: [], total: 0, approximate: true, vectorsUsed: false, assist: 'off' };
  }
  const spaceIds = explicit ?? listSpaceIds(db);
  const deep = query.mode === 'deep';
  const hits = await searchMemories(db, {
    q: text,
    spaceIds,
    limit: query.limit,
    embedder,
    mmr: true,
    mode: deep ? 'deep' : 'fast',
    assist: deep ? assist : undefined,
  });
  // unitType / staleDays / archiveCandidate 在语义通道里没有下推，只能在结果上后过滤
  const staleCutoff = query.staleDays === undefined ? null : staleCutoffIso(query.staleDays);
  const items = hits
    .map((hit) => toMemoryListItem(hit.memory))
    .filter((item) => query.unitType === undefined || item.unitType === query.unitType)
    .filter((item) => staleCutoff === null || (item.lastHitAt ?? item.createdAt) < staleCutoff)
    .filter((item) => query.archiveCandidate !== true || item.archiveCandidateAt !== null);
  return {
    items,
    total: items.length,
    approximate: true,
    vectorsUsed: embedder !== null,
    ...searchAssistReport(deep ? 'deep' : 'fast', deep ? assist : null),
  };
}

function listSpaceIds(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT DISTINCT space_id AS spaceId FROM memories WHERE lifecycle_state != 'deleted'"
      )
      .all() as {
      spaceId: string;
    }[]
  ).map((row) => row.spaceId);
}

export function getMemoryDetail(db: Database.Database, id: string): MemoryDetail | null {
  const memory = getMemory(db, id);
  if (!memory || memory.lifecycleState === 'deleted') return null;
  return {
    ...toMemoryListItem(memory),
    content: memory.content,
    eventStart: memory.eventStart,
    eventEnd: memory.eventEnd,
    temporalPrecision: memory.temporalPrecision,
    embeddingModel: memory.embeddingModel,
    evolves: listEvolves(db, id).map(toEvolvesDto),
    entityNames: listEntityNames(db, id),
    crystalSources: memory.isCrystal ? listCrystalSources(db, id).map(toCrystalSourceDto) : [],
  };
}

export function archiveMemory(db: Database.Database, id: string): Memory | null {
  return updateMemory(db, id, { lifecycleState: 'archived' });
}

export function restoreMemory(db: Database.Database, id: string): Memory | null {
  return updateMemory(db, id, { lifecycleState: 'active' });
}

export function deleteMemoryPermanently(db: Database.Database, id: string): boolean {
  const row = db
    .prepare('SELECT rowid, embedding_dim AS embeddingDim FROM memories WHERE id = ?')
    .get(id) as { rowid: number; embeddingDim: number | null } | undefined;
  if (!row) return false;
  return db
    .transaction(() => {
      if (row.embeddingDim !== null && vecTableExists(db, row.embeddingDim)) {
        vecDelete(db, row.rowid, row.embeddingDim);
      }
      db.prepare('DELETE FROM mentions WHERE memory_id = ?').run(id);
      db.prepare('DELETE FROM crystallized_from WHERE crystal_id = ? OR source_id = ?').run(id, id);
      db.prepare('DELETE FROM evolves WHERE older_id = ? OR newer_id = ?').run(id, id);
      db.prepare('DELETE FROM reconcile_checks WHERE older_id = ? OR newer_id = ?').run(id, id);
      db.prepare("DELETE FROM memory_jobs WHERE kind = 'kg' AND target LIKE ? ESCAPE '\\'").run(
        `${id.replace(/[\\%_]/g, (char) => `\\${char}`)}#%`
      );
      const deleted = db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
      deleteOrphanEntities(db);
      return deleted;
    })
    .immediate();
}

/** 没有任何提及的实体连同别名、关系一起清掉，避免旧实体名经实体 / 社区通道继续召回 */
export function deleteOrphanEntities(db: Database.Database): void {
  db.exec(`
    DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM mentions);
    DELETE FROM entity_aliases WHERE entity_id NOT IN (SELECT id FROM entities);
    DELETE FROM entity_relations
      WHERE source_id NOT IN (SELECT id FROM entities) OR target_id NOT IN (SELECT id FROM entities);
  `);
}

export function deleteMemorySpace(db: Database.Database, spaceId: string): number {
  return db
    .transaction(() => {
      if (spaceId.startsWith('bot:')) {
        db.prepare(
          "DELETE FROM memory_jobs WHERE kind = 'distill' AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.botId') END = ?"
        ).run(spaceId.slice(4));
      }
      // 群删除后，待续跑的成员蒸馏不再分流进已删的群 space（成员自身部分照常落 bot space）
      if (spaceId.startsWith('chat:')) {
        db.prepare(
          "UPDATE memory_jobs SET payload = json_remove(payload, '$.chatId') WHERE kind = 'distill' AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.chatId') END = ?"
        ).run(spaceId.slice(5));
      }
      const rows = db.prepare('SELECT id FROM memories WHERE space_id = ?').all(spaceId) as {
        id: string;
      }[];
      for (const row of rows) deleteMemoryPermanently(db, row.id);
      return rows.length;
    })
    .immediate();
}

/**
 * 待审阅的 challenges：一次查边、一次查两端记忆。
 * 只给 id 用户没法判断，所以两端都带上标题 / 摘要 / 空间 / 时间；任一端已删的边跳过。
 */
export function listPendingEvolves(db: Database.Database): PendingEvolvesReviewDto[] {
  const edges = listPendingEvolvesEdges(db);
  if (edges.length === 0) return [];
  const ids = [...new Set(edges.flatMap((edge) => [edge.olderId, edge.newerId]))];
  const rows = db
    .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as MemoryRow[];
  const byId = new Map(rows.map((row) => [row.id, rowToMemory(row)]));
  const result: PendingEvolvesReviewDto[] = [];
  for (const edge of edges) {
    const older = byId.get(edge.olderId);
    const newer = byId.get(edge.newerId);
    if (!older || !newer) continue;
    if (older.lifecycleState === 'deleted' || newer.lifecycleState === 'deleted') continue;
    result.push({
      edge: toEvolvesDto(edge),
      older: toMemoryListItem(older),
      newer: toMemoryListItem(newer),
    });
  }
  return result;
}

export function reviewEvolvesEdge(
  db: Database.Database,
  id: string,
  state: 'accepted' | 'rejected'
): EvolvesEdgeDto | null {
  const edge = reviewEvolves(db, id, state);
  return edge ? toEvolvesDto(edge) : null;
}

export function getMemoryStats(db: Database.Database, now: Date = new Date()): MemoryStats {
  const aggregate = db
    .prepare(
      `SELECT count(*) AS total,
              sum(CASE WHEN is_crystal = 1 THEN 1 ELSE 0 END) AS crystals,
              sum(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
       FROM memories WHERE lifecycle_state != 'deleted'`
    )
    .get() as { total: number; crystals: number | null; embedded: number | null };
  const spaces = db
    .prepare(
      `SELECT space_id AS spaceId, count(*) AS total FROM memories
       WHERE lifecycle_state != 'deleted' GROUP BY space_id ORDER BY space_id`
    )
    .all() as { spaceId: string; total: number }[];
  const entities = (db.prepare('SELECT count(*) AS total FROM entities').get() as { total: number })
    .total;
  // 同上：标签由 ipc 层填，服务层不认识项目注册表
  let databaseBytes = 0;
  try {
    databaseBytes = statSync(db.name).size;
  } catch {}
  const hits = getHitStats(db, now);
  return {
    total: aggregate.total,
    bySpace: Object.fromEntries(spaces.map((row) => [row.spaceId, row.total])),
    spaceLabels: {},
    crystals: aggregate.crystals ?? 0,
    entities,
    embedded: aggregate.embedded ?? 0,
    databaseBytes,
    neverHit: hits.neverHit,
    addedLast7Days: hits.addedLast7Days,
  };
}

function toDistillDto(job: DistillJob): DistillJobDto {
  return {
    id: job.id,
    sessionId: job.payload.sessionId,
    ...(job.payload.sessions?.length
      ? { sessionIds: job.payload.sessions.map((s) => s.sessionId) }
      : {}),
    projectId: job.payload.projectId,
    status: job.status,
    attempts: job.attempts,
    total: job.total,
    done: job.done,
    failed: job.failed,
    error: job.error,
    notes: job.notes,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function toKgDto(job: KgJob): KgJobDto {
  const { fingerprint: _fingerprint, ...dto } = job;
  return dto;
}

function toReembedDto(job: ReembedJob): ReembedJobDto {
  return { ...job };
}

export function toMemoryJobsSnapshot(
  distill: DistillJob[],
  kg: KgJob[],
  reembed: ReembedJob | null
): MemoryJobsSnapshot {
  return {
    distill: distill.map(toDistillDto),
    kg: kg.map(toKgDto),
    reembed: reembed ? toReembedDto(reembed) : null,
    kgFailed: 0,
  };
}

export function getMemoryJobsSnapshot(db: Database.Database, limit = 50): MemoryJobsSnapshot {
  return {
    ...toMemoryJobsSnapshot(listDistillJobs(db, limit), listKgJobs(db, limit), getReembedJob(db)),
    kgFailed: countFailedKgJobs(db),
  };
}

/** 只删终态行。pending/running 必须留着：worker 按 id 写回，删了会丢进度、状态永久错乱。失败仍是 done（kg 另记 failed=1），没有独立 failed 状态。 */
export function clearFinishedMemoryJobs(db: Database.Database): number {
  return db.prepare("DELETE FROM memory_jobs WHERE status IN ('done','cancelled')").run().changes;
}

export function openExistingMemoryDb(dbPath: string): Database.Database | null {
  return existsSync(dbPath) ? openMemoryDb(dbPath) : null;
}
