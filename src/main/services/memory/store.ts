import { randomUUID } from 'node:crypto';
import {
  DEDUP_MAX,
  DEDUP_MIN_CHARS,
  DEDUP_VECTOR,
  DEFAULT_IMPORTANCE,
  DEFAULT_UNIT_TYPE,
  isEvolvesRelation,
} from '@shared/memory/constants';
import {
  expandTemporalRange,
  normalizeTemporalDate,
  type TemporalPrecision,
} from '@shared/memory/temporal';
import type Database from 'better-sqlite3';
import { contentHash } from './contentHash';
import { ensureVecTable, hasVec, vecTableExists, vecTableName } from './db';
import { buildFtsMatchQuery } from './fts';
import {
  type CreateMemoryInput,
  type CreateMemoryResult,
  type DedupCandidate,
  type Embedder,
  type Evolves,
  type EvolvesRelation,
  type EvolvesReviewState,
  isSpaceId,
  type Memory,
  MemoryValidationError,
  type UpdateMemoryPatch,
} from './types';

const DEFAULT_CONFIDENCE = 0.6;
const TITLE_MAX_CHARS = 80;
const EMBEDDING_VERSION = 1;

export interface MemoryRow {
  id: string;
  title: string;
  content: string;
  semantic_field: string;
  unit_type: string;
  unit_type_source: string;
  importance: number;
  confidence: number;
  space_id: string;
  source: string;
  is_latest: number;
  version: number;
  is_crystal: number;
  crystal_title: string | null;
  source_unit_count: number;
  lifecycle_state: string;
  temporal_context: string;
  temporal_type: string | null;
  event_start: string | null;
  event_end: string | null;
  temporal_precision: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
  appearances: number;
  clicks: number;
  embedding: Buffer | null;
  embedding_model: string | null;
  embedding_dim: number | null;
  embedding_version: number | null;
  idempotency_key: string | null;
}

export const MEMORY_COLUMNS =
  'id, title, content, semantic_field, unit_type, unit_type_source, importance, confidence, space_id, source, ' +
  'is_latest, version, is_crystal, crystal_title, source_unit_count, lifecycle_state, ' +
  'temporal_context, temporal_type, event_start, event_end, ' +
  'temporal_precision, created_at, updated_at, last_accessed_at, access_count, appearances, clicks, ' +
  'embedding_model, embedding_dim, embedding_version, idempotency_key';

export function rowToMemory(r: MemoryRow): Memory {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    unitType: r.unit_type as Memory['unitType'],
    unitTypeSource: r.unit_type_source as Memory['unitTypeSource'],
    importance: r.importance,
    confidence: r.confidence,
    spaceId: r.space_id,
    source: r.source as Memory['source'],
    isLatest: r.is_latest === 1,
    version: r.version,
    isCrystal: r.is_crystal === 1,
    crystalTitle: r.crystal_title,
    sourceUnitCount: r.source_unit_count,
    lifecycleState: r.lifecycle_state as Memory['lifecycleState'],
    temporalContext: r.temporal_context as Memory['temporalContext'],
    temporalType: r.temporal_type as Memory['temporalType'],
    eventStart: r.event_start,
    eventEnd: r.event_end,
    temporalPrecision: r.temporal_precision as Memory['temporalPrecision'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastAccessedAt: r.last_accessed_at,
    accessCount: r.access_count,
    appearances: r.appearances,
    clicks: r.clicks,
    embeddingModel: r.embedding_model,
    embeddingDim: r.embedding_dim,
    embeddingVersion: r.embedding_version,
    idempotencyKey: r.idempotency_key,
  };
}

// 索引文本 = title + "\n" + content
export function semanticField(title: string, content: string): string {
  return `${title}\n${content}`;
}

// TITLE max 80；显式传入与从正文推导都走同一道截断，agent 无法写入超长标题
function clampTitle(title: string): string {
  return Array.from(title).slice(0, TITLE_MAX_CHARS).join('');
}

