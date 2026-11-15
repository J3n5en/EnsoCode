import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { hasVec, listVecTables, syncVecTables, VEC_CHUNK_SIZE, vecTableName } from './db';
import { MEMORY_COLUMNS, type MemoryRow, rowToMemory } from './store';
import { type Memory, MemoryValidationError } from './types';

/** memory_maintenance 里维护任务的 kind */
const VEC_KIND = 'vec_compact';
/** 回收空间小于这个量就不折腾 VACUUM（小库重写整个文件的收益抵不上打扰） */
const MIN_RECLAIM_BYTES = 4 * 1024 * 1024;
/** 保留最近几份压缩前备份；更早的自动删掉，否则每次启动都多一份整库副本 */
const KEEP_BACKUPS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MaintenancePhase = 'backup' | 'rebuild' | 'vacuum' | 'done';

export interface VecTablePlan {
  name: string;
  dim: number;
  /** 该维度实际进索引的行数（is_latest = 1 且有向量） */
  rows: number;
  chunks: number;
  /** 现有 chunk 的实际行容量；空表或未建表为 null */
  chunkSize: number | null;
  bytes: number;
  projectedChunks: number;
  projectedBytes: number;
}

export interface VecCompactionPlan {
  chunkSize: number;
  dbBytes: number;
  /** 已分配但未使用的页（VACUUM 能还回去的部分） */
  freeBytes: number;
  vectorBytes: number;
  projectedVectorBytes: number;
  /** 重建 + VACUUM 之后预计能缩小的字节数 */
  reclaimableBytes: number;
  /** 有表的 chunk 布局与当前常量不一致，需要重建 */
  needsRebuild: boolean;
  tables: VecTablePlan[];
  /** dry-run 给用户看的动作清单 */
  actions: string[];
}

export interface VecCompactionResult {
  dryRun: boolean;
  plan: VecCompactionPlan;
  /** 本次从哪个阶段开始（done = 之前已做完，本次什么都没干） */
  resumedFrom: MaintenancePhase;
  phase: MaintenancePhase;
  backupPath: string | null;
  beforeBytes: number;
  afterBytes: number;
  reclaimedBytes: number;
  rebuiltTables: string[];
  vacuumed: boolean;
  error: string | null;
}

function fileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** 表名是内部生成的 memory_vec_<dim>，这里仍按白名单收窄，避免把任意字符串拼进 SQL */
function safeTable(name: string): string {
  if (!/^memory_vec_\d+(_[a-z0-9]+)*$/.test(name)) throw new Error(`unsafe table name: ${name}`);
  return name;
}

/** 单表（含 vec0 影子表）占用的页字节；dbstat 不可用的构建返回 0，只用行数估算 */
function tableBytes(db: Database.Database, table: string): number {
  try {
    const name = safeTable(table);
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name = ? OR name LIKE ? ESCAPE '\\'"
      )
      .get(name, `${name.replace(/_/g, '\\_')}\\_%`) as { bytes: number };
    return row.bytes;
  } catch {
    return 0;
  }
}

function freeBytes(db: Database.Database): number {
  try {
    const pages = db.pragma('freelist_count', { simple: true }) as number;
    const size = db.pragma('page_size', { simple: true }) as number;
    return pages * size;
  } catch {
    return 0;
  }
}

function chunkCount(db: Database.Database, table: string): number {
  try {
    const row = db.prepare(`SELECT count(*) AS n FROM ${safeTable(table)}_chunks`).get() as {
      n: number;
    };
    return row.n;
  } catch {
    return 0;
  }
}

/** 现有 chunk 的行容量；vec0 每个 chunk 的 size 列就是建表时的 chunk_size */
function chunkSizeOf(db: Database.Database, table: string): number | null {
  try {
    const row = db.prepare(`SELECT max(size) AS size FROM ${safeTable(table)}_chunks`).get() as {
      size: number | null;
    };
    return row.size ?? null;
  } catch {
    return null;
  }
}

