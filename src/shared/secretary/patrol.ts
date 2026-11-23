import type { PatrolReason, SecretaryResultKind } from '../types/secretary';

/** 空闲、目标没完成、没有任何待处理项，超过这么久没活动就算卡住（有后台任务时的兜底） */
export const PATROL_IDLE_MS = 20 * 60 * 1000;
/** 运行中超过这么久没有任何事件就算卡住 */
export const PATROL_RUNNING_MS = 30 * 60 * 1000;
/** goal 会话空闲、没有后台任务、最后一条不是完成汇报，超过这么久没活动就算停住 */
export const PATROL_IDLE_GOAL_MS = 3 * 60 * 1000;
/** 巡检间隔：停住阈值更短时按阈值走 */
export const PATROL_INTERVAL_MS = 15 * 60 * 1000;

export interface PatrolFacts {
  conversationId: string;
  /** queued 是排队会话：还没开始，不算停住 */
  state: 'running' | 'idle' | 'waiting' | 'error' | 'not-started' | 'queued';
  goalStatus?: string;
  /** 待用户回答的提问与审批条数：有待处理项就不是异常 */
  pending: number;
  backgroundRunning?: boolean;
  lastEventAt: number;
  turn: number;
  /** 这一轮已经报过的巡检异常 */
  patrol?: { reason: PatrolReason; turn: number; at?: number };
  /** 现有停滞检测已经报过这一轮：不重复推 */
  stallReported: boolean;
  /** 最近一次结果 */
  result?: SecretaryResultKind;
  /** 最后一条消息：已经是完成汇报就不用再催 */
  lastText?: string;
  /**
   * 秘书最近一次发消息后还没有可见回复：超过空闲阈值就算停住。
   * 只对发过消息的会话有值；等用户、等审批、有后台任务的上游已排除。
   */
  awaitingReplySince?: number;
  /** 挂着没到点（或到点不足 2 分钟）的自定提醒：会话在等自己定的时间点，不是卡住 */
  reminderPending?: boolean;
  /** 会话因上游瞬态/配额故障在等待自动退避恢复：不是卡住 */
  upstreamWaiting?: boolean;
  /** 名下有未结束的子代理 Run：结束时会自动通知唤醒父会话，不当成空闲停住 */
  subagentsRunning?: boolean;
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

/** 空闲类异常：3 分钟规则与 20 分钟兜底说同一件事，共用一条「已报过」记录 */
const IDLE_REASONS: ReadonlySet<PatrolReason> = new Set(['idle-stalled', 'goal-idle-stalled']);
const RUNNING_REASONS: ReadonlySet<PatrolReason> = new Set(['running-stalled']);

function reported(facts: PatrolFacts, reasons: ReadonlySet<PatrolReason>): boolean {
  if (facts.patrol?.turn !== facts.turn) return false;
  if (!reasons.has(facts.patrol.reason)) return false;
  // 记录里带了时间：会话在那之后又动过，就算恢复
  return facts.patrol.at === undefined || facts.lastEventAt <= facts.patrol.at;
}

// 完成词后面要跟标点或结束：「完成度 60%」不算汇报
const COMPLETION_ZH_RE =
  /^(?:✅\s*)?(?:全部|都|已经|已)?(?:完成|做完|搞定|提交|合并|发布|上线|收工|结束)(?:了|啦|！|!|：|:|，|,|。|\.|\s|$)/u;
const COMPLETION_EN_RE = /^(?:all\s+)?(?:done|completed|finished|shipped|merged)\b/iu;
/** 说的是「还没做完」：不算完成汇报 */
const NOT_YET_RE = /(?:还没|尚未|没有|未完成|没完成|not\s+yet|isn't|is not)/iu;

/**
 * 最后一条消息是不是完成汇报。只看最后一行、只看开头：
 * 汇报通常以「已完成 / 已提交 / done」起头，正文里提到完成不算。
 */
export function looksLikeCompletionReport(text: string | undefined): boolean {
  if (!text) return false;
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return false;
  const line = last.replace(/^[\s>*#\-–—•·\d.、)）]+/u, '').trim();
  if (!line || NOT_YET_RE.test(line)) return false;
  return COMPLETION_ZH_RE.test(line) || COMPLETION_EN_RE.test(line);
}

/**
 * 自动巡检的异常判定。只报两种：空闲卡住与运行卡住。
 * goal 会话空闲且没有后台任务时按停住阈值（3 分钟）就报，其余空闲情况按 20 分钟兜底。
 * 同一会话同一次停住只报一次；现有停滞检测已经报过的轮次不再报，避免两条推送说同一件事。
 */
export function patrolAnomalies(facts: readonly PatrolFacts[], now: number): PatrolAnomaly[] {
  const out: PatrolAnomaly[] = [];
  for (const entry of facts) {
    if (entry.state === 'running') {
      if (entry.stallReported) continue;
      if (now - entry.lastEventAt < PATROL_RUNNING_MS) continue;
      if (reported(entry, RUNNING_REASONS)) continue;
      out.push({ conversationId: entry.conversationId, reason: 'running-stalled' });
      continue;
    }
    if (entry.state !== 'idle') continue;
    if (entry.pending > 0) continue;
    if (entry.reminderPending) continue;
    if (entry.upstreamWaiting) continue;
    if (entry.subagentsRunning) continue;
    // 秘书发过消息、之后没有任何可见回复：与 goal 空闲停住共用同一个空闲阈值
    if (
      entry.awaitingReplySince !== undefined &&
      now - entry.awaitingReplySince >= PATROL_IDLE_GOAL_MS &&
      !reported(entry, IDLE_REASONS)
    ) {
      out.push({ conversationId: entry.conversationId, reason: 'goal-idle-stalled' });
      continue;
    }
    if (!entry.goalStatus || !LIVE_GOALS.has(entry.goalStatus)) continue;
    if (entry.result !== undefined && SETTLED.has(entry.result)) continue;
    // goal 会话空闲只有两种正常情况：在等后台任务，或者已经收口。
    // 既没有后台任务、最后一条又不是完成汇报，就是停住了——不必等 20 分钟。
    if (entry.backgroundRunning !== true && !looksLikeCompletionReport(entry.lastText)) {
      if (now - entry.lastEventAt >= PATROL_IDLE_GOAL_MS) {
        if (!reported(entry, IDLE_REASONS))
          out.push({ conversationId: entry.conversationId, reason: 'goal-idle-stalled' });
        continue;
      }
    }
    if (now - entry.lastEventAt < PATROL_IDLE_MS) continue;
    if (reported(entry, IDLE_REASONS)) continue;
    out.push({ conversationId: entry.conversationId, reason: 'idle-stalled' });
  }
  return out;
}

/** 最后一条消息的摘要：推送里只放前 100 字 */
const SUMMARY_MAX_CHARS = 100;

function excerpt(text: string | undefined): string | undefined {
  const flat = text?.replace(/\s+/gu, ' ').trim();
  if (!flat) return undefined;
  return flat.length > SUMMARY_MAX_CHARS ? `${flat.slice(0, SUMMARY_MAX_CHARS)}…` : flat;
}

/**
 * 巡检推送的正文：停了多久、goal 状态、有没有后台任务、最后一条说了什么。
 * 会话标题与项目由回传正文的前缀带上，这里不重复。
 */
export function patrolStallDetail(input: {
  reason: PatrolReason;
  /** 距离最后一次活动多少分钟 */
  idleMinutes: number;
  goalStatus?: string;
  backgroundRunning?: boolean;
  lastText?: string;
  /** 发了消息后一直没有可见回复：文案说「没有任何回复」而不是「目标没完成」 */
  awaitingReply?: boolean;
}): string {
  const minutes = Math.max(1, Math.round(input.idleMinutes));
  const head =
    input.reason === 'goal-idle-stalled'
      ? input.awaitingReply
        ? `自动巡检：发了消息后 ${minutes} 分钟没有任何回复`
        : `自动巡检：目标还没完成，会话却已空闲 ${minutes} 分钟`
      : input.reason === 'idle-stalled'
        ? `自动巡检：空闲超过 ${minutes} 分钟，目标还没完成，也没有待处理项`
        : `自动巡检：运行超过 ${minutes} 分钟没有任何事件`;
  const tail = [
    input.goalStatus ? `目标 ${input.goalStatus}` : undefined,
    input.backgroundRunning === undefined
      ? undefined
      : input.backgroundRunning
        ? '有后台任务'
        : '没有后台任务',
    excerpt(input.lastText) ? `最后一条：${excerpt(input.lastText)}` : undefined,
  ].filter(Boolean);
  return [head, ...tail].join(' · ');
}