function deriveTitle(content: string): string {
  return clampTitle(content.split(/\r?\n/, 1)[0].trim());
}

// timeless 不命中事件日期过滤，有事件日期时若仍缺省 timeless，带日期的记忆会在双时间检索里被丢掉；
// 这里按事件区间相对 now 派生 past/present/future。
function deriveTemporalContext(
  eventStart: string,
  eventEnd: string | null,
  precision: TemporalPrecision,
  now: Date
): 'past' | 'present' | 'future' {
  const today = now.toISOString().slice(0, 10);
  const [, startEnd] = expandTemporalRange(eventStart, precision);
  const end = eventEnd ?? startEnd;
  if (end < today) return 'past';
  if (eventStart > today) return 'future';
  return 'present';
}

// 去重阈值 DEDUP_VECTOR 依赖归一化向量，写入前统一 L2 归一化，存 float32 LE。
export function encodeEmbedding(vec: Float32Array): Buffer {
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = norm > 0 ? vec[i] / norm : 0;
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

export function decodeEmbedding(buf: Buffer, dim: number): Float32Array {
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, dim);
}

/** BLOB 列是权威副本，vec 表是可重建索引；扩展不可用时只写 BLOB，等 syncVecTables 事后补齐 */
export function vecInsert(
  db: Database.Database,
  rowid: number,
  emb: { blob: Buffer; model: string; dim: number },
  spaceId: string
): void {
  if (!hasVec(db)) return;
  const table = ensureVecTable(db, emb.dim);
  db.prepare(`INSERT INTO ${table}(rowid, embedding, model, space_id) VALUES (?, ?, ?, ?)`).run(
    BigInt(rowid),
    emb.blob,
    emb.model,
    spaceId
  );
}

export function vecDelete(db: Database.Database, rowid: number, dim: number | null): void {
  if (!hasVec(db) || dim === null || !vecTableExists(db, dim)) return;
  db.prepare(`DELETE FROM ${vecTableName(dim)} WHERE rowid = ?`).run(BigInt(rowid));
}

/** embedding 失败不得阻止落库，失败返回 null */
async function tryEmbed(embedder: Embedder | null | undefined, text: string) {
  if (!embedder) return null;
  try {
    const vec = await embedder.embed(text, 'passage');
    if (!vec || vec.length === 0) return null;
    return { blob: encodeEmbedding(vec), model: embedder.model, dim: vec.length };
  } catch {
    return null;
  }
}

function resolveEventDates(input: CreateMemoryInput) {
  const [eventStart, precision] = normalizeTemporalDate(input.eventStart);
  if (input.eventStart?.trim() && !eventStart) {
    throw new MemoryValidationError(
      'invalid_event_date',
      `invalid event_start: ${input.eventStart}`
    );
  }
  const [eventEnd] = normalizeTemporalDate(input.eventEnd);
  if (input.eventEnd?.trim() && !eventEnd) {
    throw new MemoryValidationError('invalid_event_date', `invalid event_end: ${input.eventEnd}`);
  }
  if (eventStart && eventEnd && eventEnd < eventStart) {
    throw new MemoryValidationError(
      'event_range',
      'event_end must not be earlier than event_start'
    );
  }
  return { eventStart, eventEnd, precision };
}

interface EvolvesRow {
  id: string;
  older_id: string;
  newer_id: string;
  content_relation: string;
  confidence: number;
  reason: string | null;
  review_state: string;
  reviewed_at: string | null;
  created_at: string;
}

const rowToEvolves = (r: EvolvesRow): Evolves => ({
  id: r.id,
  olderId: r.older_id,
  newerId: r.newer_id,
  relation: r.content_relation as EvolvesRelation,
  confidence: r.confidence,
  reason: r.reason,
  reviewState: r.review_state as EvolvesReviewState,
  reviewedAt: r.reviewed_at,
  createdAt: r.created_at,
});