function indexedRows(db: Database.Database, dim: number): number {
  return (
    db
      .prepare(
        `SELECT count(*) AS n FROM memories
         WHERE embedding IS NOT NULL AND embedding_dim = ? AND is_latest = 1`
      )
      .get(dim) as { n: number }
  ).n;
}

/** 每个 (model, space) 分区各占一个 chunk，分区内按 chunk_size 向上取整 */
function projectedChunks(db: Database.Database, dim: number, chunkSize: number): number {
  const parts = db
    .prepare(
      `SELECT count(*) AS n FROM memories
       WHERE embedding IS NOT NULL AND embedding_dim = ? AND is_latest = 1
       GROUP BY embedding_model, space_id`
    )
    .all(dim) as { n: number }[];
  return parts.reduce((sum, p) => sum + Math.ceil(p.n / chunkSize), 0);
}

export function planVecCompaction(
  db: Database.Database,
  opts: { chunkSize?: number } = {}
): VecCompactionPlan {
  const chunkSize = opts.chunkSize ?? VEC_CHUNK_SIZE;
  const tables: VecTablePlan[] = listVecTables(db).map((t) => {
    const name = vecTableName(t.dim);
    const rows = indexedRows(db, t.dim);
    const current = chunkSizeOf(db, name);
    const projected = projectedChunks(db, t.dim, chunkSize);
    return {
      name,
      dim: t.dim,
      rows,
      chunks: chunkCount(db, name),
      chunkSize: current,
      bytes: tableBytes(db, name),
      projectedChunks: projected,
      projectedBytes: projected * chunkSize * t.dim * 4,
    };
  });
  const vectorBytes = tables.reduce((sum, t) => sum + t.bytes, 0);
  const projectedVectorBytes = tables.reduce((sum, t) => sum + t.projectedBytes, 0);
  const free = freeBytes(db);
  // 重建腾出的页要等 VACUUM；已有空闲页本来就在等 VACUUM
  const shrink = Math.max(0, vectorBytes - projectedVectorBytes);
  const needsRebuild = tables.some((t) => t.chunkSize !== null && t.chunkSize !== chunkSize);
  const reclaimableBytes = shrink + free;
  const actions: string[] = [];
  for (const t of tables) {
    if (t.chunkSize === null || t.chunkSize === chunkSize) continue;
    actions.push(
      `重建 ${t.name}：chunk_size ${t.chunkSize} → ${chunkSize}，${t.rows} 行 / ${t.chunks} chunk → ${t.projectedChunks} chunk`
    );
  }
  if (reclaimableBytes >= MIN_RECLAIM_BYTES) {
    actions.push(
      `VACUUM 回收约 ${(reclaimableBytes / 1024 / 1024).toFixed(1)} MB（向量表 ${(vectorBytes / 1024 / 1024).toFixed(1)} MB → ${(projectedVectorBytes / 1024 / 1024).toFixed(1)} MB，空闲页 ${(free / 1024 / 1024).toFixed(1)} MB）`
    );
  }
  if (actions.length === 0) actions.push('无需处理：向量表已是当前布局，空闲页也不值得回收');
  return {
    chunkSize,
    dbBytes: fileBytes(db.name),
    freeBytes: free,
    vectorBytes,
    projectedVectorBytes,
    reclaimableBytes,
    needsRebuild,
    tables,
    actions,
  };
}

function getPhase(
  db: Database.Database,
  kind: string
): { phase: MaintenancePhase; detail: string | null } | null {
  const row = db.prepare('SELECT phase, detail FROM memory_maintenance WHERE kind = ?').get(kind) as
    | { phase: MaintenancePhase; detail: string | null }
    | undefined;
  return row ?? null;
}

