import type { PatrolReason, SecretaryResultKind } from '../types/secretary';

/** 空闲、目标没完成、没有任何待处理项，超过这么久没活动就算卡住 */
export const PATROL_IDLE_MS = 20 * 60 * 1000;
/** 运行中超过这么久没有任何事件就算卡住 */
export const PATROL_RUNNING_MS = 30 * 60 * 1000;

export interface PatrolFacts {
  conversationId: string;
  state: 'running' | 'idle' | 'waiting' | 'error' | 'not-started';
  goalStatus?: string;
  /** 待用户回答的提问与审批条数：有待处理项就不是异常 */
  pending: number;
  backgroundRunning?: boolean;
  lastEventAt: number;
  turn: number;
  /** 这一轮已经报过的巡检异常 */
  patrol?: { reason: PatrolReason; turn: number };
  /** 现有停滞检测已经报过这一轮：不重复推 */
  stallReported: boolean;
  /** 最近一次结果 */
  result?: SecretaryResultKind;
}

export interface PatrolAnomaly {
  conversationId: string;
  reason: PatrolReason;
}

const SETTLED: ReadonlySet<SecretaryResultKind> = new Set([
  'goal-complete',
  'failed',
  'interrupted',
]);

// 目标还活着但会话空闲：续跑没接上、看门狗没叫醒，才是真异常。
// paused / blocked / completed 都是有意停下的，不报。
const LIVE_GOALS: ReadonlySet<string> = new Set(['active', 'waiting']);

function reported(facts: PatrolFacts, reason: PatrolReason): boolean {
  return facts.patrol?.reason === reason && facts.patrol.turn === facts.turn;
}

/**
 * 自动巡检的异常判定。只报两种：空闲卡住与运行卡住。
 * 同一会话同一原因一轮只报一次；现有停滞检测已经报过的轮次不再报，避免两条推送说同一件事。
 */
export function patrolAnomalies(facts: readonly PatrolFacts[], now: number): PatrolAnomaly[] {
  const out: PatrolAnomaly[] = [];
  for (const entry of facts) {
    if (entry.state === 'running') {
      if (entry.stallReported) continue;
      if (now - entry.lastEventAt < PATROL_RUNNING_MS) continue;
      if (reported(entry, 'running-stalled')) continue;
      out.push({ conversationId: entry.conversationId, reason: 'running-stalled' });
      continue;
    }
    if (entry.state !== 'idle') continue;
    if (entry.pending > 0 || entry.backgroundRunning === true) continue;
    if (!entry.goalStatus || !LIVE_GOALS.has(entry.goalStatus)) continue;
    if (entry.result !== undefined && SETTLED.has(entry.result)) continue;
    if (now - entry.lastEventAt < PATROL_IDLE_MS) continue;
    if (reported(entry, 'idle-stalled')) continue;
    out.push({ conversationId: entry.conversationId, reason: 'idle-stalled' });
  }
  return out;
}

/** 巡检间隔：档案里的分钟数，缺省 15 分钟 */
export function patrolIntervalMs(minutes: number | undefined): number {
  const value = typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : 15;
  return Math.min(120, Math.max(5, Math.round(value))) * 60 * 1000;
}