// 显式关系由调用方看过候选全文后提交，缺省置信度 1.0；EVOLVES_MIN_CONF 是自动推断边的门限，不适用于这里
const EXPLICIT_EVOLVES_CONFIDENCE = 1;

function resolveEvolves(
  input: CreateMemoryInput
): { fromId: string; relation: EvolvesRelation; reason: string | null; confidence: number } | null {
  const fromId = input.evolvesFromId ?? null;
  const relation = input.evolvesRelation ?? null;
  if (fromId === null && relation === null) return null;
  if (!fromId?.trim() || !isEvolvesRelation(relation)) {
    throw new MemoryValidationError(
      'invalid_evolves',
      'evolves_from_id and a relation in replaces|enriches|confirms|challenges must be given together'
    );
  }
  const confidence = input.evolvesConfidence ?? EXPLICIT_EVOLVES_CONFIDENCE;
  if (!(confidence >= 0 && confidence <= 1)) {
    throw new MemoryValidationError('invalid_evolves', 'evolves confidence must be within [0, 1]');
  }
  return { fromId, relation, reason: input.evolvesReason?.trim() || null, confidence };
}

// 同 space 内最新、活跃的完全重复文本；历史版本不阻止同文本再次成为最新
function findByContentHash(db: Database.Database, spaceId: string, hash: string) {
  return db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE space_id = ? AND content_hash = ? AND is_latest = 1 AND lifecycle_state = 'active'
       ORDER BY created_at ASC LIMIT 1`
    )
    .get(spaceId, hash) as MemoryRow | undefined;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * 候选网：同 space、is_latest、非 crystal；候选池 = 向量 top-DEDUP_MAX ∩ FTS top-DEDUP_MAX 的并集，
 * 准入只看余弦相似度 ≥ DEDUP_VECTOR（库内向量已 L2 归一化）；bm25_top1 只是返回字段。
 * sqlite-vec 不可用时退到扫 BLOB，去重能力不随扩展一起降级。
 */
function findCandidates(
  db: Database.Database,
  spaceId: string,
  field: string,
  emb: { blob: Buffer; model: string; dim: number }
): DedupCandidate[] {
  const scope = `m.space_id = ? AND m.is_latest = 1 AND m.is_crystal = 0 AND m.lifecycle_state = 'active'`;
  const query = new Float32Array(emb.blob.buffer, emb.blob.byteOffset, emb.dim);
  const pool = new Set<string>();
  if (hasVec(db) && vecTableExists(db, emb.dim)) {
    // vec 表只按 model/space 分区，crystal / 非 active 行仍在表里会吃掉 KNN 名额：
    // 从 k=DEDUP_MAX 起，JOIN 过滤后不足且 KNN 满额就翻倍重查，直到拿到严格的合格 top-DEDUP_MAX
    const knn = db.prepare(
      `SELECT m.id AS id, v.rowid AS rowid FROM (SELECT rowid, distance FROM ${vecTableName(emb.dim)}
         WHERE embedding MATCH ? AND k = ? AND model = ? AND space_id = ?) v
       LEFT JOIN memories m ON m.rowid = v.rowid AND ${scope}
       ORDER BY v.distance ASC`
    );
    let eligible: { id: string | null }[] = [];
    for (let k = DEDUP_MAX; k <= DEDUP_MAX * 64; k *= 2) {
      const rows = knn.all(emb.blob, k, emb.model, spaceId, spaceId) as {
        id: string | null;
        rowid: number;
      }[];
      eligible = rows.filter((r) => r.id !== null).slice(0, DEDUP_MAX);
      if (eligible.length >= DEDUP_MAX || rows.length < k) break;
    }
    // 到上限仍不足 DEDUP_MAX 也要把已筛出的合格行收进池，否则向量候选为空只剩 FTS
    for (const r of eligible) pool.add(r.id as string);
  } else {
    const rows = db
      .prepare(
        `SELECT m.id AS id, m.embedding AS embedding FROM memories m
         WHERE ${scope} AND m.embedding_model = ? AND m.embedding_dim = ?`
      )
      .all(spaceId, emb.model, emb.dim) as { id: string; embedding: Buffer }[];
    const top = rows
      .map((r) => ({ id: r.id, sim: cosine(query, decodeEmbedding(r.embedding, emb.dim)) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, DEDUP_MAX);
    for (const r of top) pool.add(r.id);
  }
  let bm25Top1: string | null = null;
  const { match } = buildFtsMatchQuery(field);
  if (match) {
    try {
      const rows = db
        .prepare(
          `SELECT m.id AS id FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
           WHERE memories_fts MATCH ? AND ${scope} ORDER BY memories_fts.rank LIMIT ?`
        )
        .all(match, spaceId, DEDUP_MAX) as { id: string }[];
      bm25Top1 = rows[0]?.id ?? null;
      for (const r of rows) pool.add(r.id);
    } catch {
      // FTS 单通道失败不影响向量准入
    }
  }
  if (pool.size === 0) return [];
  const placeholders = [...pool].map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ${MEMORY_COLUMNS}, embedding FROM memories
       WHERE id IN (${placeholders}) AND embedding_model = ? AND embedding_dim = ?`
    )
    .all(...pool, emb.model, emb.dim) as (MemoryRow & { embedding: Buffer })[];
  return rows
    .map((r) => ({
      memory: rowToMemory(r),
      similarity: cosine(query, decodeEmbedding(r.embedding, emb.dim)),
      bm25Top1: r.id === bm25Top1,
    }))
    .filter((c) => c.similarity >= DEDUP_VECTOR)
    .sort((a, b) => b.similarity - a.similarity || (a.memory.id < b.memory.id ? -1 : 1))
    .slice(0, DEDUP_MAX);
}

