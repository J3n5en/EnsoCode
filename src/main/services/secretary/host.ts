import { BACKGROUND_STALL_DETAIL, type BackgroundStall } from '@shared/backgroundWatch';
import type { SessionStatusPayload } from '@shared/extensionPlugins/events';
import { projectNameFromPath } from '@shared/projectName';
import { shouldForwardMilestone } from '@shared/secretary/contact';
import { extractReportRefs } from '@shared/secretary/daily';
import { type PatrolFacts, patrolAnomalies, patrolIntervalMs } from '@shared/secretary/patrol';
import { transitionProposal } from '@shared/secretary/policy';
import { sessionIdsInUpdates, shouldSilenceTurn } from '@shared/secretary/silence';
import type { RendererAgentEvent } from '@shared/types/agent';
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
import { redactSecrets } from '../memory/distill';
import type { SecretaryContactPort } from './contact/service';
import {
  type DeliveryPorts,
  flushDeliveries,
  recoverDeliveries,
  settleDelivery,
} from './deliveries';
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
  SETTLED_RESULTS,
  sessionStateOf,
  shouldNotify,
  stalled,
  UPDATE_WINDOW_MS,
  updateKey,
} from './results';
import { fireDue, skipMissedCron, syncSystemSchedules } from './schedules';
import { advanceTodos } from './todoLifecycle';

const TICK_MS = 60_000;

const RESULT_LABELS: Record<SecretaryResultKind, { zh: string; en: string }> = {
  'goal-complete': { zh: '目标已完成', en: 'goal completed' },
  'goal-blocked': { zh: '目标受阻或已暂停', en: 'goal blocked or paused' },
  'turn-ended': { zh: '这一轮结束了，不代表完成', en: 'turn ended, not necessarily done' },
  'needs-user': { zh: '需要你处理', en: 'needs you' },
  failed: { zh: '失败', en: 'failed' },
  stalled: { zh: '超过十分钟没有动静', en: 'no activity for 10 minutes' },
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
  publish(): void;
  now(): number;
  /** 派出会话空闲等后台任务的看门狗；缺省表示没有 */
  backgroundStalls?(now: number): readonly BackgroundStall[];
  /** 依赖已经全部结束的等待派发：交给 dispatch 模块判定并建会话 */
  startPending?(pendingIds: readonly string[], now: number): void;
  audit?(entry: SecretaryAuditEntry): void;
  /** 追加一条按天回看用的结果记录；缺省表示不持久化 */
  recordDaily?(entry: SecretaryDailyRecord): void;
}

export interface SecretaryHost {
  /** worker 事件入口：driver 与状态发布共用同一次 observe 结果 */
  onAgentEvent(event: RendererAgentEvent, changes: readonly SessionStatusPayload[]): void;
  tick(now?: number): void;
  recordBackgroundStalls(stalls: readonly BackgroundStall[], now?: number): void;
  recover(): void;
  start(): void;
  stop(): void;
}