function setPhase(
  db: Database.Database,
  kind: string,
  phase: MaintenancePhase,
  detail?: string | null
): void {
  db.prepare(
    `INSERT INTO memory_maintenance (kind, phase, detail, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET phase = excluded.phase, detail = excluded.detail, updated_at = excluded.updated_at`
  ).run(kind, phase, detail ?? null, new Date().toISOString());
}

function backupPrefix(dbPath: string): string {
  return `${path.basename(dbPath)}.pre-compact-`;
}

/** 只留最近 KEEP_BACKUPS 份，避免每次启动都堆一份整库副本 */
function pruneBackups(dbPath: string): void {
  try {
    const dir = path.dirname(dbPath);
    const prefix = backupPrefix(dbPath);
    const stale = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
      .sort()
      .reverse()
      .slice(KEEP_BACKUPS);
    for (const name of stale) fs.rmSync(path.join(dir, name), { force: true });
  } catch {
    // 清理失败不影响压缩本身
  }
}

/**
 * 备份用 VACUUM INTO：在一个读事务里生成一致快照，不受并发写影响（直接 copyFile 会拷到撕裂的 WAL 页）。
 * 顺带把备份也压实了，用户想回滚直接换文件即可。
 */
function writeBackup(db: Database.Database, dbPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dest = path.join(path.dirname(dbPath), `${backupPrefix(dbPath)}${stamp}.bak`);
  db.prepare('VACUUM INTO ?').run(dest);
  pruneBackups(dbPath);
  return dest;
}

/**
 * 重建向量表：vec0 不能改 chunk_size，只能 DROP + CREATE，再从 memories.embedding 回填。
 * BLOB 是权威副本，所以这一步可重入：事务中途失败整表回滚，下次开库 syncVecTables 也会补齐。
 */
function rebuildVecTables(db: Database.Database): string[] {
  if (!hasVec(db)) return [];
  return db
    .transaction(() => {
      const dropped = listVecTables(db).map((t) => t.name);
      for (const t of listVecTables(db)) db.exec(`DROP TABLE IF EXISTS ${vecTableName(t.dim)}`);
      syncVecTables(db);
      return dropped;
    })
    .immediate();
}

/**
 * 向量表瘦身 + 空间回收。阶段落在 memory_maintenance，进程被杀后下次从断点继续：
 * backup（写备份）→ rebuild（重建 chunk 布局）→ vacuum（把空闲页还给文件系统）→ done。
 * dryRun 只读不写，返回会做什么。
 */
