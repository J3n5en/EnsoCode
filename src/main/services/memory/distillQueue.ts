import { createHash } from 'node:crypto';
import { DISTILL_BATCH_MAX_CHARS } from '@shared/memory/constants';
import type Database from 'better-sqlite3';
import {
  BATCH_SESSION_HEADER,
  type DistillBatchMember,
  type DistillPayload,
  distillFingerprint,
} from './distill';
import { distillSpaceId } from './space';

/**
 * 会话聚合提炼的延迟队列：会话结束时把已切好区间的待办落 memory_jobs(kind='distill-queue')，
 * 到期后同一 space + 语言的待办合并成一个蒸馏任务。纯逻辑层，时间与读取都由调用方给。
 */

const KIND = 'distill-queue';

export interface DistillQueueItem {
  id: number;
  /** 排队时已盖章 language / toEntryId */
  payload: DistillPayload;
  dueAt: string;
  createdAt: string;
}

interface QueueRow {
  id: number;
  payload: string | null;
  due_at: string | null;
  created_at: string;
}

function toItem(r: QueueRow): DistillQueueItem | null {
  try {
    const payload = JSON.parse(r.payload ?? '') as DistillPayload | null;
    if (typeof payload?.sessionId !== 'string' || typeof payload.sessionFile !== 'string') {
      return null;
    }
    return { id: r.id, payload, dueAt: r.due_at ?? r.created_at, createdAt: r.created_at };
  } catch {
    return null;
  }
}

/** 落一条待办；target 用蒸馏指纹，同会话同内容已排过（不论是否已提炼）返回 false */
export function enqueueDistill(
  db: Database.Database,
  payload: DistillPayload,
  fingerprint: string,
  dueAt: Date,
  now: Date = new Date()
): boolean {
  return db
    .transaction((): boolean => {
      if (
        db
          .prepare('SELECT 1 FROM memory_jobs WHERE kind = ? AND target = ? LIMIT 1')
          .get(KIND, fingerprint)
      ) {
        return false;
      }
      const created = now.toISOString();
      db.prepare(
        `INSERT INTO memory_jobs (kind, target, payload, status, cursor, total, done, failed, created_at, updated_at, due_at)
         VALUES (?, ?, ?, 'pending', 0, 0, 0, 0, ?, ?, ?)`
      ).run(KIND, fingerprint, JSON.stringify(payload), created, created, dueAt.toISOString());
      return true;
    })
    .immediate();
}

function pendingItems(db: Database.Database): DistillQueueItem[] {
  const rows = db
    .prepare(`SELECT * FROM memory_jobs WHERE kind = ? AND status = 'pending' ORDER BY id ASC`)
    .all(KIND) as QueueRow[];
  const items: DistillQueueItem[] = [];
  const broken: number[] = [];
  for (const row of rows) {
    const item = toItem(row);
    if (item) items.push(item);
    else broken.push(row.id);
  }
  // 坏行永远出不了队，留着会让定时器反复以为有到期待办
  if (broken.length) claimDistillQueue(db, broken, 'cancelled');
  return items;
}

export function nextDistillDueAt(db: Database.Database): string | null {
  const items = pendingItems(db);
  return items.length
    ? items.reduce((min, item) => (item.dueAt < min ? item.dueAt : min), items[0].dueAt)
    : null;
}

/** 合并口径：同一落库 space、同一记忆语言（语言进指纹，不同语言不能共用一个任务） */
function groupKey(payload: DistillPayload): string {
  return `${distillSpaceId({ projectId: payload.projectId })}\u0000${payload.language ?? ''}`;
}