export interface CreateMemoryOptions {
  embedder?: Embedder | null;
  now?: Date;
  /**
   * 只在真正新插一行后（事务已提交）调用，幂等命中 / hash 去重 / candidates 不调。
   * best-effort：抛错被吞，不影响创建结果；不得在这里同步调 LLM。
   */
  onCreated?: (memory: Memory) => void;
  /**
   * 插入后、事务提交前在同一事务内追加写（crystal 标位与边）；抛错则整条记忆回滚，不留半成品。
   * 只在真正新插时调用，幂等 / hash 去重 / candidates 不调。
   */
  inTransaction?: (db: Database.Database, id: string) => void;
}

export async function createMemory(
  db: Database.Database,
  input: CreateMemoryInput,
  opts: CreateMemoryOptions = {}
): Promise<CreateMemoryResult> {
  const result = await createMemoryInner(db, input, opts);
  if (opts.onCreated && result.status === 'inserted' && !result.deduplicated && result.fresh) {
    try {
      opts.onCreated(result.memory);
    } catch {
      /* 尽力而为 */
    }
  }
  const { fresh: _fresh, ...rest } = result;
  return rest;
}

type InnerResult = CreateMemoryResult & { fresh?: true };

async function createMemoryInner(
  db: Database.Database,
  input: CreateMemoryInput,
  opts: CreateMemoryOptions
): Promise<InnerResult> {
  const content = input.content?.trim() ?? '';
  if (!content) throw new MemoryValidationError('empty_content', 'content is empty');
  if (!isSpaceId(input.spaceId)) {
    throw new MemoryValidationError('invalid_space', `invalid space_id: ${input.spaceId}`);
  }
  const { eventStart, eventEnd, precision } = resolveEventDates(input);
  const evolves = resolveEvolves(input);
  // '' 会被真值判断跳过幂等查找，却仍写进 UNIQUE 列，第二次直接冲突；显式拒绝
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
    if (!input.idempotencyKey.trim()) {
      throw new MemoryValidationError('invalid_idempotency_key', 'idempotency_key is empty');
    }
  }
  const byKey = (key: string) =>
    db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE idempotency_key = ?`).get(key) as
      | MemoryRow
      | undefined;
  const hash = contentHash(content);
  // 显式关系 / force 是调用方看过候选后的确定提交，必须生效：同文 replaces 也要写边、bump version，
  // 所以精确去重只对普通提交生效
  const hashDedup = !input.force && !evolves;
  // 幂等键 / 完全重复在嵌入之前就能判定，省掉一次推理；事务内还会再查一次兑底并发
  const early = (input.idempotencyKey && byKey(input.idempotencyKey)) || undefined;
  if (early) return { status: 'inserted', memory: rowToMemory(early) };
  const dup = hashDedup ? findByContentHash(db, input.spaceId, hash) : undefined;
  if (dup) return { status: 'inserted', memory: rowToMemory(dup), deduplicated: true };

  const title = clampTitle(input.title?.trim() ?? '') || deriveTitle(content);
  const field = semanticField(title, content);
  const embedding = await tryEmbed(opts.embedder, field);
  // 短文本跳过候选网；显式关系 / force 表示调用方已看过候选；没有向量时退化为只做 hash
  const runCandidateNet =
    !input.force && !evolves && embedding !== null && Array.from(content).length >= DEDUP_MIN_CHARS;
  const nowDate = opts.now ?? new Date();
  const now = nowDate.toISOString();
  const id = randomUUID();

  const row = {
    id,
    title,
    content,
    semantic_field: field,
    unit_type: input.unitType ?? DEFAULT_UNIT_TYPE,
    unit_type_source: input.unitTypeSource ?? (input.unitType ? 'explicit' : 'default'),
    importance: input.importance ?? DEFAULT_IMPORTANCE,
    confidence: input.confidence ?? DEFAULT_CONFIDENCE,
    space_id: input.spaceId,
    source: input.source ?? 'manual',
    temporal_context:
      input.temporalContext ??
      (eventStart && precision
        ? deriveTemporalContext(eventStart, eventEnd, precision, nowDate)
        : 'timeless'),
    temporal_type: input.temporalType ?? (eventStart ? (eventEnd ? 'range' : 'exact') : null),
    event_start: eventStart,
    event_end: eventEnd,
    temporal_precision: precision,
    created_at: now,
    updated_at: now,
    // last_accessed_at 缺省 = created_at，新记忆一开始是「新鲜」的
    last_accessed_at: now,
    embedding: embedding?.blob ?? null,
    embedding_model: embedding?.model ?? null,
    embedding_dim: embedding?.dim ?? null,
    embedding_version: embedding ? EMBEDDING_VERSION : null,
    idempotency_key: input.idempotencyKey ?? null,
    content_hash: hash,
    version: 1,
  };

  // 幂等 / hash / 候选检查、关系写入、插入、replaces 对旧行的更新必须同一事务且 BEGIN IMMEDIATE
  return db
    .transaction((): InnerResult => {
      if (row.idempotency_key !== null) {
        const existing = byKey(row.idempotency_key);
        if (existing) return { status: 'inserted', memory: rowToMemory(existing) };
      }
      const same = hashDedup ? findByContentHash(db, row.space_id, hash) : undefined;
      if (same) return { status: 'inserted', memory: rowToMemory(same), deduplicated: true };
      let older: Memory | null = null;
      if (evolves) {
        older = getMemory(db, evolves.fromId);
        // 已删除的行对调用方不可见，不能作为关系的另一端
        if (!older || older.lifecycleState === 'deleted') {
          throw new MemoryValidationError(
            'evolves_target_not_found',
            `evolves_from_id not found: ${evolves.fromId}`
          );
        }
        if (older.spaceId !== row.space_id) {
          throw new MemoryValidationError(
            'evolves_space_mismatch',
            'evolves_from_id belongs to another space'
          );
        }
        if (evolves.relation === 'replaces') row.version = older.version + 1;
      }
      if (runCandidateNet && embedding) {
        const candidates = findCandidates(db, row.space_id, field, embedding);
        if (candidates.length > 0) return { status: 'candidates_found', candidates };
      }
      try {
        const rowid = insertRow(db, row);
        if (embedding) vecInsert(db, rowid, embedding, row.space_id);
      } catch (error) {
        // 另一连接在我们 SELECT 与 INSERT 之间写入了同 key（BEGIN IMMEDIATE 在同一连接内串行，跨连接靠这里兑底）：
        // 按幂等语义返回已有行，而不是把 UNIQUE 冲突抛给调用方
        const existing =
          row.idempotency_key !== null && isUniqueViolation(error)
            ? byKey(row.idempotency_key)
            : undefined;
        if (!existing) throw error;
        return { status: 'inserted', memory: rowToMemory(existing) };
      }
      let edge: Evolves | undefined;
      if (evolves && older) {
        edge = insertEvolves(db, older, id, evolves, now);
        // replaces：旧行退出最新版本且不再占 KNN 名额；enriches/confirms/challenges 旧行不动
        if (evolves.relation === 'replaces') {
          db.prepare('UPDATE memories SET is_latest = 0, updated_at = ? WHERE id = ?').run(
            now,
            older.id
          );
          const r = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(older.id) as {
            rowid: number;
          };
          vecDelete(db, r.rowid, older.embeddingDim);
        }
      }
      opts.inTransaction?.(db, id);
      return {
        status: 'inserted',
        memory: getMemory(db, id) as Memory,
        evolves: edge,
        fresh: true,
      };
    })
    .immediate();
}

function insertEvolves(
  db: Database.Database,
  older: Memory,
  newerId: string,
  e: { relation: EvolvesRelation; reason: string | null; confidence: number },
  now: string
): Evolves {
  // 矛盾关系留待审阅；其余由调用方显式提交，视为已接受
  const pending = e.relation === 'challenges';
  const edgeId = randomUUID();
  db.prepare(
    `INSERT INTO evolves (id, older_id, newer_id, content_relation, confidence, reason, review_state, reviewed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    edgeId,
    older.id,
    newerId,
    e.relation,
    e.confidence,
    e.reason,
    pending ? 'pending' : 'accepted',
    pending ? null : now,
    now
  );
  return rowToEvolves(db.prepare('SELECT * FROM evolves WHERE id = ?').get(edgeId) as EvolvesRow);
}

