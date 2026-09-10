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
  ReembedJobDto,
} from '@shared/memory/dto';
import type Database from 'better-sqlite3';
import { listCrystalSources } from './memory/crystal';
import { openMemoryDb, vecTableExists } from './memory/db';
import { type DistillJob, listDistillJobs } from './memory/distill';
import { buildFtsMatchQuery } from './memory/fts';
import { type KgJob, listEntityNames, listKgJobs } from './memory/kg';
import { getReembedJob, type ReembedJob } from './memory/reembed';
import { searchMemories } from './memory/search';
import {
  getMemory,
  listEvolves,
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

function toListItem(memory: Memory): MemoryListItem {
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
    accessCount: memory.accessCount,
  };
}

function toEvolvesDto(edge: Evolves): EvolvesEdgeDto {
  return { ...edge };
}

function toCrystalSourceDto(
  source: ReturnType<typeof listCrystalSources>[number]
): CrystalSourceDto {
  return { ...toListItem(source.memory), contributionWeight: source.contributionWeight };
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
  }
  if (query.unitType !== undefined) {
    conditions.push('m.unit_type = ?');
    params.push(query.unitType);
  }
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
  return { items: rows.map(rowToMemory).map(toListItem), total };
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
  if (!text) return { items: [], total: 0, approximate: true, vectorsUsed: false };
  const spaceIds =
    query.spaceId !== undefined && query.spaceId !== null ? [query.spaceId] : listSpaceIds(db);
  const hits = await searchMemories(db, {
    q: text,
    spaceIds,
    limit: query.limit,
    embedder,
    mmr: true,
    mode: query.mode === 'deep' ? 'deep' : 'fast',
    assist: query.mode === 'deep' ? assist : undefined,
  });
  // unitType 在语义通道里没有下推，只能在结果上后过滤
  const items = hits
    .map((hit) => toListItem(hit.memory))
    .filter((item) => query.unitType === undefined || item.unitType === query.unitType);
  return { items, total: items.length, approximate: true, vectorsUsed: embedder !== null };
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
    ...toListItem(memory),
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
      db.prepare("DELETE FROM memory_jobs WHERE kind = 'kg' AND target LIKE ? ESCAPE '\\'").run(
        `${id.replace(/[\\%_]/g, (char) => `\\${char}`)}#%`
      );
      const deleted = db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
      db.exec(`
        DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM mentions);
        DELETE FROM entity_aliases WHERE entity_id NOT IN (SELECT id FROM entities);
        DELETE FROM entity_relations
          WHERE source_id NOT IN (SELECT id FROM entities) OR target_id NOT IN (SELECT id FROM entities);
      `);
      return deleted;
    })
    .immediate();
}

export function listPendingEvolves(db: Database.Database): EvolvesEdgeDto[] {
  const rows = db
    .prepare(
      "SELECT older_id AS olderId FROM evolves WHERE review_state = 'pending' ORDER BY created_at, id"
    )
    .all() as { olderId: string }[];
  const seen = new Set<string>();
  const result: EvolvesEdgeDto[] = [];
  for (const row of rows) {
    for (const edge of listEvolves(db, row.olderId)) {
      if (edge.reviewState !== 'pending' || seen.has(edge.id)) continue;
      seen.add(edge.id);
      result.push(toEvolvesDto(edge));
    }
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

export function getMemoryStats(db: Database.Database): MemoryStats {
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
  return {
    total: aggregate.total,
    bySpace: Object.fromEntries(spaces.map((row) => [row.spaceId, row.total])),
    spaceLabels: {},
    crystals: aggregate.crystals ?? 0,
    entities,
    embedded: aggregate.embedded ?? 0,
    databaseBytes,
  };
}

function toDistillDto(job: DistillJob): DistillJobDto {
  return {
    id: job.id,
    sessionId: job.payload.sessionId,
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
  };
}

export function getMemoryJobsSnapshot(db: Database.Database, limit = 50): MemoryJobsSnapshot {
  return toMemoryJobsSnapshot(listDistillJobs(db, limit), listKgJobs(db, limit), getReembedJob(db));
}

/** 只删终态行。pending/running 必须留着：worker 按 id 写回，删了会丢进度、状态永久错乱。失败是 done+error，没有独立 failed 状态。 */
export function clearFinishedMemoryJobs(db: Database.Database): number {
  return db.prepare("DELETE FROM memory_jobs WHERE status IN ('done','cancelled')").run().changes;
}

export function openExistingMemoryDb(dbPath: string): Database.Database | null {
  return existsSync(dbPath) ? openMemoryDb(dbPath) : null;
}
