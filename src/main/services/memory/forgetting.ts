import { computeDecayScore } from '@shared/memory/decay';
import type { ForgettingSettings } from '@shared/memory/forgetting';
import type Database from 'better-sqlite3';
import type { MemoryAuditEntry } from './audit';
import { MEMORY_COLUMNS, type MemoryRow, rowToMemory, updateMemory } from './store';
import type { Memory } from './types';

/**
 * 遗忘巡检。三件事按顺序做，全部只读或可逆：
 *   1. 给活跃记忆写真实衰减分（decay_score_cached，此前恒为 1.0，从没被写过）；
 *   2. 标记「归档候选」——冷（超 staleDays 没被检索命中）+ 不重要（importance <= maxImportance）；
 *   3. 只在显式打开 autoArchive 时把候选归档（lifecycle_state → archived）。
 * 本模块永不删除行：删除只能走设置页的删除确认（manual.ts）。
 */

const DECAY_KIND = 'decay';
const SCORE_BATCH = 500;
const DAY_MS = 86_400_000;

export interface ForgettingRunSummary {
  ranAt: string;
  scored: number;
  candidates: number;
  archived: number;
  staleDays: number;
  maxImportance: number;
  autoArchive: boolean;
  durationMs: number;
}

export interface ForgettingState {
  lastRunAt: string | null;
  lastRun: ForgettingRunSummary | null;
  /** 当前候选条数（实时统计，不是上次运行的快照） */
  candidates: number;
}

export interface ForgettingRunOptions {
  now?: Date;
  /** 审计出口；调用方注入（服务层不认识 userData 目录） */
  audit?: (entry: MemoryAuditEntry) => void;
}

/**
 * 候选条件。标记 / 计数 / 列表 / 确认归档四处共用同一段 SQL，避免「界面显示的候选」和
 * 「真正会被归档的」两套规则漂移。保护规则写在这里而不是调用方：
 *   - crystal 是合成结论，丢了不可重建；
 *   - 被 evolves 版本链引用的行是别的行历史的一部分；
 *   - 作为 crystal 来源的行被 crystallized_from 引用；
 *   - 已归档 / 非最新版本不参与（前者已处理过，后者不该占候选名额）。
 * 表名写全 `memories.`，同一段 SQL 才能直接用在 UPDATE 里。
 */
function candidateWhere(
  settings: Pick<ForgettingSettings, 'staleDays' | 'maxImportance'>,
  now: Date
): { where: string; params: unknown[] } {
  const cutoff = new Date(now.getTime() - settings.staleDays * DAY_MS).toISOString();
  return {
    where: `lifecycle_state = 'active' AND is_latest = 1 AND is_crystal = 0
      AND importance <= ? AND COALESCE(last_hit_at, created_at) < ?
      AND NOT EXISTS (SELECT 1 FROM evolves e WHERE e.older_id = memories.id OR e.newer_id = memories.id)
      AND NOT EXISTS (SELECT 1 FROM crystallized_from c WHERE c.source_id = memories.id)`,
    params: [settings.maxImportance, cutoff],
  };
}

/** 逐批写衰减分；行数上限由库大小决定，单批一个短事务，不长时间占写锁 */
function scoreActiveMemories(db: Database.Database, now: Date): number {
  const pick = db.prepare(
    `SELECT rowid, importance, last_hit_at, created_at, hit_count FROM memories
     WHERE lifecycle_state = 'active' AND is_latest = 1 AND rowid > ?
     ORDER BY rowid LIMIT ?`
  );
  const set = db.prepare('UPDATE memories SET decay_score_cached = ? WHERE rowid = ?');
  let cursor = 0;
  let scored = 0;
  for (;;) {
    const rows = pick.all(cursor, SCORE_BATCH) as {
      rowid: number;
      importance: number;
      last_hit_at: string | null;
      created_at: string;
      hit_count: number;
    }[];
    if (rows.length === 0) return scored;
    db.transaction(() => {
      for (const row of rows) {
        const score = computeDecayScore({
          lastHitAt: row.last_hit_at ?? row.created_at,
          hitCount: row.hit_count,
          importance: row.importance,
          now,
        });
        set.run(score, row.rowid);
      }
    }).immediate();
    scored += rows.length;
    cursor = rows[rows.length - 1].rowid;
  }
}

/**
 * 标记候选：先把不再满足条件的清掉（记忆又被检索到、重要度被调高、已归档），再补新命中的。
 * 只写 archive_candidate_at 一列，不动 lifecycle_state。
 */
function markCandidates(
  db: Database.Database,
  settings: Pick<ForgettingSettings, 'staleDays' | 'maxImportance'>,
  now: Date
): number {
  const { where, params } = candidateWhere(settings, now);
  db.transaction(() => {
    db.prepare(
      `UPDATE memories SET archive_candidate_at = NULL
       WHERE archive_candidate_at IS NOT NULL AND NOT (${where})`
    ).run(...params);
    db.prepare(
      `UPDATE memories SET archive_candidate_at = ?
       WHERE archive_candidate_at IS NULL AND (${where})`
    ).run(now.toISOString(), ...params);
  }).immediate();
  return (
    db
      .prepare('SELECT count(*) AS n FROM memories WHERE archive_candidate_at IS NOT NULL')
      .get() as {
      n: number;
    }
  ).n;
}

function archiveRows(db: Database.Database, ids: readonly string[]): number {
  let archived = 0;
  db.transaction(() => {
    for (const id of ids) {
      if (!updateMemory(db, id, { lifecycleState: 'archived' })) continue;
      db.prepare('UPDATE memories SET archive_candidate_at = NULL WHERE id = ?').run(id);
      archived += 1;
    }
  }).immediate();
  return archived;
}