/** 到期的组：组内最早一条到期就整组出队（含后来加入、尚未到期的），窗口从组内第一个会话算起 */
export function dueDistillGroups(db: Database.Database, now: Date): DistillQueueItem[][] {
  const groups = new Map<string, DistillQueueItem[]>();
  for (const item of pendingItems(db)) {
    const key = groupKey(item.payload);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const cutoff = now.toISOString();
  return [...groups.values()].filter((items) => items.some((item) => item.dueAt <= cutoff));
}

/**
 * 原子认领：ids 全部仍是 pending 才改成 status 并在同一事务里跑 onClaim（建蒸馏任务）；
 * 任何一条已被别人认领就整体放弃。onClaim 抛错时认领一起回滚。
 */
export function claimDistillQueue<T>(
  db: Database.Database,
  ids: readonly number[],
  status: 'done' | 'cancelled',
  onClaim?: () => T
): { claimed: false } | { claimed: true; value: T | undefined } {
  if (ids.length === 0) return { claimed: false };
  const marks = ids.map(() => '?').join(',');
  return db
    .transaction(() => {
      const { n } = db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory_jobs WHERE kind = ? AND status = 'pending' AND id IN (${marks})`
        )
        .get(KIND, ...ids) as { n: number };
      if (n !== ids.length) return { claimed: false as const };
      db.prepare(`UPDATE memory_jobs SET status = ?, updated_at = ? WHERE id IN (${marks})`).run(
        status,
        new Date().toISOString(),
        ...ids
      );
      return { claimed: true as const, value: onClaim?.() };
    })
    .immediate();
}

export interface DistillUnit {
  member: DistillBatchMember;
  transcript: string;
}

/** 同会话的多条待办（压缩触发 + 结束触发）合成一个区间：首条起点到末条终点 */
export function distillUnits(
  items: readonly DistillQueueItem[]
): { member: DistillBatchMember; ids: number[] }[] {
  const bySession = new Map<string, DistillQueueItem[]>();
  for (const item of items) {
    bySession.set(item.payload.sessionId, [...(bySession.get(item.payload.sessionId) ?? []), item]);
  }
  return [...bySession.values()].map((rows) => {
    const first = rows[0].payload;
    const last = rows[rows.length - 1];
    return {
      member: {
        sessionId: first.sessionId,
        sessionFile: last.payload.sessionFile,
        ...(first.fromEntryId !== undefined ? { fromEntryId: first.fromEntryId } : {}),
        ...(last.payload.toEntryId !== undefined ? { toEntryId: last.payload.toEntryId } : {}),
        endedAt: last.createdAt,
      },
      ids: rows.map((row) => row.id),
    };
  });
}

const byEndedAt = (a: DistillUnit, b: DistillUnit) =>
  a.member.endedAt.localeCompare(b.member.endedAt) ||
  a.member.sessionId.localeCompare(b.member.sessionId) ||
  (a.member.fromEntryId ?? '').localeCompare(b.member.fromEntryId ?? '');

const minute = (iso: string) =>
  /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(iso) ? `${iso.slice(0, 16)}Z` : iso;

/**
 * 多会话拼接：按结束时间排序，每段前加 `## Session i/n · <id> · <time>`。
 * 分隔头与该会话首条消息之间只用单换行，分块（chunkTranscript）只会在分隔头之前断开。
 * 顺序只取决于持久化字段，同一批待办无论以什么顺序读出都得到同一份文本（指纹稳定）。
 */
export function buildBatchTranscript(units: readonly DistillUnit[]): string {
  const sorted = [...units].sort(byEndedAt);
  return sorted
    .map(
      (unit, i) =>
        `${BATCH_SESSION_HEADER}${i + 1}/${sorted.length} · ${unit.member.sessionId} · ${minute(unit.member.endedAt)}\n${unit.transcript}`
    )
    .join('\n\n');
}

export interface DistillPlan {
  payload: DistillPayload;
  transcript: string;
  fingerprint: string;
  /** 这一批对应的待办行 */
  ids: number[];
}

/**
 * 一组到期会话 → 若干蒸馏任务。按结束时间贪心装批，单批不超过 maxChars；超出的会话进下一批（不截断）。
 * 单个会话的批退化为普通任务：payload / 指纹与立即提炼完全一致，不造聚合结构。
 */
export function planDistillBatches(
  units: readonly (DistillUnit & { ids: number[] })[],
  base: { projectId: string | null; language?: string },
  maxChars: number = DISTILL_BATCH_MAX_CHARS
): DistillPlan[] {
  const packs: (DistillUnit & { ids: number[] })[][] = [];
  let current: (DistillUnit & { ids: number[] })[] = [];
  let size = 0;
  for (const unit of [...units].filter((u) => u.transcript).sort(byEndedAt)) {
    if (current.length && size + unit.transcript.length > maxChars) {
      packs.push(current);
      current = [];
      size = 0;
    }
    current.push(unit);
    size += unit.transcript.length;
  }
  if (current.length) packs.push(current);

  const language = base.language !== undefined ? { language: base.language } : {};
  return packs.map((pack) => {
    const ids = pack.flatMap((unit) => unit.ids);
    if (pack.length === 1) {
      const { member, transcript } = pack[0];
      const payload: DistillPayload = {
        sessionId: member.sessionId,
        sessionFile: member.sessionFile,
        projectId: base.projectId,
        ...language,
        ...(member.fromEntryId !== undefined ? { fromEntryId: member.fromEntryId } : {}),
        ...(member.toEntryId !== undefined ? { toEntryId: member.toEntryId } : {}),
      };
      return { payload, transcript, ids, fingerprint: fingerprintOf(payload, transcript) };
    }
    const sessions = pack.map((unit) => unit.member);
    const key = sessions
      .map((m) => `${m.sessionId}\u0000${m.fromEntryId ?? ''}\u0000${m.toEntryId ?? ''}`)
      .sort()
      .join('\n');
    const payload: DistillPayload = {
      sessionId: `batch:${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}`,
      sessionFile: '',
      projectId: base.projectId,
      ...language,
      sessions,
    };
    const transcript = buildBatchTranscript(pack);
    return { payload, transcript, ids, fingerprint: fingerprintOf(payload, transcript) };
  });
}

const fingerprintOf = (payload: DistillPayload, transcript: string) =>
  distillFingerprint(payload.sessionId, transcript, payload.language);
