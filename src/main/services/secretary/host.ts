import { BACKGROUND_STALL_DETAIL, type BackgroundStall } from '@shared/backgroundWatch';
import type { SessionStatusPayload } from '@shared/extensionPlugins/events';
import { projectNameFromPath } from '@shared/projectName';
import { transitionProposal } from '@shared/secretary/policy';
import { sessionIdsInUpdates, shouldSilenceTurn } from '@shared/secretary/silence';
import type { RendererAgentEvent } from '@shared/types/agent';
import type {
  DispatchRecord,
  SecretaryActivity,
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryProfile,
  SecretaryResultKind,
  SecretarySchedule,
  SecretaryTodo,
  SecretaryUpdate,
} from '@shared/types/secretary';
import {
  type DeliveryPorts,
  flushDeliveries,
  recoverDeliveries,
  settleDelivery,
} from './deliveries';
import type { SecretarySessionStatus } from './readers';
import {
  ACTIVITY_LIMIT,
  capLastText,
  classify,
  enqueueUpdate,
  goalStatusOf,
  isUrgentUpdate,
  linkedTodoSession,
  proposalUpdate,
  type ResultEvent,
  SETTLED_RESULTS,
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

export interface SecretaryHostPorts extends DeliveryPorts {
  enabled(): boolean;
  profile(): SecretaryProfile | null;
  todos(): SecretaryTodo[];
  saveTodos(todos: SecretaryTodo[]): void;
  schedules(): SecretarySchedule[];
  saveSchedules(schedules: SecretarySchedule[]): void;
  notify(build: (lang: 'zh' | 'en') => { title: string; body: string }): void;
  publish(): void;
  now(): number;
  /** 派出会话空闲等后台任务的看门狗；缺省表示没有 */
  backgroundStalls?(now: number): readonly BackgroundStall[];
  audit?(entry: SecretaryAuditEntry): void;
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
    case 'ask-request':
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

  function remember(file: SecretaryDispatchFile, entry: SecretaryActivity): void {
    file.activity = [...(file.activity ?? []), entry].slice(-ACTIVITY_LIMIT);
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
  ): SecretaryUpdate {
    const row = ports.rows()[record.conversationId];
    const project = ports.projects().find((candidate) => candidate.projectId === record.projectId);
    const projectName = project ? projectNameFromPath(project.canonicalPath) : '';
    const title = typeof row?.title === 'string' ? row.title : '';
    return {
      key: updateKey(record.conversationId, kind, record.turn),
      at: now,
      kind,
      conversationId: record.conversationId,
      secretaryConversationId: record.secretaryConversationId,
      text: [projectName, title, RESULT_LABELS[kind].zh, detail].filter(Boolean).join(' · '),
      ...(record.lastText ? { lastText: record.lastText } : {}),
    };
  }

  function notifyResult(update: SecretaryUpdate, kind: SecretaryResultKind): void {
    const profile = ports.profile();
    if (!profile || !shouldNotify(profile.notify, kind)) return;
    ports.notify((lang) => ({
      title: `${profile.name} · ${RESULT_LABELS[kind][lang]}`,
      body: update.text.slice(0, 100),
    }));
  }

  function recordResult(
    file: SecretaryDispatchFile,
    record: DispatchRecord,
    kind: SecretaryResultKind,
    now: number,
    detail?: string
  ): void {
    if (record.lastResult?.kind === kind && record.lastResult.turn === record.turn) return;
    record.lastResult = { kind, turn: record.turn, at: now };
    // 收口了就不会再有后台任务唤醒它；留着这条记录会让空闲会话一直被算在跑
    if (SETTLED_RESULTS.has(kind)) delete record.backgroundRunning;
    const update = recordUpdate(record, kind, now, detail);
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
    notifyResult(update, kind);
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

  /** 到点的定时进回传队列，与结果共用一次投递；返回是否改了 dispatch 文件 */
  function fireSchedules(file: SecretaryDispatchFile, now: number): boolean {
    const fired = fireDue(ports.schedules(), now);
    if (fired.changed) ports.saveSchedules(fired.schedules);
    if (fired.updates.length === 0) return false;
    file.outbox = fired.updates.reduce(enqueueUpdate, file.outbox);
    return true;
  }

  const host: SecretaryHost = {
    onAgentEvent(event, changes) {
      if (!ports.enabled()) return;
      const sessionId = sessionIdOf(event);
      // 没有身份也没有状态变化的事件与派出会话无关，不读盘
      if (!sessionId && changes.length === 0) return;
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
      let changed = false;
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
        const lastText = own ? capLastText(assistantTextOf(event)) : undefined;
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
          else if (change.state === 'waiting' && change.previous !== 'waiting') kind = 'needs-user';
        }
        if (kind) recordResult(file, record, kind, now);
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
