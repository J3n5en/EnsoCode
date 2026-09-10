import { CRYSTAL_BOOST, MMR_LAMBDA, RRF_K } from '@shared/memory/constants';
import { computeDecayScore } from '@shared/memory/decay';
import { normalizeEntityName } from '@shared/memory/entityNormalize';
import { mmrRerank } from '@shared/memory/mmr';
import { finalScore, minMaxNormalize, rrf } from '@shared/memory/rrf';
import { channelWeights, detectSearchIntent } from '@shared/memory/searchIntent';
import { expandTemporalRange, normalizeTemporalDate } from '@shared/memory/temporal';
import { computeTemporalBoost, detectTemporalIntent } from '@shared/memory/temporalIntent';
import type Database from 'better-sqlite3';
import { hasVec, vecTableExists, vecTableName } from './db';
import { buildFtsMatchQuery } from './fts';
import {
  decodeEmbedding,
  encodeEmbedding,
  MEMORY_COLUMNS,
  type MemoryRow,
  rowToMemory,
} from './store';
import {
  type Embedder,
  type MemorySearchHit,
  MemoryValidationError,
  type SearchOptions,
} from './types';

export { buildFtsMatchQuery } from './fts';

const DEFAULT_LIMIT = 10;
// decay 要能把页外「重要且常被访问但语义名次略低」的老记忆拉进结果，就不能先截 limit 再混分：
// RRF 后先取一个候选池做 min-max + finalScore，排完再截。乘 3 让大 limit 有足够还原空间，
// +10 保证小 limit（如 1、2）时池子也不至于小到让 decay 没机会发声。
const RERANK_POOL_MULTIPLIER = 3;
const RERANK_POOL_MIN_EXTRA = 10;
export const rerankPoolSize = (limit: number) =>
  Math.max(limit * RERANK_POOL_MULTIPLIER, limit + RERANK_POOL_MIN_EXTRA);
// model / space_id 已是 vec 表 partition key，KNN 只剩 lifecycle_state 要靠 JOIN 主表滤；
// 超采样只为兜 archived 行，倍数不用大
const KNN_OVERSAMPLE = 2;

interface Scope {
  sql: string;
  params: string[];
}

// 字典序上下界：YYYY-MM-DD 字符串比较即时间序
const DATE_MIN = '0000-00-00';
const DATE_MAX = '9999-99-99';

// 记忆事件区间的结束日：有 event_end 用它，否则取 event_start 所属精度区间的末日；
// 与 @shared/memory/temporal expandTemporalRange 同语义，只是下推到 SQL 里以便在通道内过滤
const EVENT_END_SQL = `COALESCE(m.event_end, CASE m.temporal_precision
  WHEN 'year' THEN substr(m.event_start, 1, 4) || '-12-31'
  WHEN 'month' THEN date(m.event_start, 'start of month', '+1 month', '-1 day')
  ELSE m.event_start END)`;

function parseBound(value: string | null | undefined, name: string, end: boolean): string | null {
  if (value === undefined || value === null || !value.trim()) return null;
  const [date, precision] = normalizeTemporalDate(value);
  if (!date) throw new MemoryValidationError('invalid_date', `invalid ${name}: ${value}`);
  // 查询边界也按精度补齐：to=2020 指到 2020-12-31
  return end ? expandTemporalRange(date, precision)[1] : date;
}

