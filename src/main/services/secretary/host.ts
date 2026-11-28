import { BACKGROUND_STALL_DETAIL, type BackgroundStall } from '@shared/backgroundWatch';
import { interruptReason } from '@shared/exitInterrupt';
import type { SessionStatusPayload } from '@shared/extensionPlugins/events';
import { hasPendingReminder, type SessionReminder } from '@shared/reminders';
import { shouldForwardMilestone } from '@shared/secretary/contact';
import { extractReportRefs } from '@shared/secretary/daily';
import {
  type GoalResult,
  type GoalResultCheck,
  type GoalResultView,
  hasNeedsUser,
  needsUserItems,
  needsUserTriageDeadline,
  parseGoalResultView,
} from '@shared/secretary/goalResult';
import {
  PATROL_IDLE_GOAL_MS,
  PATROL_INTERVAL_MS,
  type PatrolFacts,
  patrolAnomalies,
  patrolStallDetail,
} from '@shared/secretary/patrol';
import { transitionProposal } from '@shared/secretary/policy';
import { queuedStartOf } from '@shared/secretary/queuedSession';
import {
  isPureSessionUpdate,
  messageText,
  sessionIdsInUpdates,
  shouldSilenceTurn,
} from '@shared/secretary/silence';
import {
  type AskRelatesTo,
  type RendererAgentEvent,
  STALE_SESSION_ERROR,
  type TurnReport,
} from '@shared/types/agent';
import type {
  DispatchRecord,
  SecretaryActivity,
  SecretaryAuditEntry,
  SecretaryDailyRecord,
  SecretaryDispatchFile,
  SecretaryProfile,
  SecretaryResultKind,
  SecretarySchedule,
  SecretaryTodo,
  SecretaryUpdate,
} from '@shared/types/secretary';
import { formatRetryClock, type GoalUpstreamRetry } from '@shared/upstreamRecovery';
import type { ObservedTask } from '../backgroundTaskTracker';
import { redactSecrets } from '../memory/distill';
import { autoArchived, liveTasks } from './autoArchive';
import type { SecretaryContactPort } from './contact/service';
import {
  type DeliveryOutcome,
  type DeliveryPorts,
  flushDeliveries,
  recoverDeliveries,
  settleDelivery,
} from './deliveries';
import { unverifiableGoalChecks } from './goalResultVerify';
import {
  leftoverNote,
  leftoverReason,
  leftoverUpdateText,
  summarizeCommand,
  taskIsPersistent,
} from './leftover';
import { secretaryProjectName } from './projectLabel';
import type { SecretarySessionStatus } from './readers';
import { closeRelayAsk, dropRelay, openRelayAsk, pendingRelay, sessionLabel } from './relay';
import {
  ACTIVITY_LIMIT,
  capLastText,
  classify,
  countsAsRunning,
  enqueueUpdate,
  goalStatusOf,
  isUrgentUpdate,
  linkedTodoSession,
  proposalUpdate,
  type ResultEvent,
  reportLastText,
  SETTLED_RESULTS,
  sessionLiveState,
  shouldNotify,
  silentFinishDetail,
  skipsUpdateWindow,
  stalled,
  UPDATE_WINDOW_MS,
  updateKey,
  upstreamRetryOf,
} from './results';
import { fireDue, skipMissedCron, syncSystemSchedules } from './schedules';
import { advanceTodos } from './todoLifecycle';

const TICK_MS = 60_000;
/** 冷启动按恢复清单自动续跑的等待上限：超过仍未恢复成活轮次则按中断回传 */
export const COLD_RESUME_TIMEOUT_MS = 3 * 60_000;
/** 单独的 status=failed 等这么久还没等到 turn-failed，就补记失败 */
const FAILURE_PAIR_MS = 5_000;
/** 失败原因带进回传与通知的上限 */
const FAILURE_DETAIL_MAX_CHARS = 200;
/** 只刷新了事件时刻的派出记录，最多隔这么久落盘一次 */
const EVENT_STAMP_SAVE_MS = 30_000;
/** 遗留任务巡检间隔：每小时扫一遍已完成会话 */
const LEFTOVER_PATROL_MS = 60 * 60 * 1000;
/**
 * 出问题的等待派发是终态，不会再开始；秘书出问题当场已收到结果。
 * 看板卡片只是给用户的提醒，留一天，之后巡检清掉并留审计。
 */
const FAILED_PENDING_KEEP_MS = 24 * 60 * 60 * 1000;

const RESULT_LABELS: Record<SecretaryResultKind, { zh: string; en: string }> = {
  'goal-complete': { zh: '目标已完成', en: 'goal completed' },
  'goal-blocked': { zh: '目标受阻或已暂停', en: 'goal blocked or paused' },
  'turn-ended': { zh: '这一轮结束了，不代表完成', en: 'turn ended, not necessarily done' },
  'needs-user': { zh: '需要你处理', en: 'needs you' },
  failed: { zh: '失败', en: 'failed' },
  stalled: { zh: '停住了', en: 'stalled' },
  interrupted: { zh: '应用重启时正在运行，已被中断', en: 'interrupted by app restart' },
};

/** 按天回看只记有信息量的结果：轮次结束不进 daily.jsonl，否则日志全是它 */
const DAILY_KINDS: ReadonlySet<SecretaryResultKind> = new Set([
  'goal-complete',
  'goal-blocked',
  'needs-user',
  'failed',
  'stalled',
  'interrupted',
]);

export interface SecretaryHostPorts extends DeliveryPorts {
  enabled(): boolean;
  profile(): SecretaryProfile | null;
  todos(): SecretaryTodo[];
  saveTodos(todos: SecretaryTodo[]): void;
  schedules(): SecretarySchedule[];
  saveSchedules(schedules: SecretarySchedule[]): void;
  notify(build: (lang: 'zh' | 'en') => { title: string; body: string }): void;
  /** 联系方式（Telegram）：只转发里程碑、提问与卡片提示，不改回传与工作台 */
  contact?: SecretaryContactPort;
  /** 这个会话是不是秘书自己的会话：决定哪些提问与回复要发到手机 */
  isSecretaryConversation?(conversationId: string): boolean;
  /** 秘书带关联转问的 needsUser 被用户答复：记下答复，全部答完收口卡片；缺省表示不处理 */
  answerNeedsUser?(link: AskRelatesTo, answer: string, askedAt: number): void;
  /** 秘书带关联提问：那条 needsUser 同时升级进「需要你」；缺省表示不处理 */
  escalateNeedsUser?(link: AskRelatesTo, text: string | undefined): void;
  publish(): void;
  now(): number;
  /** 派出会话空闲等后台任务的看门狗；缺省表示没有 */
  backgroundStalls?(now: number): readonly BackgroundStall[];
  /** 会话最近一次已知的后台任务；缺省表示没有投影 */
  tasks?(conversationId: string): readonly ObservedTask[];
  /** worker 已把启动时的任务全量报上来；false 时空任务表只是还不知道。缺省表示已报 */
  tasksReported?(): boolean;
  /** 主会话名下还有没回来的子代理 Run；缺省表示没有 */
  subagentsRunning?(conversationId: string): boolean;
  /** 会话（含子代理）挂着的自定提醒；缺省表示没有 */
  reminders?(conversationId: string): readonly SessionReminder[];
  /** 上次应用退出打断这一轮的原因（启动恢复时说明）；缺省表示没有记录 */
  interruptDetail?(conversationId: string): string | undefined;
  /** 应用正在退出，这个会话写进了恢复清单、新实例接着跑：退出打断它不算结果 */
  continuesAfterExit?(conversationId: string): boolean;
  /** 冷启动正在按恢复清单续跑这个会话：启动恢复不报中断 */
  coldResumed?(conversationId: string): boolean;
  /** 依赖已经全部结束的等待派发：交给 dispatch 模块判定并建会话 */
  startPending?(pendingIds: readonly string[], now: number): void;
  /** 可能空出了名额：让排队会话的启动泵按先进先出补位；缺省表示没有排队会话 */
  drainQueued?(): void;
  audit?(entry: SecretaryAuditEntry): void;
  /** 追加一条按天回看用的结果记录；缺省表示不持久化 */
  recordDaily?(entry: SecretaryDailyRecord): void;
  /** 会话报完成：存下完整汇报并复制里面点名的截图，供看板「结果」视图 */
  archiveReport?(
    conversationId: string,
    at: number,
    text: string,
    extra?: {
      goalResult?: GoalResultView;
      shots?: { path: string; label?: string }[];
    }
  ): void;
  /**
   * 只读核验 goal_complete 的结构化结果。没有这个端口时不核，结果仍带上、checks 空着。
   */
  verifyGoalResult?(conversationId: string, result: GoalResult): Promise<GoalResultCheck[]>;
  /** 同事托付的待办办完或出了问题：回告发起的秘书；返回是否改了待办 */
  reportPeerTodos?(): boolean;
  /** 派出会话自动归档已回退，Main 不再调用；端口留作以后复用 */
  archive?(conversationId: string, at: number): void;
  /** 以前自动归档的会话被唤醒：收回归档 */
  unarchive?(conversationId: string): void;
  /** 用户此刻正开着这个会话；自动归档回退后暂不使用 */
  viewed?(conversationId: string): boolean;
}