export function runVecCompaction(
  db: Database.Database,
  dbPath: string,
  opts: { dryRun?: boolean; now?: Date } = {}
): VecCompactionResult {
  const plan = planVecCompaction(db);
  const beforeBytes = fileBytes(dbPath);
  const base: VecCompactionResult = {
    dryRun: opts.dryRun === true,
    plan,
    resumedFrom: 'backup',
    phase: 'backup',
    backupPath: null,
    beforeBytes,
    afterBytes: beforeBytes,
    reclaimedBytes: 0,
    rebuiltTables: [],
    vacuumed: false,
    error: null,
  };
  if (opts.dryRun) return base;

  const stored = getPhase(db, VEC_KIND);
  const resumedFrom = stored?.phase ?? 'backup';
  if (resumedFrom === 'done') {
    return { ...base, resumedFrom, phase: 'done' };
  }
  if (resumedFrom === 'backup' && !plan.needsRebuild && plan.reclaimableBytes < MIN_RECLAIM_BYTES) {
    setPhase(db, VEC_KIND, 'done', 'nothing to do');
    return { ...base, resumedFrom, phase: 'done' };
  }

  let phase: MaintenancePhase = resumedFrom;
  let backupPath = resumedFrom === 'backup' ? null : (stored?.detail ?? null);
  const rebuiltTables: string[] = [];
  let vacuumed = false;
  let error: string | null = null;
  try {
    if (phase === 'backup') {
      backupPath = writeBackup(db, dbPath, opts.now ?? new Date());
      setPhase(db, VEC_KIND, 'rebuild', backupPath);
      phase = 'rebuild';
    }
    if (phase === 'rebuild') {
      // 开库时的 v10 迁移已经重建过一次，这里只在布局仍不对时补做，避免白搬一遍向量
      if (plan.needsRebuild) rebuiltTables.push(...rebuildVecTables(db));
      setPhase(db, VEC_KIND, 'vacuum', backupPath);
      phase = 'vacuum';
    }
    if (phase === 'vacuum') {
      // VACUUM 不能在事务里，也不能被别的连接挡着：失败就停在 vacuum 阶段，下次启动重试
      db.exec('VACUUM');
      // WAL 模式下 VACUUM 的新页先落在 -wal 里，主库文件要 checkpoint 之后才真的变小
      // （不 checkpoint 的话磁盘占用一点没还，只是换了个文件）
      db.pragma('wal_checkpoint(TRUNCATE)');
      vacuumed = true;
      setPhase(db, VEC_KIND, 'done', backupPath);
      phase = 'done';
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const afterBytes = fileBytes(dbPath);
  return {
    ...base,
    resumedFrom,
    phase,
    backupPath,
    afterBytes,
    reclaimedBytes: Math.max(0, beforeBytes - afterBytes),
    rebuiltTables,
    vacuumed,
    error,
  };
}

/** 「N 天前」的 ISO 下界；维护筛选与设置页列表共用同一口径 */
export function staleCutoffIso(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

export interface StaleMemoryQuery {
  /** 超过这么多天没被检索命中就算待维护 */
  olderThanDays: number;
  spaceIds?: string[];
  limit?: number;
  offset?: number;
  now?: Date;
}

/**
 * 维护筛选：COALESCE(last_hit_at, created_at) 早于 cutoff 的活跃记忆。从未命中的行按创建时间算，
 * 所以刚写入的记忆不会立刻被判成待维护。只读，不改任何状态。
 */
export function listStaleMemories(
  db: Database.Database,
  query: StaleMemoryQuery
): { items: Memory[]; total: number } {
  const days = query.olderThanDays;
  if (!Number.isFinite(days) || days < 0) {
    throw new MemoryValidationError('invalid_days', 'olderThanDays must be a non-negative number');
  }
  const cutoff = staleCutoffIso(days, query.now ?? new Date());
  const conditions = [
    "m.lifecycle_state = 'active'",
    'm.is_latest = 1',
    'COALESCE(m.last_hit_at, m.created_at) < ?',
  ];
  const params: unknown[] = [cutoff];
  if (query.spaceIds !== undefined) {
    if (query.spaceIds.length === 0) return { items: [], total: 0 };
    conditions.push(`m.space_id IN (${query.spaceIds.map(() => '?').join(',')})`);
    params.push(...query.spaceIds);
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
        .map((c) => `m.${c}`)
        .join(', ')} FROM memories m WHERE ${where}
       ORDER BY COALESCE(m.last_hit_at, m.created_at) ASC, m.id ASC LIMIT ? OFFSET ?`
    )
    .all(...params, query.limit ?? 50, query.offset ?? 0) as MemoryRow[];
  return { items: rows.map(rowToMemory), total };
}

/** 设置页只读统计：从未被检索命中的条数、最近 7 天新增条数 */
export function getHitStats(
  db: Database.Database,
  now: Date = new Date()
): { neverHit: number; addedLast7Days: number } {
  const cutoff = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const row = db
    .prepare(
      `SELECT sum(CASE WHEN hit_count = 0 THEN 1 ELSE 0 END) AS neverHit,
              sum(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS addedLast7Days
       FROM memories WHERE lifecycle_state != 'deleted'`
    )
    .get(cutoff) as { neverHit: number | null; addedLast7Days: number | null };
  return { neverHit: row.neverHit ?? 0, addedLast7Days: row.addedLast7Days ?? 0 };
}