/** 双时间过滤：event_* 滤事件区间（相交），recorded_* 滤 created_at；二者不得混用 */
function temporalClause(opts: SearchOptions): Scope {
  const eventFrom = parseBound(opts.eventDateFrom, 'event_date_from', false);
  const eventTo = parseBound(opts.eventDateTo, 'event_date_to', true);
  const recFrom = parseBound(opts.recordedDateFrom, 'recorded_date_from', false);
  const recTo = parseBound(opts.recordedDateTo, 'recorded_date_to', true);
  const hasEvent = eventFrom !== null || eventTo !== null;
  const hasRecorded = recFrom !== null || recTo !== null;
  if (hasEvent && hasRecorded) {
    throw new MemoryValidationError(
      'temporal_filter_conflict',
      // 错误信息会原样回到模型，要能让它自己改参数
      'eventDateFrom/eventDateTo and recordedDateFrom/recordedDateTo cannot be combined: use eventDate* ' +
        'to filter by when the event happened, or recordedDate* to filter by when it was recorded, not both'
    );
  }
  if (eventFrom && eventTo && eventTo < eventFrom) {
    throw new MemoryValidationError('date_range', 'event_date_to is earlier than event_date_from');
  }
  if (recFrom && recTo && recTo < recFrom) {
    throw new MemoryValidationError(
      'date_range',
      'recorded_date_to is earlier than recorded_date_from'
    );
  }
  if (hasEvent) {
    // 闭区间相交（rangesIntersect 的 SQL 形式）；timeless 永不命中
    return {
      sql: `m.event_start IS NOT NULL AND m.temporal_context != 'timeless'
        AND m.event_start <= ? AND ${EVENT_END_SQL} >= ?`,
      params: [eventTo ?? DATE_MAX, eventFrom ?? DATE_MIN],
    };
  }
  if (hasRecorded) {
    return {
      sql: 'substr(m.created_at, 1, 10) BETWEEN ? AND ?',
      params: [recFrom ?? DATE_MIN, recTo ?? DATE_MAX],
    };
  }
  return { sql: '1 = 1', params: [] };
}

function scopeClause(spaceIds: string[], temporal: Scope): Scope {
  const placeholders = spaceIds.map(() => '?').join(',');
  return {
    sql: `m.is_latest = 1 AND m.lifecycle_state = 'active' AND m.space_id IN (${placeholders}) AND ${temporal.sql}`,
    params: [...spaceIds, ...temporal.params],
  };
}

function ftsChannel(db: Database.Database, q: string, scope: Scope, pool: number): string[] {
  const { match, short } = buildFtsMatchQuery(q);
  const ids: string[] = [];
  // MATCH 与 LIKE 各自兜底：短词/中文靠 LIKE，MATCH 出错（FTS 表损坏等）不能连带把它吞掉——
  // 没有向量通道时，那样整次检索就是空
  if (match) {
    try {
      const rows = db
        .prepare(
          `SELECT m.id AS id FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
           WHERE memories_fts MATCH ? AND ${scope.sql} ORDER BY memories_fts.rank LIMIT ?`
        )
        .all(match, ...scope.params, pool) as { id: string }[];
      ids.push(...rows.map((r) => r.id));
    } catch {}
  }
  if (short.length > 0 && ids.length < pool) {
    const like = short.map(() => "m.semantic_field LIKE ? ESCAPE '\\'").join(' OR ');
    const patterns = short.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    try {
      const rows = db
        .prepare(
          `SELECT m.id AS id FROM memories m WHERE ${scope.sql} AND (${like})
           ORDER BY m.updated_at DESC, m.id ASC LIMIT ?`
        )
        .all(...scope.params, ...patterns, pool) as { id: string }[];
      ids.push(...rows.map((r) => r.id));
    } catch {}
  }
  return ids;
}

// 实体通道：查询串里出现的实体（正名或别名）所提及的记忆。
// 正文没有该词、只靠 MENTIONS 关联的记忆只能从这里召回，这是它区别于 FTS / 向量的价值。
// 匹配在归一键上做子串判断（normalizeEntityName 去空白与连字符），实体名普遍很短，
// 反过来在查询里找实体比给查询分词更稳；单字实体噪声太大，按归一后长度设下限。
const ENTITY_MIN_CHARS = 2;