/** 与指定记忆相连的全部关系（作为旧方或新方），按创建时间排序 */
export function listEvolves(db: Database.Database, memoryId: string): Evolves[] {
  const rows = db
    .prepare(
      'SELECT * FROM evolves WHERE older_id = ? OR newer_id = ? ORDER BY created_at ASC, id ASC'
    )
    .all(memoryId, memoryId) as EvolvesRow[];
  return rows.map(rowToEvolves);
}

/** 审阅只改 review_state / reviewed_at；拒绝 challenge 不删关系也不动任何 is_latest */
export function reviewEvolves(
  db: Database.Database,
  id: string,
  state: Exclude<EvolvesReviewState, 'pending'>,
  opts: { now?: Date } = {}
): Evolves | null {
  db.prepare('UPDATE evolves SET review_state = ?, reviewed_at = ? WHERE id = ?').run(
    state,
    (opts.now ?? new Date()).toISOString(),
    id
  );
  const row = db.prepare('SELECT * FROM evolves WHERE id = ?').get(id) as EvolvesRow | undefined;
  return row ? rowToEvolves(row) : null;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT';
}

function insertRow(db: Database.Database, row: Record<string, unknown>): number {
  const info = db
    .prepare(
      `INSERT INTO memories (id, title, content, semantic_field, unit_type, unit_type_source, importance,
           confidence, space_id, source, temporal_context, temporal_type, event_start, event_end,
           temporal_precision, created_at, updated_at, last_accessed_at, embedding, embedding_model,
           embedding_dim, embedding_version, idempotency_key, content_hash, version)
         VALUES (@id, @title, @content, @semantic_field, @unit_type, @unit_type_source, @importance,
           @confidence, @space_id, @source, @temporal_context, @temporal_type, @event_start, @event_end,
           @temporal_precision, @created_at, @updated_at, @last_accessed_at, @embedding, @embedding_model,
           @embedding_dim, @embedding_version, @idempotency_key, @content_hash, @version)`
    )
    .run(row);
  return Number(info.lastInsertRowid);
}