export interface SecretaryHost {
  /** worker 事件入口：driver 与状态发布共用同一次 observe 结果 */
  onAgentEvent(event: RendererAgentEvent, changes: readonly SessionStatusPayload[]): void;
  tick(now?: number): void;
  /** 立刻投递 outbox：用户刚点了确认，别等下一分钟的 tick */
  flushNow(now?: number): void;
  /** 按指定时间点排一次投递（触发器防抖合并用）；不传或已到期时立即投递 */
  scheduleFlush(at?: number, now?: number): void;
  recordBackgroundStalls(stalls: readonly BackgroundStall[], now?: number): void;
  /** 冷启动没能按恢复清单接着跑这个会话：照常报失败 */
  onRestartResumeFailed(conversationId: string, error: string, now?: number): void;
  /** 当前打开的会话变了：补判以前自动归档的会话是否要收回 */
  sweepAutoArchive(now?: number): void;
  recover(): void;
  start(): void;
  stop(): void;
}

function sessionIdOf(event: RendererAgentEvent): string | undefined {
  if (!('identity' in event) || !event.identity) return undefined;
  return 'sessionId' in event.identity ? event.identity.sessionId : undefined;
}

/** 高频的流式事件：没有状态变化时只和派出会话、在途投递的秘书会话有关 */
const STREAM_EVENTS = new Set(['message-upsert', 'message-update', 'tool-output', 'session-meta']);

/** 审计里列出的任务：id 与命令摘要，最多三个 */
function taskList(tasks: readonly ObservedTask[]): string {
  const listed = tasks
    .slice(0, 3)
    .map((task) => `${task.taskId} ${summarizeCommand(task.command)}`);
  return tasks.length > 3 ? `${listed.join('; ')} (+${tasks.length - 3})` : listed.join('; ');
}

/** 子代理事件归到主会话：主会话等子代理时状态仍是 running，不刷新活动时间会误报停滞 */
function rootIdOf(event: RendererAgentEvent, sessionId: string): string {
  const identity = 'identity' in event ? event.identity : undefined;
  const parent =
    identity && 'parent' in identity ? (identity.parent as { sessionId?: unknown }) : undefined;
  const id = typeof parent?.sessionId === 'string' ? parent.sessionId : sessionId;
  const sep = id.indexOf('::');
  return sep === -1 ? id : id.slice(0, sep);
}

function assistantTextOf(event: RendererAgentEvent): string | undefined {
  if (event.type !== 'turn-completed') return undefined;
  return event.digest?.assistantText;
}

/**
 * 这一下有没有可见的回复：助手写出了文字，或调用了工具。
 * 秘书发消息后的无回复兜底只认这两种；状态、心跳之类的事件不算回复。
 */
function visibleReply(event: RendererAgentEvent): boolean {
  if (event.type === 'turn-completed') {
    return Boolean(event.digest?.assistantText?.trim() || event.digest?.lastTool);
  }
  if (event.type !== 'message-upsert') return false;
  const message = event.message;
  if (message.role === 'toolResult') return true;
  if (message.role !== 'assistant') return false;
  return message.content.some(
    (part) =>
      (part.type === 'text' && part.text.trim().length > 0) ||
      (part.type === 'toolCall' && part.name.trim().length > 0)
  );
}

function resultEventOf(
  event: RendererAgentEvent,
  row: Record<string, unknown> | undefined
): ResultEvent | null {
  switch (event.type) {
    case 'turn-completed': {
      const goalStatus = goalStatusOf(row);
      // 整轮没有任何文字回复、最后一步是工具调用：静默收工
      const lastTool = event.digest?.assistantText?.trim() ? undefined : event.digest?.lastTool;
      return {
        type: 'turn-completed',
        ...(event.aborted ? { aborted: true } : {}),
        ...(goalStatus ? { goalStatus } : {}),
        ...(lastTool ? { silentFinish: lastTool } : {}),
      };
    }
    case 'turn-failed':
      // 应用退出窗口内的断流：Main 已改判成中断，不能报成失败
      if (event.interrupted)
        return { type: 'turn-interrupted', at: event.interrupted.at, kind: event.interrupted.kind };
      // 上游瞬态/配额故障已进入自动退避等待：不按失败推送，避免向秘书和用户误报 failed
      if (upstreamRetryOf(row)) return null;
      return { type: 'turn-failed', error: event.error };
    case 'goal-signal':
      return { type: 'goal-signal', kind: event.kind };
    // 转交给秘书的提问不算「需要用户处理」：秘书会答，用户也可能在原会话里直接答
    case 'ask-request':
      return event.ask?.relay ? null : { type: 'needs-user' };
    case 'approval-request':
      return { type: 'needs-user' };
    default:
      return null;
  }
}

/**
 * 只有投递那一轮正常结束才算成功；中止与报错都按失败重投。
 * worker 收口时先报空闲、再发 turn-completed：空闲时投出的这一批还没上屏，紧随其后的结局属于上一轮。
 */
function deliveryOutcome(
  event: RendererAgentEvent,
  inflight: NonNullable<SecretaryDispatchFile['inflight']>
): DeliveryOutcome | null {
  if (event.type === 'worker-exited') return 'failed';
  if (event.type === 'delivery-settled' || event.type === 'delivery-rejected') {
    if (event.deliveryId !== inflight.deliveryId) return null;
    return event.type === 'delivery-settled' ? 'started' : 'failed';
  }
  if (!inflight.started) return null;
  if (event.type === 'turn-completed') return event.aborted ? 'failed' : 'done';
  if (event.type === 'turn-failed') return 'failed';
  return null;
}

function upstreamWaitingSummary(retry: GoalUpstreamRetry): string {
  const clock = formatRetryClock(retry.at);
  return retry.kind === 'quota'
    ? `额度用完，自动重试中（下次 ${clock}）`
    : `上游不可用，自动重试中（下次 ${clock}）`;
}

function failureDetail(error: string | undefined): string | undefined {
  return redactSecrets(error?.trim() ?? '').slice(0, FAILURE_DETAIL_MAX_CHARS) || undefined;
}

/** 秘书还在等这个会话的结果：还没收口，或收口后又被秘书追加了任务 */
function awaitsOutcome(record: DispatchRecord): boolean {
  return (
    !record.lastResult ||
    !SETTLED_RESULTS.has(record.lastResult.kind) ||
    record.reopenedAt !== undefined
  );
}

/** 会话恢复成运行中后，清掉上次落盘的 interrupted / failed / stoppedAt，避免与实际状态冲突 */
function clearStaleStoppedOnLive(record: DispatchRecord): boolean {
  let cleared = false;
  if (record.lastResult?.kind === 'interrupted' || record.lastResult?.kind === 'failed') {
    delete record.lastResult;
    cleared = true;
  }
  if (record.stoppedAt !== undefined) {
    delete record.stoppedAt;
    cleared = true;
  }
  return cleared;
}
function expireFailedPending(
  file: SecretaryDispatchFile,
  now: number,
  audit: (entry: SecretaryAuditEntry) => void
): boolean {
  const table = file.pending;
  if (!table) return false;
  let changed = false;
  for (const [id, pending] of Object.entries(table)) {
    if (pending.status !== 'failed' || now - pending.updatedAt < FAILED_PENDING_KEEP_MS) continue;
    delete table[id];
    audit({
      at: now,
      secretaryConversationId: pending.secretaryConversationId,
      op: 'pending_expire',
      targetId: id,
      ok: true,
      detail: pending.problem ?? 'dispatch-failed',
    });
    changed = true;
  }
  if (changed && Object.keys(table).length === 0) delete file.pending;
  return changed;
}

interface GoalVerifySlot {
  result: GoalResult;
  startedAt: number;
  checks?: GoalResultCheck[];
  done: boolean;
  cancelled?: boolean;
  onDone?: () => void;
}

export const GOAL_RESULT_VERIFY_MS = 8_000;

/** 完成当时的待决定事项和 summary。只写非空，之后「知道了」不回改这条动态 */
function activitySnapshot(
  goalResult: GoalResultView
): Pick<SecretaryActivity, 'needsUser' | 'summary'> {
  const needsUser = needsUserItems(goalResult)
    .map((item) => redactSecrets(item).trim())
    .filter((item) => item.length > 0);
  const summary = redactSecrets(goalResult.result.summary?.trim() ?? '').trim();
  return {
    ...(needsUser.length > 0 ? { needsUser } : {}),
    ...(summary ? { summary } : {}),
  };
}