function sessionIdOf(event: RendererAgentEvent): string | undefined {
  if (!('identity' in event) || !event.identity) return undefined;
  return 'sessionId' in event.identity ? event.identity.sessionId : undefined;
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

function resultEventOf(
  event: RendererAgentEvent,
  row: Record<string, unknown> | undefined
): ResultEvent | null {
  switch (event.type) {
    case 'turn-completed': {
      const goalStatus = goalStatusOf(row);
      return {
        type: 'turn-completed',
        ...(event.aborted ? { aborted: true } : {}),
        ...(goalStatus ? { goalStatus } : {}),
      };
    }
    case 'turn-failed':
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

/** 只有正常结束才算投递成功；中止与报错都按失败重投 */
function deliveryOutcome(event: RendererAgentEvent): 'done' | 'failed' | null {
  if (event.type === 'turn-completed') return event.aborted ? 'failed' : 'done';
  if (event.type === 'turn-failed' || event.type === 'worker-exited') return 'failed';
  return null;
}

export function createSecretaryHost(ports: SecretaryHostPorts): SecretaryHost {
  let timer: ReturnType<typeof setInterval> | null = null;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let coalesceAt: number | undefined;
  /** goal_complete 先到、轮次还没结束：等 turn-completed 再报，避免会话还在跑就通知完成 */
  const pendingComplete = new Set<string>();
  /** 下一次自动巡检的时间；没有进行中的会话时清空，等于停掉巡检 */
  let patrolAt: number | undefined;

  /** 巡检异常的中文说明：与现有停滞检测分开措辞，秘书一眼能看出是自动巡检发现的 */
  const PATROL_DETAIL: Record<'idle-stalled' | 'running-stalled', string> = {
    'idle-stalled': '自动巡检：空闲超过 20 分钟，目标还没完成，也没有待处理项',
    'running-stalled': '自动巡检：运行超过 30 分钟没有任何事件',
  };

  function remember(file: SecretaryDispatchFile, entry: SecretaryActivity): void {
    file.activity = [...(file.activity ?? []), entry].slice(-ACTIVITY_LIMIT);
  }

  /** 会话的一句话标签：项目 · 标题，回传正文与卡片都用它 */
  function labelOf(file: SecretaryDispatchFile, conversationId: string): string {
    const record = file.dispatched[conversationId];
    const row = ports.rows()[conversationId];
    const project = record
      ? ports.projects().find((candidate) => candidate.projectId === record.projectId)
      : undefined;
    return sessionLabel(
      project ? projectNameFromPath(project.canonicalPath) : '',
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
      // 手机上也提示一条：J 哥不在电脑前时，回一句话就进秘书会话
      ports.contact?.onRelayAsk({
        conversationId,
        question: event.ask.question,
        ...(event.ask.options ? { options: event.ask.options } : {}),
        label: labelOf(file, conversationId),
      });
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
    detail?: string
  ): { update: SecretaryUpdate; title: string; projectName: string } {
    const row = ports.rows()[record.conversationId];
    const project = ports.projects().find((candidate) => candidate.projectId === record.projectId);
    const projectName = project ? projectNameFromPath(project.canonicalPath) : '';
    const title = typeof row?.title === 'string' ? row.title : '';
    const update: SecretaryUpdate = {
      key: updateKey(record.conversationId, kind, record.turn),
      at: now,
      kind,
      conversationId: record.conversationId,
      secretaryConversationId: record.secretaryConversationId,
      text: [projectName, title, RESULT_LABELS[kind].zh, detail].filter(Boolean).join(' · '),
      ...(record.lastText ? { lastText: record.lastText } : {}),
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
    // 与系统通知同一个 notify 口径，联系方式服务里再兜一次
    if (!shouldForwardMilestone(profile.notify, kind)) return;
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
    report?: string
  ): void {
    if (record.lastResult?.kind === kind && record.lastResult.turn === record.turn) return;
    record.lastResult = { kind, turn: record.turn, at: now };
    // 收口了就不会再有后台任务唤醒它；留着这条记录会让空闲会话一直被算在跑
    if (SETTLED_RESULTS.has(kind)) delete record.backgroundRunning;
    const { update, title, projectName } = recordUpdate(record, kind, now, detail);
    const previous = file.outbox.find(
      (entry) => 'conversationId' in entry && entry.conversationId === record.conversationId
    );
    if (!isUrgentUpdate(update)) {
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
    });
    rememberDaily(record, kind, now, title, report);
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
    report: string | undefined
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
    const live = records.filter((record) =>
      countsAsRunning(record, rows[record.conversationId], statuses[record.conversationId])
    );
    // 没有进行中的会话：巡检自己停下，等下一次有活再重新计时
    if (live.length === 0) {
      patrolAt = undefined;
      return changed;
    }
    if (patrolAt !== undefined && now < patrolAt) return changed;
    patrolAt = now + patrolIntervalMs(profile.patrolIntervalMinutes);
    const facts: PatrolFacts[] = live.map((record) => {
      const status = statuses[record.conversationId];
      const row = rows[record.conversationId];
      const state = sessionStateOf(record, row, status);
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
      };
    });
    for (const anomaly of patrolAnomalies(facts, now)) {
      const record = file.dispatched[anomaly.conversationId];
      if (!record) continue;
      record.patrol = { reason: anomaly.reason, turn: record.turn, at: now };
      recordResult(file, record, 'stalled', now, PATROL_DETAIL[anomaly.reason]);
      changed = true;
    }
    return changed;
  }

  /** 到点的定时进回传队列，与结果共用一次投递；返回是否改了 dispatch 文件 */
  function fireSchedules(file: SecretaryDispatchFile, now: number): boolean {
    const fired = fireDue(ports.schedules(), now);
    if (fired.changed) ports.saveSchedules(fired.schedules);
    if (fired.updates.length === 0) return false;
    file.outbox = fired.updates.reduce(enqueueUpdate, file.outbox);
    return true;
  }

  /**
   * 联系方式：秘书自己会话里的提问、回复与审批同步到手机。
   * 派出会话的提问走 ask-relay，在 applyRelayEvent 里另发一条，不在这里重复。
   */
  function forwardToContact(event: RendererAgentEvent, conversationId: string): void {
    const contact = ports.contact;
    if (!contact) return;
    if (event.type === 'ask-request' && event.ask && !event.ask.relay) {
      contact.onAskRequest(conversationId, event.ask);
      return;
    }
    if (event.type === 'ask-resolved') {
      contact.onAskResolved(conversationId, event.requestId);
      return;
    }
    if (event.type === 'approval-request') {
      contact.onCardWaiting({ count: 1 });
      return;
    }
    if (event.type === 'turn-completed' && !event.aborted && !event.silent) {
      const text = event.digest?.assistantText?.trim();
      if (text) contact.onTurnReply(conversationId, text);
    }
  }

  const host: SecretaryHost = {
    onAgentEvent(event, changes) {
      if (!ports.enabled()) return;
      const sessionId = sessionIdOf(event);
      // 没有身份也没有状态变化的事件与派出会话无关，不读盘
      if (!sessionId && changes.length === 0) return;
      if (sessionId && ports.contact && ports.isSecretaryConversation?.(sessionId)) {
        forwardToContact(event, sessionId);
      }
      const now = ports.now();
      const touched = new Set<string>(changes.map((change) => change.sessionId));
      if (sessionId) touched.add(sessionId);

      // 先结算在途投递（自己读改写），再读最新状态记结果，避免用旧快照覆盖结算结果
      const inflightTarget = ports.file().inflight?.secretaryConversationId;
      if (inflightTarget && touched.has(inflightTarget)) {
        const outcome = deliveryOutcome(event);
        if (outcome) settleDelivery(ports, inflightTarget, outcome, now);
      }

      const file = ports.file();
      const rows = ports.rows();
      if (sessionId) touched.add(rootIdOf(event, sessionId));
      let changed = applyRelayEvent(file, event, sessionId, now);
      for (const conversationId of touched) {
        const record = file.dispatched[conversationId];
        if (!record) continue;
        const status = ports.status(conversationId);
        const own = sessionId === conversationId;
        if (own && (event.type === 'turn-completed' || event.type === 'turn-failed')) {
          record.turn += 1;
        }
        if (own && event.type === 'goal-signal' && event.kind === 'complete') {
          pendingComplete.add(conversationId);
        }
        if (
          own &&
          (event.type === 'turn-failed' || (event.type === 'turn-completed' && event.aborted))
        ) {
          pendingComplete.delete(conversationId);
        }
        record.lastEventAt = now;
        if (record.lastState !== status.state) record.stateSince = now;
        record.lastState = status.state;
        // 报错的会话不会再被后台任务唤醒，残留的记录会让它一直被算在跑
        if (status.state === 'error') delete record.backgroundRunning;
        if (
          event.type === 'background-tasks-level' &&
          conversationId === rootIdOf(event, sessionId ?? conversationId)
        ) {
          const backgroundRunning = event.tasks.some((task) => task.status === 'running');
          if (backgroundRunning) record.backgroundRunning = true;
          else delete record.backgroundRunning;
        }
        // 完整正文只用来认分支与提交号，记录与落盘都按 lastText 截断
        const report = own ? assistantTextOf(event) : undefined;
        const lastText = capLastText(report);
        if (lastText) record.lastText = lastText;

        const change = changes.find((entry) => entry.sessionId === conversationId);
        let kind: SecretaryResultKind | null = null;
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
        }
        // status=failed 总是和随后的 turn-failed 成对出现；这里再记一次会把同一次失败推两遍。
        // worker 退出没有 turn-failed，仍靠状态变化记失败。
        if (!kind && change && event.type !== 'status') {
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
        if (kind) recordResult(file, record, kind, now, undefined, report);
        else if (
          own &&
          event.type === 'turn-completed' &&
          !event.aborted &&
          goalStatusOf(rows[conversationId])
        ) {
          // 带目标的一轮结束本身不推给秘书，动态里仍按时间留一句
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
      if (changed) ports.save(file);
      const todosChanged = syncLinkedTodos(ports, file, rows, aborted);
      if (changed || todosChanged) ports.publish();
      flush(now);
    },

    tick(now = ports.now()) {
      if (!ports.enabled()) return;
      const file = ports.file();
      const records = Object.values(file.dispatched);
      const statuses: Record<string, SecretarySessionStatus> = {};
      for (const record of records)
        statuses[record.conversationId] = ports.status(record.conversationId);

      let changed = false;
      for (const record of records) {
        const status = statuses[record.conversationId];
        if (!status || record.lastState === status.state) continue;
        record.stateSince = now;
        record.lastState = status.state;
        if (status.state === 'error') delete record.backgroundRunning;
        changed = true;
      }
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
      for (const proposal of Object.values(file.proposals)) {
        const transitioned = transitionProposal(proposal, { type: 'expire' }, now);
        if (!transitioned.changed) continue;
        file.proposals[proposal.id] = transitioned.proposal;
        file.outbox = enqueueUpdate(file.outbox, proposalUpdate(transitioned.proposal, now));
        changed = true;
      }
      if (fireSchedules(file, now)) changed = true;
      if (changed) ports.save(file);
      const todosChanged = syncLinkedTodos(ports, file, ports.rows(), new Set());
      if (changed || todosChanged) ports.publish();
      // 系统定时是档案与待办的派生状态，每分钟重算一次；放在触发之后，否则刚到期的待办提醒先被重算删掉
      syncSystemSchedules(ports, ports.profile(), ports.todos());
      flush(now);
      // 等依赖的派发：判定与建会话都在 dispatch 模块里做，这里只把候选交过去
      const waiting = Object.values(file.pending ?? {})
        .filter((pending) => pending.status === 'waiting')
        .map((pending) => pending.id);
      if (waiting.length > 0) ports.startPending?.(waiting, now);
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
        if (record.lastState !== 'running') continue;
        // 重启时 worker 已经不在了：不算失败，交给用户决定是否重派
        record.lastState = 'idle';
        record.stateSince = now;
        recordResult(file, record, 'interrupted', now);
        changed = true;
      }
      // 一次性任务错过就在启动时补投一次
      if (fireSchedules(file, now)) changed = true;
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
        aborted.has(conversationId)
      ),
    ports.now()
  );
  if (!advanced.changed) return false;
  ports.saveTodos(advanced.todos);
  return true;
}