export function getMemory(db: Database.Database, id: string): Memory | null {
  const row = db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`).get(id) as
    | MemoryRow
    | undefined;
  return row ? rowToMemory(row) : null;
}

export function listMemories(
  db: Database.Database,
  opts: { spaceIds: string[]; limit?: number; offset?: number; includeNonLatest?: boolean }
): Memory[] {
  if (opts.spaceIds.length === 0) return [];
  const placeholders = opts.spaceIds.map(() => '?').join(',');
  const latest = opts.includeNonLatest ? '' : "AND is_latest = 1 AND lifecycle_state = 'active'";
  const rows = db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE space_id IN (${placeholders}) ${latest}
       ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`
    )
    .all(...opts.spaceIds, opts.limit ?? 100, opts.offset ?? 0) as MemoryRow[];
  return rows.map(rowToMemory);
}

export function updateMemory(
  db: Database.Database,
  id: string,
  patch: UpdateMemoryPatch,
  opts: { now?: Date } = {}
): Memory | null {
  const current = getMemory(db, id);
  if (!current) return null;
  const nextTitle = patch.title?.trim();
  const title = nextTitle ? clampTitle(nextTitle) : current.title;
  const content = patch.content?.trim() || current.content;
  const contentChanged = title !== current.title || content !== current.content;
  const sets: string[] = ['updated_at = @updated_at'];
  const params: Record<string, unknown> = {
    id,
    updated_at: (opts.now ?? new Date()).toISOString(),
  };
  if (contentChanged) {
    sets.push(
      'title = @title',
      'content = @content',
      'semantic_field = @semantic_field',
      'content_hash = @content_hash'
    );
    // 正文变了旧向量即失效，清空交由后续重嵌
    sets.push(
      'embedding = NULL',
      'embedding_model = NULL',
      'embedding_dim = NULL',
      'embedding_version = NULL'
    );
    Object.assign(params, {
      title,
      content,
      semantic_field: semanticField(title, content),
      content_hash: contentHash(content),
    });
  }
  if (patch.unitType !== undefined) {
    sets.push('unit_type = @unit_type', "unit_type_source = 'explicit'");
    params.unit_type = patch.unitType;
  }
  if (patch.importance !== undefined) {
    sets.push('importance = @importance');
    params.importance = patch.importance;
  }
  if (patch.lifecycleState !== undefined) {
    sets.push('lifecycle_state = @lifecycle_state');
    params.lifecycle_state = patch.lifecycleState;
  }
  if (patch.isLatest !== undefined) {
    sets.push('is_latest = @is_latest');
    params.is_latest = patch.isLatest ? 1 : 0;
  }
  db.transaction(() => {
    db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = @id`).run(params);
    // 正文变了旧向量失效；不再是最新版本则不该占 KNN 名额（vec 表只索引 is_latest = 1）
    if (contentChanged || patch.isLatest === false) {
      const r = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
      vecDelete(db, r.rowid, current.embeddingDim);
    }
    // 正文变了旧实体提及失效（新指纹由 onUpdated 重新排抽）；删除的记忆不能再通过实体被召回。
    // 只改标题时 KG 指纹（只算正文）不变、不会自动重抽，先删会永久丢关联（开库清孤儿还会删实体）；
    // 标题引起的重抽由调用方显式排队，抽完 applyExtraction 整体替换旧提及。
    if (content !== current.content || patch.lifecycleState === 'deleted') {
      db.prepare('DELETE FROM mentions WHERE memory_id = ?').run(id);
    }
  }).immediate();
  return getMemory(db, id);
}