export function createSecretaryHost(ports: SecretaryHostPorts): SecretaryHost {
  let timer: ReturnType<typeof setInterval> | null = null;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let coalesceAt: number | undefined;
  /** 配对窗口到点就补记失败，不等每分钟一次的巡检；巡检仍兜底 */
  let failureTimer: ReturnType<typeof setTimeout> | null = null;
  /** goal_complete 先到、轮次还没结束：等 turn-completed 再报，避免会话还在跑就通知完成 */
  const pendingComplete = new Set<string>();
  /** 启动恢复时按恢复清单放行、正在等待恢复成活轮次的会话 → 放行时刻 */
  const coldResumePending = new Map<string, number>();
  /** 上一次 tick：needsUser 的筛选期在两次 tick 之间到点时重新发布一次工作台 */
  let lastTickAt: number | undefined;
  /** 结构化结果的只读核验。轮次结束时还没落定就先挂起收尾。 */
  const goalVerifies = new Map<string, GoalVerifySlot>();
  const goalVerifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 下一次自动巡检的时间；没有进行中的会话时清空，等于停掉巡检 */
  let patrolAt: number | undefined;
  /** 下一次遗留任务巡检的时间；与进行中巡检分开计时，没有进行中的会话也照常扫 */
  let leftoverAt: number | undefined;

  /**
   * 后台任务分两路：常驻服务不会自己结束，不能算「等后台任务」，
   * 否则会话收口后一个没关的 dev server 就能把它永远挂在进行中。
   */
  function applyTasks(record: DispatchRecord, tasks: readonly ObservedTask[], now: number): void {
    const running = tasks.filter((task) => task.status === 'running');
    const persistent = running.filter((task) => taskIsPersistent(task, now));
    if (running.length > persistent.length) record.backgroundRunning = true;
    else delete record.backgroundRunning;
    if (persistent.length > 0) record.backgroundPersistent = true;
    else delete record.backgroundPersistent;
  }

  /**
   * 这一轮停下来是在等后台命令或子代理：它们回来会把会话叫醒，此时报「结束」只会误导秘书。
   * 常驻服务与进程已不在的任务不会叫醒它，不算。
   */
  function awaitsWake(conversationId: string, now: number): boolean {
    if (ports.subagentsRunning?.(conversationId)) return true;
    if (reminderPending(conversationId, now)) return true;
    return (ports.tasks?.(conversationId) ?? []).some(
      (task) => task.status === 'running' && task.alive !== false && !taskIsPersistent(task, now)
    );
  }

  /** 在等自己定的提醒：到点超过宽限期还没被叫醒就不算 */
  function reminderPending(conversationId: string, now: number): boolean {
    return hasPendingReminder(ports.reminders?.(conversationId) ?? [], now);
  }

  /**
   * 遗留标记：会话已经不在跑，但还有没结束的后台任务。
   * 只做标记，不杀进程；任务结束或会话重新跑起来就自动清掉。
   */
  function refreshLeftovers(
    records: readonly DispatchRecord[],
    statuses: Readonly<Record<string, SecretarySessionStatus>>,
    now: number
  ): boolean {
    let changed = false;
    const rows = ports.rows();
    for (const record of records) {
      const tasks = ports.tasks?.(record.conversationId) ?? [];
      const before = JSON.stringify([
        record.backgroundRunning ?? false,
        record.backgroundPersistent ?? false,
        record.leftoverTasks?.taskIds ?? [],
      ]);
      applyTasks(record, tasks, now);
      const going = countsAsRunning(
        record,
        rows[record.conversationId],
        statuses[record.conversationId]
      );
      const running = tasks.filter((task) => task.status === 'running');
      if (!going && running.length > 0) {
        record.leftoverTasks = {
          count: running.length,
          commands: running.slice(0, 3).map((task) => summarizeCommand(task.command)),
          taskIds: running.map((task) => task.taskId),
          at: now,
        };
      } else {
        delete record.leftoverTasks;
      }
      const after = JSON.stringify([
        record.backgroundRunning ?? false,
        record.backgroundPersistent ?? false,
        record.leftoverTasks?.taskIds ?? [],
      ]);
      if (before !== after) changed = true;
    }
    return changed;
  }

  /**
   * 遗留任务巡检：每小时扫一遍，只推不杀。
   * 同一批任务只推一次；任务变了（换了或多了）才再推一条。
   */
  function runLeftoverPatrol(
    file: SecretaryDispatchFile,
    records: readonly DispatchRecord[],
    now: number
  ): boolean {
    if (ports.profile()?.patrolEnabled === false) return false;
    if (leftoverAt !== undefined && now < leftoverAt) return false;
    leftoverAt = now + LEFTOVER_PATROL_MS;
    let changed = false;
    for (const record of records) {
      const leftover = record.leftoverTasks;
      if (!leftover || leftover.count === 0) {
        if (record.leftoverPatrol) {
          delete record.leftoverPatrol;
          changed = true;
        }
        continue;
      }
      const taskIds = [...leftover.taskIds].sort();
      const signature = taskIds.join(',');
      if (record.leftoverPatrol?.taskIds === signature) continue;
      const settledAt = record.lastResult?.at;
      const entries = (ports.tasks?.(record.conversationId) ?? []).flatMap((task) => {
        if (!taskIds.includes(task.taskId)) return [];
        const reason = leftoverReason(task, { now, settledAt });
        return reason ? [{ task, reason }] : [];
      });
      if (entries.length === 0) continue;
      record.leftoverPatrol = { taskIds: signature, at: now };
      file.outbox = enqueueUpdate(file.outbox, {
        key: `leftover:${record.conversationId}:${signature}`,
        at: now,
        kind: 'leftover',
        conversationId: record.conversationId,
        secretaryConversationId: record.secretaryConversationId,
        text: leftoverUpdateText(labelOf(file, record.conversationId), entries, now),
      });
      changed = true;
    }
    return changed;
  }

  function remember(file: SecretaryDispatchFile, entry: SecretaryActivity): void {
    file.activity = [...(file.activity ?? []), entry].slice(-ACTIVITY_LIMIT);
  }

  /**
   * 自动归档已回退：派出会话完成后不再收进归档。
   * 只处理以前自动归档的会话：重新跑起来或还有没结束的后台任务就收回；用户手动归档的不碰。返回是否改了记录。
   * 任务表还没报上来时不按空表判断。
   */
  function syncAutoArchive(
    file: SecretaryDispatchFile,
    ids: Iterable<string>,
    rows: Record<string, Record<string, unknown>>,
    now: number,
    woken: ReadonlySet<string> = new Set()
  ): boolean {
    if (!ports.unarchive) return false;
    const reported = ports.tasksReported?.() ?? true;
    let changed = false;
    for (const conversationId of ids) {
      const record = file.dispatched[conversationId];
      if (!record) continue;
      const row = rows[conversationId];
      const live = reported ? liveTasks(ports.tasks?.(conversationId) ?? []) : [];
      if (autoArchived(record, row)) {
        const woke = woken.has(conversationId);
        if (!woke && live.length === 0) continue;
        ports.unarchive(conversationId);
        delete record.autoArchivedAt;
        ports.audit?.({
          at: now,
          secretaryConversationId: record.secretaryConversationId,
          op: 'auto_unarchive',
          targetId: conversationId,
          ok: true,
          ...(woke ? {} : { detail: `background tasks running: ${taskList(live)}` }),
        });
        changed = true;
        continue;
      }
      // 用户取消了归档或又手动归档：这条标记不再代表当前的归档
      if (record.autoArchivedAt !== undefined) {
        delete record.autoArchivedAt;
        changed = true;
      }
    }
    return changed;
  }

  /** 会话的一句话标签：项目 · 标题，回传正文与卡片都用它 */
  function labelOf(file: SecretaryDispatchFile, conversationId: string): string {
    const record = file.dispatched[conversationId];
    const row = ports.rows()[conversationId];
    const project = record
      ? ports.projects().find((candidate) => candidate.projectId === record.projectId)
      : undefined;
    return sessionLabel(
      secretaryProjectName(project, ports.projectAliases?.()),
      typeof row?.title === 'string' ? row.title : '',
      conversationId
    );
  }

  /**
   * 派出/接管会话的 ask_user 先送到秘书：记下挂起的提问并推一条；
   * 收尾时（秘书代答、用户在原会话里直接答、超时）把状态记回记录。
   */
  function applyRelayEvent(
    file: SecretaryDispatchFile,
    event: RendererAgentEvent,
    conversationId: string | undefined,
    now: number
  ): boolean {
    if (!conversationId) return false;
    const record = file.dispatched[conversationId];
    if (!record) return false;
    if (event.type === 'ask-request') {
      if (!event.ask?.relay) return false;
      const update = openRelayAsk(
        file,
        {
          conversationId,
          askId: event.ask.requestId,
          question: event.ask.question,
          ...(event.ask.options ? { options: event.ask.options } : {}),
          ...(event.ask.recommended ? { defaultOption: event.ask.recommended } : {}),
          ...(event.ask.expiresAt !== undefined ? { expiresAt: event.ask.expiresAt } : {}),
          label: labelOf(file, conversationId),
        },
        now
      );
      ports.audit?.({
        at: now,
        secretaryConversationId: record.secretaryConversationId,
        op: 'ask_relay',
        targetId: conversationId,
        ok: true,
        detail: event.ask.requestId,
      });
      if (!update) return false;
      file.outbox = enqueueUpdate(file.outbox, update);
      return true;
    }
    if (event.type !== 'ask-resolved') return false;
    if (!pendingRelay(file, conversationId, event.requestId)) return false;
    // 取消（会话中止、worker 换代）：提问没人等了，记录作废，不再回传
    if (!event.by) {
      const dropped = dropRelay(file, conversationId, event.requestId);
      if (dropped) {
        ports.audit?.({
          at: now,
          secretaryConversationId: record.secretaryConversationId,
          op: 'ask_relay_cancel',
          targetId: conversationId,
          ok: true,
          detail: event.requestId,
        });
      }
      return dropped;
    }
    const closed = closeRelayAsk(
      file,
      {
        conversationId,
        askId: event.requestId,
        by: event.by,
        ...(event.answer ? { answer: event.answer } : {}),
      },
      now,
      labelOf(file, conversationId)
    );
    if (!closed.relay) return false;
    // 秘书代答时它自己知道，不用再回传；用户直接答或超时要说一声，免得秘书继续等
    if (closed.update && event.by !== 'relay')
      file.outbox = enqueueUpdate(file.outbox, closed.update);
    ports.audit?.({
      at: now,
      secretaryConversationId: record.secretaryConversationId,
      op: event.by === 'relay' ? 'ask_relay_answer' : 'ask_relay_closed',
      targetId: conversationId,
      ok: true,
      detail: `${event.requestId} ${event.by}`,
    });
    return true;
  }

  function armCoalesce(at: number, now: number): void {
    if (coalesceAt !== undefined && coalesceAt <= at) return;
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceAt = at;
    // 测试里逻辑时钟和真实时钟会差很远，延迟最多一个窗口，避免 setTimeout 溢出
    coalesceTimer = setTimeout(
      () => {
        coalesceTimer = null;
        coalesceAt = undefined;
        flush(ports.now());
      },
      Math.min(60_000, Math.max(0, at - now))
    );
    coalesceTimer.unref?.();
  }

  function recordUpdate(
    record: DispatchRecord,
    kind: SecretaryResultKind,
    now: number,
    detail?: string,
    body = record.lastText
  ): { update: SecretaryUpdate; title: string; projectName: string } {
    const row = ports.rows()[record.conversationId];
    const project = ports.projects().find((candidate) => candidate.projectId === record.projectId);
    const projectName = secretaryProjectName(project, ports.projectAliases?.());
    const title = typeof row?.title === 'string' ? row.title : '';
    const update: SecretaryUpdate = {
      key: updateKey(record.conversationId, kind, record.turn),
      at: now,
      kind,
      conversationId: record.conversationId,
      secretaryConversationId: record.secretaryConversationId,
      text: [projectName, title, RESULT_LABELS[kind].zh, detail].filter(Boolean).join(' · '),
      ...(body ? { lastText: body } : {}),
    };
    return { update, title, projectName };
  }

  function notifyResult(
    update: SecretaryUpdate,
    kind: SecretaryResultKind,
    extra: { title: string; projectName: string; conversationId: string; lastText?: string }
  ): void {
    const profile = ports.profile();
    if (!profile) return;
    if (shouldNotify(profile.notify, kind)) {
      ports.notify((lang) => ({
        title: `${profile.name} · ${RESULT_LABELS[kind][lang]}`,
        body: update.text.slice(0, 100),
      }));
    }
    // 手机上读的一条：项目 · 会话标题，加一句正文与回应用的深链。
    // 与系统通知同一个 notify 口径；手机关注中的任务是 J 哥亲手要的答案，一定要回推
    if (!shouldForwardMilestone(profile.notify, kind)) {
      if (kind === 'turn-ended' || !ports.contact?.follows?.(extra.conversationId)) return;
    }
    ports.contact?.onMilestone({
      kind,
      title: [extra.projectName, extra.title].filter(Boolean).join(' · ') || extra.conversationId,
      ...(extra.lastText ? { lastText: extra.lastText } : {}),
      conversationId: extra.conversationId,
    });
  }

  function recordResult(
    file: SecretaryDispatchFile,
    record: DispatchRecord,
    kind: SecretaryResultKind,
    now: number,
    detail?: string,
    /** 这一轮的完整正文：分支与提交号只在原文里认，落盘仍按 lastText 截断 */
    report?: string,
    /** 这一轮的结论原文：终态与一轮结束回传带上，手机与工作台仍用短正文 */
    turnReport?: TurnReport,
    goalResult?: GoalResultView
  ): void {
    // 手动标记完成的会话不再被后续迟到的受阻、轮次结束、停滞、失败拉回；
    // 只有撤销标记或秘书发来新 goal 才会清掉 manual 标记重新跟踪
    if (record.lastResult?.manual === true && kind !== 'goal-complete') return;
    // 主动停止且未重新打开的会话：忽略停后迟到的报错/受阻/停滞噪声
    if (
      record.stoppedAt !== undefined &&
      record.reopenedAt === undefined &&
      kind !== 'goal-complete'
    )
      return;
    if (record.lastResult?.kind === kind && record.lastResult.turn === record.turn) return;
    record.lastResult = { kind, turn: record.turn, at: now };
    // 有了新结果，用户撤销标记的「放回进行中」到此为止
    delete record.manualUndoneAt;
    // 收口了就不会再有后台任务唤醒它；留着这条记录会让空闲会话一直被算在跑
    if (SETTLED_RESULTS.has(kind)) {
      delete record.backgroundRunning;
      delete record.backgroundPersistent;
    }
    // 完成回传里点名还在跑的后台任务：秘书收到完成通知就知道有遗留
    const leftover =
      kind === 'goal-complete'
        ? leftoverNote(ports.tasks?.(record.conversationId) ?? [])
        : undefined;
    const { update, title, projectName } = recordUpdate(
      record,
      kind,
      now,
      [detail, leftover].filter(Boolean).join('；') || undefined,
      reportLastText(kind, turnReport, report) ?? record.lastText
    );
    if (kind === 'goal-complete' && goalResult) {
      update.goalResult = goalResult;
      record.goalResult = goalResult;
    } else {
      delete record.goalResult;
    }
    const previous = file.outbox.find(
      (entry) => 'conversationId' in entry && entry.conversationId === record.conversationId
    );
    // 终态马上投；一轮停下也马上投（还在等后台命令、子代理的那种上游已拦下，不会走到这里）；
    // 手机关注的任务结果会马上推给发起渠道，桌面秘书会话同一时刻也要收到
    const immediate =
      skipsUpdateWindow(kind) ||
      kind === 'turn-ended' ||
      ports.contact?.follows?.(record.conversationId);
    if (!isUrgentUpdate(update) && !immediate) {
      const held = previous?.deliverAt;
      update.deliverAt =
        held !== undefined && held > now
          ? held
          : now + (ports.profile()?.updateWindowMs ?? UPDATE_WINDOW_MS);
      armCoalesce(update.deliverAt, now);
    }
    if (previous && previous.key !== update.key) {
      ports.audit?.({
        at: now,
        secretaryConversationId: record.secretaryConversationId,
        op: 'update_coalesced',
        targetId: record.conversationId,
        ok: true,
        detail: `${previous.kind} -> ${kind}`,
      });
    }
    file.outbox = enqueueUpdate(file.outbox, update);
    remember(file, {
      at: now,
      conversationId: record.conversationId,
      kind,
      text: record.lastText || update.text,
      ...(kind === 'goal-complete' && goalResult ? activitySnapshot(goalResult) : {}),
    });
    rememberDaily(record, kind, now, title, report, goalResult);
    const finalReport = kind === 'goal-complete' ? turnReport?.text.trim() || report?.trim() : '';
    const shots = goalResult?.result.screenshots?.map((shot) => ({
      path: shot.path,
      ...(shot.caption ? { label: shot.caption } : {}),
    }));
    if (finalReport || (kind === 'goal-complete' && goalResult)) {
      ports.archiveReport?.(
        record.conversationId,
        now,
        finalReport ? redactSecrets(finalReport) : '',
        goalResult ? { goalResult, ...(shots && shots.length > 0 ? { shots } : {}) } : undefined
      );
    }
    notifyResult(update, kind, {
      title,
      projectName,
      conversationId: record.conversationId,
      ...(record.lastText ? { lastText: record.lastText } : {}),
    });
  }

  /** 按天回看的结果记录：activity 只留 400 条，历史某天要靠 daily.jsonl */
  function rememberDaily(
    record: DispatchRecord,
    kind: SecretaryResultKind,
    now: number,
    title: string,
    report: string | undefined,
    goalResult?: GoalResultView
  ): void {
    if (!ports.recordDaily) return;
    if (!DAILY_KINDS.has(kind)) return;
    const body = capLastText(report) ?? record.lastText;
    ports.recordDaily({
      at: now,
      conversationId: record.conversationId,
      kind,
      ...(record.projectId ? { projectId: record.projectId } : {}),
      ...(title ? { title: redactSecrets(title) } : {}),
      ...(body ? { text: redactSecrets(body) } : {}),
      // 只认这一轮的最终汇报：停滞、中断没有正文，不能拿上一轮的提交号充数
      ...(report ? extractReportRefs(report) : {}),
      ...(goalResult ? { goalResult } : {}),
    });
  }

  /** 同一轮只报一次。返回是否写进了回传队列 */
  function applyBackgroundStall(
    file: SecretaryDispatchFile,
    stall: BackgroundStall,
    now: number
  ): boolean {
    const record = file.dispatched[stall.conversationId];
    if (!record || record.stalledTurn === record.turn) return false;
    record.stalledTurn = record.turn;
    recordResult(file, record, 'stalled', now, BACKGROUND_STALL_DETAIL[stall.reason]);
    return true;
  }

  function flush(now: number): void {
    void flushDeliveries(ports, now).catch((error: unknown) => {
      console.warn(
        '[secretary] delivery failed:',
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  /**
   * 自动巡检：只在有进行中的会话时跑，只在发现异常时推一条。
   * 同一会话同一原因一轮只推一次；会话有了新事件就算恢复，标记清掉。
   */
  function runPatrol(
    file: SecretaryDispatchFile,
    records: readonly DispatchRecord[],
    statuses: Readonly<Record<string, SecretarySessionStatus>>,
    now: number
  ): boolean {
    const profile = ports.profile();
    if (!profile?.patrolEnabled) return false;
    const rows = ports.rows();
    let changed = false;
    for (const record of records) {
      if (!record.patrol) continue;
      if (record.lastEventAt <= record.patrol.at && record.turn === record.patrol.turn) continue;
      delete record.patrol;
      changed = true;
    }
    const live = records.filter(
      (record) =>
        countsAsRunning(record, rows[record.conversationId], statuses[record.conversationId]) ||
        // 发过消息后没有任何可见回复：记录还标着运行中，但会话其实已空闲，
        // 不在「在跑」口径里，3 分钟兜底仍要看着它
        (record.sentAt !== undefined &&
          statuses[record.conversationId]?.state === 'idle' &&
          (statuses[record.conversationId]?.pendingAsks ?? 0) +
            (statuses[record.conversationId]?.pendingApprovals ?? 0) ===
            0)
    );
    // 没有进行中的会话：巡检自己停下，等下一次有活再重新计时
    if (live.length === 0) {
      patrolAt = undefined;
      return changed;
    }
    if (patrolAt !== undefined && now < patrolAt) return changed;
    // 停住阈值比巡检间隔小时按阈值走：3 分钟的判定不该被 15 分钟的间隔拖住
    patrolAt = now + Math.min(PATROL_INTERVAL_MS, PATROL_IDLE_GOAL_MS);
    const facts: PatrolFacts[] = live.map((record) => {
      const status = statuses[record.conversationId];
      const row = rows[record.conversationId];
      // 巡检看真实状态：刚发过消息时记录标着 running，但会话其实已空闲，
      // 用 sessionStateOf 会把它报成运行中，3 分钟的无回复兜底就永远等不到
      const state = sessionLiveState(row, status);
      const goalStatus = goalStatusOf(row);
      return {
        conversationId: record.conversationId,
        state,
        ...(goalStatus ? { goalStatus } : {}),
        pending: (status?.pendingAsks ?? 0) + (status?.pendingApprovals ?? 0),
        ...(record.backgroundRunning ? { backgroundRunning: true } : {}),
        lastEventAt: record.lastEventAt,
        turn: record.turn,
        ...(record.patrol ? { patrol: record.patrol } : {}),
        stallReported: record.stalledTurn === record.turn,
        ...(record.lastResult ? { result: record.lastResult.kind } : {}),
        ...(record.lastText ? { lastText: record.lastText } : {}),
        ...(record.sentAt !== undefined &&
        record.sentAt >= record.lastEventAt &&
        record.backgroundRunning !== true
          ? { awaitingReplySince: record.sentAt }
          : {}),
        ...(reminderPending(record.conversationId, now) ? { reminderPending: true } : {}),
        ...(upstreamRetryOf(rows[record.conversationId]) ? { upstreamWaiting: true } : {}),
        ...(ports.subagentsRunning?.(record.conversationId) ? { subagentsRunning: true } : {}),
      };
    });
    for (const anomaly of patrolAnomalies(facts, now)) {
      const record = file.dispatched[anomaly.conversationId];
      if (!record) continue;
      record.patrol = { reason: anomaly.reason, turn: record.turn, at: now };
      const goalStatus = goalStatusOf(rows[record.conversationId]);
      recordResult(
        file,
        record,
        'stalled',
        now,
        patrolStallDetail({
          reason: anomaly.reason,
          idleMinutes: (now - record.lastEventAt) / 60_000,
          ...(goalStatus ? { goalStatus } : {}),
          backgroundRunning: record.backgroundRunning === true,
          ...(record.lastText ? { lastText: record.lastText } : {}),
          awaitingReply: record.sentAt !== undefined && record.sentAt >= record.lastEventAt,
        })
      );
      changed = true;
    }
    return changed;
  }

  /** 到点的定时进回传队列，与结果共用一次投递；返回是否改了 dispatch 文件 */
  function fireSchedules(file: SecretaryDispatchFile, now: number): boolean {
    const fired = fireDue(ports.schedules(), now);
    if (fired.changed) ports.saveSchedules(fired.schedules);
    if (fired.updates.length === 0) return false;
    // 手机发起的回合里加的定时：到点推一次手机，推完就结束关注
    for (const update of fired.updates) {
      if (!('scheduleId' in update) || !update.scheduleId) continue;
      ports.contact?.onScheduleFired({ scheduleId: update.scheduleId, text: update.text });
    }
    file.outbox = fired.updates.reduce(enqueueUpdate, file.outbox);
    return true;
  }

  /** 秘书会话最近一条用户消息：纯系统回传的回合不打扰，不亮「正在输入…」 */
  const lastUserText = new Map<string, string>();
  /** 这一轮已经报过的工具调用 id：流式 upsert 会重复带同一个 toolCall，只数一次 */
  const seenToolCalls = new Map<string, Set<string>>();

  /**
   * 联系方式：秘书自己会话里的提问、回复与审批同步到手机。
   * 派出会话的提问走 ask-relay 只交给秘书，不发手机；秘书定不了会用自己的 ask_user 再问。
   */
  function forwardToContact(event: RendererAgentEvent, conversationId: string): void {
    const contact = ports.contact;
    if (!contact) return;
    if (event.type === 'message-upsert') {
      if (event.message.role === 'user') {
        lastUserText.set(conversationId, messageText(event.message));
      }
      if (event.message.role === 'assistant' && contact.onToolCall) {
        let seen = seenToolCalls.get(conversationId);
        for (const part of event.message.content) {
          if (part.type !== 'toolCall' || !part.id || !part.name.trim()) continue;
          if (!seen) {
            seen = new Set();
            seenToolCalls.set(conversationId, seen);
          }
          if (seen.has(part.id)) continue;
          seen.add(part.id);
          contact.onToolCall(conversationId, part.name);
        }
      }
      return;
    }
    if (event.type === 'status') {
      // 回合开始/收尾：running 点亮「正在输入…」，idle/failed 立刻收掉（含用户停止）
      if (event.status !== 'running') {
        // 收尾就清掉：下一轮没拿到用户消息时按「不是系统回传」处理，宁可多亮一次
        lastUserText.delete(conversationId);
        seenToolCalls.delete(conversationId);
        contact.onTurnEnd(conversationId);
        return;
      }
      // 静默只可能来自纯系统回传（silence_turn / 静默标记都要求这一条），不发 typing
      if (!isPureSessionUpdate(lastUserText.get(conversationId) ?? '')) {
        contact.onTurnStart(conversationId);
      }
      return;
    }
    if (event.type === 'ask-request' && event.ask && !event.ask.relay) {
      contact.onAskRequest(conversationId, event.ask);
      return;
    }
    if (event.type === 'ask-resolved') {
      // by/answer 决定手机那条提示写成「已回答」还是「已过期」
      contact.onAskResolved(conversationId, event.requestId, {
        ...(event.by ? { by: event.by } : {}),
        ...(event.answer ? { answer: event.answer } : {}),
      });
      return;
    }
    // 审批卡不在这里：所有会话（含秘书会话）都由远程审批桥统一发到手机
    if (event.type !== 'turn-completed' || event.aborted) return;
    if (event.silent) {
      // 静默回合就是不打扰：手机上一条都不发，只收掉「正在输入…」等未决状态
      contact.onTurnSilent(conversationId);
      return;
    }
    const text = event.digest?.assistantText?.trim();
    if (!text) return;
    // 系统回传注入的回合：手机发起的任务链上，这一轮也算「回给手机」
    const inflight = (ports.peekFile?.() ?? ports.file()).inflight;
    const delivery = inflight?.secretaryConversationId === conversationId && inflight.started;
    contact.onTurnReply(conversationId, text, {
      ...(delivery ? { delivery: true } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
    });
  }

  /**
   * 派出会话每个流式事件都会刷新 lastEventAt：只有它变了就不逐条落盘（整份几百 KB）和广播，
   * 隔一段时间补存一次供巡检判空闲。其余字段变化立即落盘。
   */
  let savedSignature: string | null = null;
  let savedAt = Number.NEGATIVE_INFINITY;
  /** 还没落盘的事件时刻：每次读盘后补回，补存由别的会话触发时也不丢，巡检读到的是最新活动 */
  const eventStamps = new Map<string, number>();
  function withEventStamps(file: SecretaryDispatchFile): SecretaryDispatchFile {
    for (const [conversationId, at] of eventStamps) {
      const record = file.dispatched[conversationId];
      if (!record) eventStamps.delete(conversationId);
      else if (at > record.lastEventAt) record.lastEventAt = at;
    }
    return file;
  }
  function saveEventFile(file: SecretaryDispatchFile, now: number): boolean {
    const signature = JSON.stringify(file, (key, value) =>
      key === 'lastEventAt' ? undefined : value
    );
    if (signature === savedSignature && now - savedAt < EVENT_STAMP_SAVE_MS) return false;
    ports.save(file);
    savedSignature = signature;
    savedAt = now;
    return true;
  }

  /** 只补判以前自动归档的会话要不要收回；ids 缺省为全部派出会话 */
  function sweepArchive(ids: readonly string[] | undefined, now: number): void {
    const file = withEventStamps(ports.file());
    if (!syncAutoArchive(file, ids ?? Object.keys(file.dispatched), ports.rows(), now)) return;
    ports.save(file);
    ports.publish();
  }

  /** 配对窗口过了还没等到 turn-failed：会话仍在报错就补记失败（命令直接抛错时只有 status=failed） */
  function settleFailures(file: SecretaryDispatchFile, now: number): boolean {
    let changed = false;
    for (const record of Object.values(file.dispatched)) {
      const pending = record.failurePending;
      if (!pending || now - pending.at < FAILURE_PAIR_MS) continue;
      delete record.failurePending;
      changed = true;
      if (ports.status(record.conversationId).state !== 'error') continue;
      if (ports.continuesAfterExit?.(record.conversationId)) continue;
      if (upstreamRetryOf(ports.rows()[record.conversationId])) continue;
      record.turn += 1;
      delete record.reopenedAt;
      recordResult(file, record, 'failed', now, pending.detail);
    }
    return changed;
  }

  function armFailureTimer(): void {
    if (failureTimer) return;
    failureTimer = setTimeout(() => {
      failureTimer = null;
      if (!ports.enabled()) return;
      const now = ports.now();
      const file = withEventStamps(ports.file());
      if (settleFailures(file, now)) {
        ports.save(file);
        syncLinkedTodos(ports, file, ports.rows(), new Set());
        ports.publish();
        flush(now);
      }
      // 窗口里又进来的失败还没到点：再等一个窗口
      if (Object.values(file.dispatched).some((record) => record.failurePending)) armFailureTimer();
    }, FAILURE_PAIR_MS);
    failureTimer.unref?.();
  }

  function goalView(slot: GoalVerifySlot, at: number): GoalResultView | undefined {
    return parseGoalResultView({
      result: slot.result,
      at,
      ...(slot.checks && slot.checks.length > 0 ? { checks: slot.checks } : {}),
    });
  }

  function settleGoalVerify(
    conversationId: string,
    slot: GoalVerifySlot,
    checks: GoalResultCheck[]
  ): void {
    if (slot.done || slot.cancelled) return;
    slot.done = true;
    slot.checks = checks;
    const timer = goalVerifyTimers.get(conversationId);
    if (timer) clearTimeout(timer);
    goalVerifyTimers.delete(conversationId);
    slot.onDone?.();
  }

  function cancelGoalVerify(conversationId: string): void {
    const slot = goalVerifies.get(conversationId);
    if (slot) slot.cancelled = true;
    goalVerifies.delete(conversationId);
    const timer = goalVerifyTimers.get(conversationId);
    if (timer) clearTimeout(timer);
    goalVerifyTimers.delete(conversationId);
  }

  function startGoalVerify(conversationId: string, result: GoalResult, now: number): void {
    cancelGoalVerify(conversationId);
    const slot: GoalVerifySlot = { result, startedAt: now, done: !ports.verifyGoalResult };
    goalVerifies.set(conversationId, slot);
    const port = ports.verifyGoalResult;
    if (!port) return;
    const timer = setTimeout(
      () => settleGoalVerify(conversationId, slot, unverifiableGoalChecks(result, '核验超时')),
      GOAL_RESULT_VERIFY_MS
    );
    timer.unref?.();
    goalVerifyTimers.set(conversationId, timer);
    void port(conversationId, result).then(
      (checks) => settleGoalVerify(conversationId, slot, checks),
      () => settleGoalVerify(conversationId, slot, unverifiableGoalChecks(result, '核验超时'))
    );
  }

  function finishGoalResult(
    conversationId: string,
    slot: GoalVerifySlot,
    now: number,
    detail: string | undefined,
    report: string | undefined,
    turnReport: TurnReport | undefined
  ): void {
    if (slot.cancelled) return;
    goalVerifies.delete(conversationId);
    const file = withEventStamps(ports.file());
    const record = file.dispatched[conversationId];
    if (!record) return;
    // 核验期间如果已被手动标完成或产生了更新结果，迟到的核验不再覆写
    if (record.lastResult && record.lastResult.at >= slot.startedAt) return;
    recordResult(
      file,
      record,
      'goal-complete',
      now,
      detail,
      report,
      turnReport,
      goalView(slot, now)
    );
    saveEventFile(file, now);
    ports.publish();
    flush(now);
  }

  const host: SecretaryHost = {
    onAgentEvent(event, changes) {
      if (!ports.enabled()) return;
      // 没打开的会话（重启认回的命令）任务变了：只补判它要不要收回归档
      if (event.type === 'unopened-background-tasks') {
        sweepArchive([event.sessionId], ports.now());
        return;
      }
      const sessionId = sessionIdOf(event);
      // 没有身份也没有状态变化的事件与派出会话无关，不读盘
      if (!sessionId && changes.length === 0) return;
      if (sessionId && ports.contact && ports.isSecretaryConversation?.(sessionId)) {
        forwardToContact(event, sessionId);
      }
      if (
        sessionId &&
        event.type === 'ask-request' &&
        event.ask?.relatesTo &&
        ports.isSecretaryConversation?.(sessionId)
      ) {
        ports.escalateNeedsUser?.(
          event.ask.relatesTo,
          event.ask.relatesTo.needsUserIndex === undefined ? undefined : event.ask.question
        );
      }
      if (
        sessionId &&
        event.type === 'ask-resolved' &&
        event.by === 'user' &&
        event.relatesTo &&
        event.askedAt !== undefined &&
        event.answer?.trim() &&
        ports.isSecretaryConversation?.(sessionId)
      ) {
        ports.answerNeedsUser?.(event.relatesTo, event.answer, event.askedAt);
      }
      if (sessionId && changes.length === 0 && STREAM_EVENTS.has(event.type) && ports.peekFile) {
        const view = ports.peekFile();
        if (
          !view.dispatched[sessionId] &&
          !view.dispatched[rootIdOf(event, sessionId)] &&
          view.inflight?.secretaryConversationId !== sessionId
        )
          return;
      }
      const now = ports.now();
      const touched = new Set<string>(changes.map((change) => change.sessionId));
      if (sessionId) touched.add(sessionId);

      // 先结算在途投递（自己读改写），再读最新状态记结果，避免用旧快照覆盖结算结果
      const inflight = (ports.peekFile?.() ?? ports.file()).inflight;
      if (inflight && touched.has(inflight.secretaryConversationId)) {
        const outcome = deliveryOutcome(event, inflight);
        if (outcome) settleDelivery(ports, inflight.secretaryConversationId, outcome, now);
      }

      const file = withEventStamps(ports.file());
      const rows = ports.rows();
      if (sessionId) touched.add(rootIdOf(event, sessionId));
      let changed = applyRelayEvent(file, event, sessionId, now);
      for (const conversationId of touched) {
        const record = file.dispatched[conversationId];
        if (!record) continue;
        const status = ports.status(conversationId);
        const own = sessionId === conversationId;
        const upstreamRetry = upstreamRetryOf(rows[conversationId]);
        if (own && (event.type === 'turn-completed' || event.type === 'turn-failed')) {
          record.turn += 1;
          delete record.failurePending;
        }
        if (own && event.type === 'turn-failed' && upstreamRetry) {
          record.lastText = upstreamWaitingSummary(upstreamRetry);
          record.lastState = 'idle';
          changed = true;
        }
        if (own && event.type === 'goal-signal' && event.kind === 'complete') {
          pendingComplete.add(conversationId);
          if (event.result) startGoalVerify(conversationId, event.result, now);
        }
        if (
          own &&
          (event.type === 'turn-failed' || (event.type === 'turn-completed' && event.aborted))
        ) {
          pendingComplete.delete(conversationId);
          cancelGoalVerify(conversationId);
        }
        record.lastEventAt = now;
        eventStamps.set(conversationId, now);
        const resumedLive =
          status.state === 'running' ||
          ports.subagentsRunning?.(conversationId) === true ||
          event.type === 'turn-completed' ||
          event.type === 'turn-failed' ||
          event.type === 'goal-signal' ||
          event.type === 'ask-request' ||
          event.type === 'approval-request';
        if (resumedLive) coldResumePending.delete(conversationId);
        const runningNow =
          (status.state === 'running' || ports.subagentsRunning?.(conversationId) === true) &&
          !(own && event.type === 'turn-completed' && event.aborted);
        if (runningNow && clearStaleStoppedOnLive(record)) changed = true;
        // 冷启动续跑中先到 parent-ready/idle：别把看板状态翻回 idle，等续跑轮次真正起来或失败/超时
        const holdResumingState =
          coldResumePending.has(conversationId) &&
          status.state === 'idle' &&
          event.type !== 'parent-rejected';
        const effectiveState = holdResumingState ? 'running' : status.state;
        if (record.lastState !== effectiveState) record.stateSince = now;
        record.lastState = effectiveState;
        // 报错的会话不会再被后台任务唤醒，残留的记录会让它一直被算在跑
        if (status.state === 'error') {
          delete record.backgroundRunning;
          delete record.backgroundPersistent;
        }
        if (
          event.type === 'background-tasks-level' &&
          conversationId === rootIdOf(event, sessionId ?? conversationId)
        ) {
          applyTasks(record, event.tasks, now);
        }
        // 完整正文只用来认分支与提交号，记录与落盘都按 lastText 截断
        const report = own ? assistantTextOf(event) : undefined;
        const turnReport = own && event.type === 'turn-completed' ? event.report : undefined;
        const lastText = capLastText(report);
        if (lastText) record.lastText = lastText;
        // 有了可见回复：助手文字，或任何工具调用。发消息后的无回复兜底到此为止
        if (own && visibleReply(event)) delete record.sentAt;

        const change = changes.find((entry) => entry.sessionId === conversationId);
        if (change && change.state !== 'error') delete record.failurePending;
        // 会话处于运行态（含重启续跑无边沿变化）：清掉过时历史结果，避免旧结果把运行中会话拉回「需要你」
        if (status.state === 'running' && record.lastResult?.manual !== true) {
          if (change?.state === 'running' && change.previous !== 'running') {
            delete record.stoppedAt;
            delete record.failurePending;
            if (record.lastResult?.kind === 'goal-complete' && hasNeedsUser(record.goalResult)) {
              delete record.lastResult;
              delete record.goalResult;
            }
          }
          if (record.lastResult && record.lastResult.kind !== 'goal-complete')
            delete record.lastResult;
        }
        // 用户在会话界面主动中止：停之前没交过完成结果的按「已停止」收口，不算失败
        if (own && event.type === 'turn-completed' && event.aborted) {
          delete record.failurePending;
          if (record.lastResult?.kind !== 'goal-complete') {
            record.stoppedAt = now;
            delete record.backgroundRunning;
            delete record.reopenedAt;
            delete record.stalledTurn;
            delete record.patrol;
            if (record.lastResult) delete record.lastResult;
          }
        }
        // 空闲时命令直接抛错只有 status=failed、不会再有 turn-failed：先挂起等配对，到点补记。
        // 正在跑或等人时的 status=failed 不终止这一轮，之后照常有终态，不挂。
        if (
          own &&
          event.type === 'status' &&
          event.status === 'failed' &&
          change?.state === 'error' &&
          change.previous === 'idle' &&
          awaitsOutcome(record) &&
          record.lastResult?.manual !== true &&
          !(record.stoppedAt !== undefined && record.reopenedAt === undefined)
        ) {
          const failure = failureDetail(event.error);
          record.failurePending = { at: now, ...(failure ? { detail: failure } : {}) };
          armFailureTimer();
        }
        // 这一轮结束就不再是「被唤起、还没收尾」：之后按空闲状态判定
        const reopened = record.reopenedAt !== undefined;
        if (own && (event.type === 'turn-completed' || event.type === 'turn-failed'))
          delete record.reopenedAt;
        let kind: SecretaryResultKind | null = null;
        /** 中断原因：秘书收到的回传里要说清是应用被关掉，而不是模型出错 */
        let detail: string | undefined;
        if (own) {
          const resultEvent = resultEventOf(event, rows[conversationId]);
          if (
            resultEvent?.type === 'turn-completed' &&
            event.type === 'turn-completed' &&
            !event.aborted &&
            pendingComplete.delete(conversationId)
          ) {
            resultEvent.goalCompleted = true;
          }
          if (resultEvent) kind = classify(record, resultEvent, status);
          // 会话没能启动（spawn 被拒）：没有任何轮次事件，在这里记一次失败。
          // STALE 是发给已不在 worker 的会话的命令被拒，不是会话本身出错
          // 排队会话的启动失败由启动泵自己标记并回传，这里不再记一次
          if (
            !kind &&
            event.type === 'parent-rejected' &&
            !event.reason.startsWith(STALE_SESSION_ERROR) &&
            !queuedStartOf(rows[conversationId]) &&
            awaitsOutcome(record)
          ) {
            const wasColdResuming = coldResumePending.delete(conversationId);
            kind = wasColdResuming ? 'interrupted' : 'failed';
            detail = wasColdResuming
              ? `应用重启后自动续跑失败：${failureDetail(event.reason) ?? '原因未知'}`
              : `会话没能启动：${failureDetail(event.reason) ?? '原因未知'}`;
            delete record.reopenedAt;
          }
          // 秘书追加任务唤起的这一轮：目标停在受阻或暂停不会续跑，这一轮结束就是停下了，照常报。
          // 这一轮已经有了结果（如又报了受阻）就不再盖掉
          if (
            !kind &&
            reopened &&
            record.lastResult === undefined &&
            resultEvent?.type === 'turn-completed' &&
            !resultEvent.aborted &&
            (resultEvent.goalStatus === 'blocked' || resultEvent.goalStatus === 'paused')
          )
            kind = 'turn-ended';
          if (resultEvent?.type === 'turn-completed' && resultEvent.silentFinish)
            detail = silentFinishDetail(resultEvent.silentFinish);
          if (resultEvent?.type === 'turn-failed') detail = failureDetail(resultEvent.error);
          if (resultEvent?.type === 'turn-interrupted')
            detail = interruptReason({
              at: resultEvent.at,
              kind: resultEvent.kind,
              unfinishedTools: [],
              lang: 'zh',
            });
        }
        // status=failed 通常和随后的 turn-failed 成对出现，这里不记，避免同一次失败推两遍；
        // 等不到 turn-failed 的到点补记（failurePending）。worker 退出没有 turn-failed，仍靠状态变化记失败。
        if (!kind && !upstreamRetry && change && event.type !== 'status') {
          // worker 是所有会话共用的，它退出时空闲会话也会跳到 error；没在干活就不算失败
          if (
            change.state === 'error' &&
            (change.previous === 'running' || change.previous === 'waiting')
          )
            kind = 'failed';
          // 转交给秘书的提问不报 needs-user：秘书会答，用户也可能直接答
          else if (
            change.state === 'waiting' &&
            change.previous !== 'waiting' &&
            !(event.type === 'ask-request' && event.ask?.relay)
          )
            kind = 'needs-user';
        }
        // 写进恢复清单、新实例接着跑：退出打断这一轮既不是失败也不是中断
        if (
          (kind === 'failed' || kind === 'interrupted') &&
          ports.continuesAfterExit?.(conversationId)
        ) {
          kind = null;
          detail = undefined;
        }
        const awaiting = kind === 'turn-ended' && awaitsWake(conversationId, now);
        let readyGoal: GoalResultView | undefined;
        let goalDeferred = false;
        if (kind === 'goal-complete') {
          const slot = goalVerifies.get(conversationId);
          if (slot && !slot.cancelled) {
            if (slot.done) {
              readyGoal = goalView(slot, now);
              goalVerifies.delete(conversationId);
            } else {
              slot.onDone = () =>
                finishGoalResult(conversationId, slot, now, detail, report, turnReport);
              kind = null;
              goalDeferred = true;
            }
          }
        }
        if (kind && !awaiting)
          recordResult(file, record, kind, now, detail, report, turnReport, readyGoal);
        else if (
          !goalDeferred &&
          own &&
          event.type === 'turn-completed' &&
          !event.aborted &&
          (awaiting || goalStatusOf(rows[conversationId]))
        ) {
          // 带目标或还在等后台命令、子代理的一轮结束不推给秘书，动态里仍按时间留一句；
          // 还没投出去的上一轮「结束」也已过时，一并撤掉
          if (awaiting)
            file.outbox = file.outbox.filter(
              (entry) =>
                !(
                  entry.kind === 'turn-ended' &&
                  'conversationId' in entry &&
                  entry.conversationId === conversationId
                )
            );
          remember(file, {
            at: now,
            conversationId,
            kind: 'turn-ended',
            text: record.lastText || '这一轮结束了',
          });
        }
        changed = true;
      }

      if (
        event.type === 'turn-completed' &&
        !event.aborted &&
        (event.silent === true ||
          (event.digest && shouldSilenceTurn(event.digest.userText, event.digest.assistantText)))
      ) {
        const ids = sessionIdsInUpdates(event.digest?.userText ?? '');
        for (const conversationId of ids) {
          if (!file.dispatched[conversationId]) continue;
          remember(file, {
            at: now,
            conversationId,
            kind: 'seen',
            text: '秘书已查看',
          });
        }
        ports.audit?.({
          at: now,
          secretaryConversationId: sessionId ?? null,
          op: 'update_silent',
          ok: true,
          ...(ids.length > 0 ? { detail: ids.join(',') } : {}),
        });
        changed = true;
      }

      const aborted = new Set<string>();
      if (sessionId && event.type === 'turn-completed' && event.aborted)
        aborted.add(rootIdOf(event, sessionId));
      // 用户或秘书发来消息都会让会话跑起来：自动归档的就此回到活跃中
      const woken = new Set(
        changes.filter((entry) => entry.state === 'running').map((entry) => entry.sessionId)
      );
      if (syncAutoArchive(file, touched, rows, now, woken)) changed = true;
      if (changed) changed = saveEventFile(file, now);
      const todosChanged = syncLinkedTodos(ports, file, rows, aborted);
      const reported = ports.reportPeerTodos?.() ?? false;
      if (changed || todosChanged || reported) ports.publish();
      flush(now);
      // 派出会话一轮结束、报错或停下：可能空出了名额
      const settled =
        (sessionId !== undefined &&
          (event.type === 'turn-completed' || event.type === 'turn-failed')) ||
        changes.some((entry) => entry.previous === 'running' && entry.state !== 'running');
      if (settled && [...touched].some((id) => file.dispatched[id] !== undefined))
        ports.drainQueued?.();
    },

    tick(now = ports.now()) {
      if (!ports.enabled()) return;
      const file = withEventStamps(ports.file());
      const records = Object.values(file.dispatched);
      const statuses: Record<string, SecretarySessionStatus> = {};
      for (const record of records)
        statuses[record.conversationId] = ports.status(record.conversationId);

      let changed = false;
      for (const record of records) {
        const status = statuses[record.conversationId];
        const resumeStartedAt = coldResumePending.get(record.conversationId);
        if (resumeStartedAt !== undefined) {
          if (
            record.lastState !== 'running' ||
            record.lastResult?.turn === record.turn ||
            status?.state === 'running' ||
            ports.subagentsRunning?.(record.conversationId) === true
          ) {
            coldResumePending.delete(record.conversationId);
            if (status?.state === 'running' || ports.subagentsRunning?.(record.conversationId)) {
              record.lastEventAt = Math.max(record.lastEventAt, now);
              if (clearStaleStoppedOnLive(record)) changed = true;
            }
          } else if (now - resumeStartedAt >= COLD_RESUME_TIMEOUT_MS) {
            coldResumePending.delete(record.conversationId);
            record.lastState = 'idle';
            record.stateSince = now;
            recordResult(file, record, 'interrupted', now, '应用重启后超时未恢复运行');
            changed = true;
            continue;
          } else if (status?.state === 'idle') {
            // 超时前保持看板「进行中」，不因尚未唤醒被误翻回 idle
            continue;
          }
        }
        if (!status || record.lastState === status.state) continue;
        record.stateSince = now;
        record.lastState = status.state;
        if (status.state === 'error') {
          delete record.backgroundRunning;
          delete record.backgroundPersistent;
        }
        changed = true;
      }
      for (const record of records) {
        const status = statuses[record.conversationId];
        if (
          (status?.state === 'running' ||
            ports.subagentsRunning?.(record.conversationId) === true) &&
          clearStaleStoppedOnLive(record)
        ) {
          changed = true;
        }
      }
      // 配对窗口的定时器没赶上（如刚好停掉）时兜底
      if (settleFailures(file, now)) changed = true;
      // 任务表是权威：常驻服务与遗留标记每分钟按它重算一次，跑过阈值也能及时升级
      if (refreshLeftovers(records, statuses, now)) changed = true;
      for (const { conversationId, turn } of stalled(records, statuses, now)) {
        const record = file.dispatched[conversationId];
        record.stalledTurn = turn;
        recordResult(file, record, 'stalled', now);
        changed = true;
      }
      for (const stall of ports.backgroundStalls?.(now) ?? []) {
        if (applyBackgroundStall(file, stall, now)) changed = true;
      }
      // 转交提问到点还没人答：按超时收尾。worker 自己的定时器也会收尾，这里兜住 worker 已经不在了的情况
      for (const relay of Object.values(file.relays ?? {})) {
        if (relay.status !== 'pending' || relay.expiresAt === undefined) continue;
        if (relay.expiresAt > now) continue;
        const closed = closeRelayAsk(
          file,
          { conversationId: relay.conversationId, askId: relay.askId, by: 'timeout' },
          now,
          labelOf(file, relay.conversationId)
        );
        if (!closed.update) continue;
        file.outbox = enqueueUpdate(file.outbox, closed.update);
        changed = true;
      }
      // 自动巡检：正常时什么都不推，异常时按会话与原因各推一次
      if (runPatrol(file, records, statuses, now)) changed = true;
      // 遗留任务巡检：已完成会话里还在跑的后台任务，每小时推一次，不自动杀
      if (runLeftoverPatrol(file, records, now)) changed = true;
      // 收口时还有后台任务、或当时正开着的会话：任务结束、切走后在这里补归档
      if (syncAutoArchive(file, Object.keys(file.dispatched), ports.rows(), now)) changed = true;
      for (const proposal of Object.values(file.proposals)) {
        const transitioned = transitionProposal(proposal, { type: 'expire' }, now);
        if (!transitioned.changed) continue;
        file.proposals[proposal.id] = transitioned.proposal;
        file.outbox = enqueueUpdate(file.outbox, proposalUpdate(transitioned.proposal, now));
        changed = true;
      }
      if (fireSchedules(file, now)) changed = true;
      if (expireFailedPending(file, now, (entry) => ports.audit?.(entry))) changed = true;
      if (changed) ports.save(file);
      const todosChanged = syncLinkedTodos(ports, file, ports.rows(), new Set());
      const reported = ports.reportPeerTodos?.() ?? false;
      const triageEnded = records.some((record) => {
        const result = record.lastResult;
        if (result?.kind !== 'goal-complete' || result.manual || result.dismissed) return false;
        if (!record.goalResult || !hasNeedsUser(record.goalResult)) return false;
        const deadline = needsUserTriageDeadline(record.goalResult);
        return deadline <= now && (lastTickAt === undefined || lastTickAt < deadline);
      });
      lastTickAt = now;
      if (changed || todosChanged || reported || triageEnded) ports.publish();
      // 系统定时是档案与待办的派生状态，每分钟重算一次；放在触发之后，否则刚到期的待办提醒先被重算删掉
      syncSystemSchedules(ports, ports.profile(), ports.todos());
      flush(now);
      // 等依赖的派发：判定与建会话都在 dispatch 模块里做，这里只把候选交过去
      const waiting = Object.values(file.pending ?? {})
        .filter((pending) => pending.status === 'waiting')
        .map((pending) => pending.id);
      if (waiting.length > 0) ports.startPending?.(waiting, now);
      // 每分钟兜底：名额的变化不一定都有事件（手动标完成、改上限、会话被删）
      ports.drainQueued?.();
    },

    recordBackgroundStalls(stalls, now = ports.now()) {
      if (!ports.enabled() || stalls.length === 0) return;
      const file = ports.file();
      let changed = false;
      for (const stall of stalls) {
        if (applyBackgroundStall(file, stall, now)) changed = true;
      }
      if (!changed) return;
      ports.save(file);
      ports.publish();
      flush(now);
    },

    flushNow(now = ports.now()) {
      if (!ports.enabled()) return;
      flush(now);
    },

    scheduleFlush(at?: number, now = ports.now()) {
      if (!ports.enabled()) return;
      if (at !== undefined && at > now) {
        armCoalesce(at, now);
        return;
      }
      flush(now);
    },

    onRestartResumeFailed(conversationId, error, now = ports.now()) {
      if (!ports.enabled()) return;
      coldResumePending.delete(conversationId);
      const file = ports.file();
      const record = file.dispatched[conversationId];
      if (!record) return;
      // 本轮已由 parent-rejected 等事件记过结果时不再重复推送
      if (record.lastResult?.turn === record.turn) return;
      const state = ports.status(conversationId).state;
      const nextState = state === 'running' ? 'idle' : state;
      if (record.lastState !== nextState) record.stateSince = now;
      record.lastState = nextState;
      recordResult(file, record, 'interrupted', now, `应用重启后自动续跑失败：${error}`);
      ports.save(file);
      syncLinkedTodos(ports, file, ports.rows(), new Set());
      ports.publish();
      flush(now);
    },

    sweepAutoArchive(now = ports.now()) {
      if (!ports.enabled()) return;
      sweepArchive(undefined, now);
    },

    recover() {
      if (!ports.enabled()) return;
      const now = ports.now();
      // 应用没运行期间错过的 cron 只算下一次，不补投
      const skipped = skipMissedCron(ports.schedules(), now);
      if (skipped.changed) {
        ports.saveSchedules(skipped.schedules);
        ports.publish();
      }
      const file = ports.file();
      let changed = false;
      // 重启后 worker 已经不在，挂起的提问没人等了：记录作废，免得秘书答到死提问上
      for (const relay of Object.values(file.relays ?? {})) {
        if (relay.status !== 'pending') continue;
        if (dropRelay(file, relay.conversationId, relay.askId)) {
          ports.audit?.({
            at: now,
            secretaryConversationId:
              file.dispatched[relay.conversationId]?.secretaryConversationId ?? null,
            op: 'ask_relay_cancel',
            targetId: relay.conversationId,
            ok: true,
            detail: `${relay.askId} restart`,
          });
          changed = true;
        }
      }
      for (const record of Object.values(file.dispatched)) {
        const failure = record.failurePending;
        if (!failure) continue;
        // 配对窗口里应用退出：这次失败还没报，启动时补报；冷启动接着跑的不算失败
        delete record.failurePending;
        changed = true;
        if (ports.coldResumed?.(record.conversationId)) continue;
        record.turn += 1;
        delete record.reopenedAt;
        recordResult(file, record, 'failed', now, failure.detail);
      }
      for (const record of Object.values(file.dispatched)) {
        // 冷启动正按恢复清单接着跑：即使之前被误标过 interrupted / idle，也恢复成进行中等待续跑
        if (ports.coldResumed?.(record.conversationId)) {
          if (record.lastState !== 'running') {
            record.lastState = 'running';
            record.stateSince = now;
            changed = true;
          }
          if (record.lastResult?.kind === 'interrupted') {
            delete record.lastResult;
            changed = true;
          }
          coldResumePending.set(record.conversationId, now);
          continue;
        }
        if (record.lastState !== 'running') continue;
        // 存量修正：记录还写着进行中，但会话已经空闲、没有后台任务与待处理项，
        // 最后一条结果又是终态——直接收回终态，升级后不用用户一个个点
        const status = ports.status(record.conversationId);
        if (
          !record.backgroundRunning &&
          status.state === 'idle' &&
          status.pendingAsks + status.pendingApprovals === 0 &&
          record.lastResult &&
          SETTLED_RESULTS.has(record.lastResult.kind)
        ) {
          record.lastState = 'idle';
          record.stateSince = now;
          delete record.reopenedAt;
          ports.audit?.({
            at: now,
            secretaryConversationId: record.secretaryConversationId,
            op: 'dispatch_settle',
            targetId: record.conversationId,
            ok: true,
            detail: `startup ${record.lastResult.kind}`,
          });
          changed = true;
          continue;
        }
        // 重启时 worker 已经不在了：不算失败，交给用户决定是否重派
        record.lastState = 'idle';
        record.stateSince = now;
        recordResult(
          file,
          record,
          'interrupted',
          now,
          ports.interruptDetail?.(record.conversationId) ?? '应用重启时未写入恢复清单，无法自动续跑'
        );
        changed = true;
      }
      // 一次性任务错过就在启动时补投一次
      if (fireSchedules(file, now)) changed = true;
      // 以前自动归档、启动时仍有后台任务的派出会话：收回到活跃中
      if (syncAutoArchive(file, Object.keys(file.dispatched), ports.rows(), now)) changed = true;
      if (changed) ports.save(file);
      const todosChanged = syncLinkedTodos(ports, file, ports.rows(), new Set());
      if (changed || todosChanged) ports.publish();
      syncSystemSchedules(ports, ports.profile(), ports.todos());
      recoverDeliveries(ports, now);
      flush(now);
    },

    start() {
      if (timer) return;
      host.recover();
      timer = setInterval(() => host.tick(), TICK_MS);
      timer.unref?.();
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      if (coalesceTimer) clearTimeout(coalesceTimer);
      coalesceTimer = null;
      coalesceAt = undefined;
      if (failureTimer) clearTimeout(failureTimer);
      failureTimer = null;
    },
  };
  return host;
}

function syncLinkedTodos(
  ports: SecretaryHostPorts,
  file: SecretaryDispatchFile,
  rows: Record<string, Record<string, unknown>>,
  aborted: ReadonlySet<string>
): boolean {
  const advanced = advanceTodos(
    ports.todos(),
    (conversationId) =>
      linkedTodoSession(
        file.dispatched[conversationId],
        rows[conversationId],
        ports.status(conversationId),
        aborted.has(conversationId),
        ports.subagentsRunning?.(conversationId) === true
      ),
    ports.now()
  );
  if (!advanced.changed) return false;
  ports.saveTodos(advanced.todos);
  return true;
}