function entityChannel(db: Database.Database, q: string, scope: Scope, pool: number): string[] {
  const key = normalizeEntityName(q);
  if (!key) return [];
  try {
    const rows = db
      .prepare(
        `SELECT m.id AS id, max(mn.confidence) AS conf
         FROM memories m
         JOIN mentions mn ON mn.memory_id = m.id
         JOIN entities e ON e.id = mn.entity_id AND e.space_id = m.space_id
         LEFT JOIN entity_aliases a ON a.entity_id = e.id
         WHERE ${scope.sql}
           AND ((length(e.normalized_name) >= ? AND instr(?, e.normalized_name) > 0)
             OR (length(a.normalized_alias) >= ? AND instr(?, a.normalized_alias) > 0))
         GROUP BY m.id
         ORDER BY conf DESC, m.updated_at DESC, m.id ASC LIMIT ?`
      )
      .all(...scope.params, ENTITY_MIN_CHARS, key, ENTITY_MIN_CHARS, key, pool) as { id: string }[];
    return rows.map((r) => r.id);
  } catch {
    // 与其它通道一致：单通道失败不能拖垮整次检索
    return [];
  }
}

async function vectorChannel(
  db: Database.Database,
  embedder: Embedder,
  q: string,
  spaceIds: string[],
  scope: Scope,
  pool: number
): Promise<string[]> {
  // 扩展未加载或该维度还没有任何向量：通道为空，RRF 退化为纯 FTS
  if (!hasVec(db)) return [];
  if (embedder.dim !== null && !vecTableExists(db, embedder.dim)) return [];
  const query = await embedder.embed(q, 'query');
  if (!query || query.length === 0) return [];
  // 维度可能到这里才首次已知（onnx / remote）
  const dim = embedder.dim ?? query.length;
  if (query.length !== dim || !vecTableExists(db, dim)) return [];
  // KNN 下推到 sqlite-vec：cosine distance = 1 - cos，只保留 cos > 0（与旧版点积过滤一致）；
  // model / space_id 作为 partition key 在 vec 表内过滤（实测 0.1.9 partition key 支持 IN），
  // 外层 space 的海量行不会挤占本 space 的 k 名额（3a 评审 Major 4）
  const spacePlaceholders = spaceIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT m.id AS id, v.distance AS distance
       FROM (SELECT rowid, distance FROM ${vecTableName(dim)}
             WHERE embedding MATCH ? AND k = ? AND model = ? AND space_id IN (${spacePlaceholders})) v
       JOIN memories m ON m.rowid = v.rowid
       WHERE ${scope.sql} AND m.embedding_model = ? AND v.distance < 1
       ORDER BY v.distance ASC, m.id ASC LIMIT ?`
    )
    .all(
      encodeEmbedding(query),
      pool * KNN_OVERSAMPLE,
      embedder.model,
      ...spaceIds,
      ...scope.params,
      embedder.model,
      pool
    ) as { id: string; distance: number }[];
  return rows.map((r) => r.id);
}

function loadVectors(
  db: Database.Database,
  ids: string[],
  model: string | null
): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (!model || ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT id, embedding, embedding_dim FROM memories
       WHERE id IN (${ids.map(() => '?').join(',')}) AND embedding_model = ? AND embedding IS NOT NULL`
    )
    .all(...ids, model) as { id: string; embedding: Buffer; embedding_dim: number }[];
  for (const r of rows) out.set(r.id, decodeEmbedding(r.embedding, r.embedding_dim));
  return out;
}