/** 设置页「立即运行」与开库巡检共用；返回本次做了什么，调用方负责落审计 */
export function runForgettingPass(
  db: Database.Database,
  settings: ForgettingSettings,
  opts: ForgettingRunOptions = {}
): ForgettingRunSummary {
  const now = opts.now ?? new Date();
  const startedAt = Date.now();
  const summary: ForgettingRunSummary = {
    ranAt: now.toISOString(),
    scored: 0,
    candidates: 0,
    archived: 0,
    staleDays: settings.staleDays,
    maxImportance: settings.maxImportance,
    autoArchive: settings.autoArchive,
    durationMs: 0,
  };
  if (!settings.enabled) return { ...summary, durationMs: Date.now() - startedAt };

  summary.scored = scoreActiveMemories(db, now);
  if (settings.archiveCandidates || settings.autoArchive) {
    summary.candidates = markCandidates(db, settings, now);
    if (settings.autoArchive && summary.candidates > 0) {
      const ids = (
        db
          .prepare('SELECT id FROM memories WHERE archive_candidate_at IS NOT NULL ORDER BY id')
          .all() as { id: string }[]
      ).map((row) => row.id);
      summary.archived = archiveRows(db, ids);
      if (summary.archived > 0) {
        opts.audit?.({
          ts: now.toISOString(),
          action: 'memory.archive',
          actor: 'system',
          ids,
          reason: 'auto',
        });
      }
    }
  } else {
    // 标记关掉后旧标记要一起撤掉：否则界面说「未开启标记」，列表里还挂着「建议归档」
    db.exec(
      'UPDATE memories SET archive_candidate_at = NULL WHERE archive_candidate_at IS NOT NULL'
    );
  }
  summary.durationMs = Date.now() - startedAt;
  setLastRun(db, summary);
  opts.audit?.({
    ts: now.toISOString(),
    action: 'memory.decay',
    actor: 'system',
    summary,
  });
  return summary;
}

function setLastRun(db: Database.Database, summary: ForgettingRunSummary): void {
  db.prepare(
    `INSERT INTO memory_maintenance (kind, phase, detail, updated_at) VALUES (?, 'done', ?, ?)
     ON CONFLICT(kind) DO UPDATE SET phase = excluded.phase, detail = excluded.detail, updated_at = excluded.updated_at`
  ).run(DECAY_KIND, JSON.stringify(summary), summary.ranAt);
}

/** 上次运行时间；开库巡检据此判断是否到期（不另起定时器） */
export function lastForgettingRunAt(db: Database.Database): string | null {
  const row = db
    .prepare('SELECT updated_at AS updatedAt FROM memory_maintenance WHERE kind = ?')
    .get(DECAY_KIND) as { updatedAt: string } | undefined;
  return row?.updatedAt ?? null;
}

export function getForgettingState(
  db: Database.Database,
  settings: ForgettingSettings,
  now: Date = new Date()
): ForgettingState {
  const row = db
    .prepare('SELECT detail, updated_at AS updatedAt FROM memory_maintenance WHERE kind = ?')
    .get(DECAY_KIND) as { detail: string | null; updatedAt: string } | undefined;
  let lastRun: ForgettingRunSummary | null = null;
  if (row?.detail) {
    try {
      lastRun = JSON.parse(row.detail) as ForgettingRunSummary;
    } catch {
      lastRun = null;
    }
  }
  const { where, params } = candidateWhere(settings, now);
  const candidates = (
    db.prepare(`SELECT count(*) AS n FROM memories WHERE ${where}`).get(...params) as { n: number }
  ).n;
  return { lastRunAt: row?.updatedAt ?? null, lastRun, candidates };
}

/** 设置页候选列表；与标记共用同一段 SQL，所以「看到的就是会被归档的」 */
export function listArchiveCandidates(
  db: Database.Database,
  settings: ForgettingSettings,
  opts: { limit?: number; offset?: number; now?: Date } = {}
): { items: Memory[]; total: number } {
  const { where, params } = candidateWhere(settings, opts.now ?? new Date());
  const total = (
    db.prepare(`SELECT count(*) AS n FROM memories WHERE ${where}`).get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE ${where}
       ORDER BY COALESCE(last_hit_at, created_at) ASC, id ASC LIMIT ? OFFSET ?`
    )
    .all(...params, opts.limit ?? 50, opts.offset ?? 0) as MemoryRow[];
  return { items: rows.map(rowToMemory), total };
}

/**
 * 用户确认后的批量归档。渲染层回传的 id 只当「想归档这些」，真正归档前按同一条件重算，
 * 期间被检索到或重要度被调高的行会被跳过（与删除确认「不信任回传计划」同一口径）。
 */
export function archiveCandidatesConfirmed(
  db: Database.Database,
  settings: ForgettingSettings,
  ids: readonly string[],
  opts: ForgettingRunOptions = {}
): { archived: number; skipped: number; ids: string[] } {
  const now = opts.now ?? new Date();
  const { where, params } = candidateWhere(settings, now);
  const eligible = ids.length
    ? (
        db
          .prepare(
            `SELECT id FROM memories WHERE id IN (${ids.map(() => '?').join(',')}) AND (${where})`
          )
          .all(...ids, ...params) as { id: string }[]
      ).map((row) => row.id)
    : [];
  if (eligible.length === 0) return { archived: 0, skipped: ids.length, ids: [] };
  const archived = archiveRows(db, eligible);
  opts.audit?.({
    ts: now.toISOString(),
    action: 'memory.archive',
    actor: 'user',
    ids: eligible,
    reason: 'candidates',
  });
  return { archived, skipped: ids.length - archived, ids: eligible };
}