// 多通道并发（单通道失败只记日志）→ 融合去重 → decay 混分 → 排序 → appearances+1（best-effort）。
// 融合用 RRF(k=60)；deep 才按查询意图加权，fast / 缺省等权。混分见 finalScore。
export async function searchMemories(
  db: Database.Database,
  opts: SearchOptions
): Promise<MemorySearchHit[]> {
  const q = opts.q.trim();
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  // 过滤参数非法是调用方错误，在空查询短路之前就抛
  const temporal = temporalClause(opts);
  if (!q || opts.spaceIds.length === 0) return [];
  const pool = Math.max(rerankPoolSize(limit), 20);
  const scope = scopeClause(opts.spaceIds, temporal);

  const [ftsIds, vecIds, entityIds] = await Promise.all([
    Promise.resolve()
      .then(() => ftsChannel(db, q, scope, pool))
      .catch(() => [] as string[]),
    // 生产不传 embedder（memoryHost.ts）时向量通道为空，RRF 退化为纯 FTS 排名；
    // 单通道失败/缺失的兜底见 search.test.ts「falls back to …」两例
    opts.embedder
      ? vectorChannel(db, opts.embedder, q, opts.spaceIds, scope, pool).catch(() => [] as string[])
      : Promise.resolve([] as string[]),
    Promise.resolve()
      .then(() => entityChannel(db, q, scope, pool))
      .catch(() => [] as string[]),
  ]);

  const weights = opts.mode === 'deep' ? channelWeights(detectSearchIntent(q)) : undefined;
  const fused = rrf([ftsIds, vecIds, entityIds], RRF_K, weights).slice(0, rerankPoolSize(limit));
  if (fused.length === 0) return [];

  const placeholders = fused.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id IN (${placeholders})`)
    .all(...fused.map(([id]) => id)) as MemoryRow[];
  const byId = new Map(rows.map((r) => [r.id, rowToMemory(r)]));

  const now = opts.now ?? new Date();
  // 时间意图只走正则门；boost 见 computeTemporalBoost
  const intent = detectTemporalIntent(q);
  const semantic = minMaxNormalize(fused.map(([, s]) => s));
  const hits: MemorySearchHit[] = [];
  fused.forEach(([id, rrfScore], i) => {
    const memory = byId.get(id);
    if (!memory) return;
    const decay = computeDecayScore({
      lastAccessedAt: memory.lastAccessedAt,
      accessCount: memory.accessCount,
      importance: memory.importance,
      now,
    });
    const boost = intent ? computeTemporalBoost(memory.eventStart, now, intent) : 0;
    // crystal 是多源合成的结论，同分时应压过任一单源记忆：乘法 boost
    const score = finalScore(semantic[i], decay, boost) * (memory.isCrystal ? CRYSTAL_BOOST : 1);
    hits.push({ memory, rrf: rrfScore, decay, score });
  });
  // 按分数、RRF、updated_at、id 稳定排序；排完再截页
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      b.rrf - a.rrf ||
      (b.memory.updatedAt > a.memory.updatedAt
        ? 1
        : b.memory.updatedAt < a.memory.updatedAt
          ? -1
          : 0) ||
      (a.memory.id < b.memory.id ? -1 : 1)
  );
  if (opts.mmr !== false && hits.length > limit) {
    // 只用当前模型的已存向量（BLOB 已 L2 归一化）；无向量的行不参与惩罚，纯 FTS 时保持原序。
    // 量纲：relevance 是混分后的 finalScore（约 0.3–1.5），惩罚项是余弦（0–1）×(1−λ)，两者不同尺度，
    // 不是严格归一化的 MMR；λ=0.7 是经验值（见 MMR_LAMBDA 注释）
    const vecs = loadVectors(
      db,
      hits.map((h) => h.memory.id),
      opts.embedder?.model ?? null
    );
    const order = mmrRerank(
      hits.map((h) => ({ score: h.score, vec: vecs.get(h.memory.id) ?? null })),
      limit,
      MMR_LAMBDA
    );
    const picked = order.map((i) => hits[i]);
    hits.length = 0;
    hits.push(...picked);
  }
  hits.splice(limit);

  try {
    db.prepare(
      `UPDATE memories SET appearances = appearances + 1 WHERE id IN (${hits.map(() => '?').join(',')})`
    ).run(...hits.map((h) => h.memory.id));
  } catch {
    // best-effort 计数，不参与排序也不影响返回
  }
  return hits;
}
