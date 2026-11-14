import type { SessionStatusPayload } from '@shared/extensionPlugins/events';
import { projectNameFromPath } from '@shared/projectName';
import { transitionProposal } from '@shared/secretary/policy';
import type { RendererAgentEvent } from '@shared/types/agent';
import type {
  DispatchRecord,
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
  capLastText,
  classify,
  enqueueUpdate,
  proposalUpdate,
  type ResultEvent,
  shouldNotify,
  stalled,
  updateKey,
} from './results';
import { fireDue, skipMissedCron, syncSystemSchedules } from './schedules';

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
  schedules(): SecretarySchedule[];
  saveSchedules(schedules: SecretarySchedule[]): void;
  notify(build: (lang: 'zh' | 'en') => { title: string; body: string }): void;
  publish(): void;
  now(): number;
}

export interface SecretaryHost {
  /** worker 事件入口：driver 与状态发布共用同一次 observe 结果 */
  onAgentEvent(event: RendererAgentEvent, changes: readonly SessionStatusPayload[]): void;
  tick(now?: number): void;
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

function goalStatusOf(row: Record<string, unknown> | undefined): string | undefined {
  const goal = row?.goal;
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return undefined;
  const status = (goal as Record<string, unknown>).status;
  return typeof status === 'string' ? status : undefined;
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

  function recordUpdate(
    record: DispatchRecord,
    kind: SecretaryResultKind,
    now: number
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
      text: [projectName, title, RESULT_LABELS[kind].zh].filter(Boolean).join(' · '),
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
    now: number
  ): void {
    record.lastResult = { kind, turn: record.turn, at: now };
    const update = recordUpdate(record, kind, now);
    file.outbox = enqueueUpdate(file.outbox, update);
    notifyResult(update, kind);
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
        record.lastEventAt = now;
        if (record.lastState !== status.state) record.stateSince = now;
        record.lastState = status.state;
        const lastText = own ? capLastText(assistantTextOf(event)) : undefined;
        if (lastText) record.lastText = lastText;

        const change = changes.find((entry) => entry.sessionId === conversationId);
        let kind: SecretaryResultKind | null = null;
        if (own) {
          const resultEvent = resultEventOf(event, rows[conversationId]);
          if (resultEvent) kind = classify(record, resultEvent, status);
        }
        if (!kind && change) {
          // worker 是所有会话共用的，它退出时空闲会话也会跳到 error；没在干活就不算失败
          if (
            change.state === 'error' &&
            (change.previous === 'running' || change.previous === 'waiting')
          )
            kind = 'failed';
          else if (change.state === 'waiting' && change.previous !== 'waiting') kind = 'needs-user';
        }
        if (kind) recordResult(file, record, kind, now);
        changed = true;
      }

      if (changed) {
        ports.save(file);
        ports.publish();
      }
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
      for (const { conversationId, turn } of stalled(records, statuses, now)) {
        const record = file.dispatched[conversationId];
        record.stalledTurn = turn;
        recordResult(file, record, 'stalled', now);
        changed = true;
      }
      for (const proposal of Object.values(file.proposals)) {
        const transitioned = transitionProposal(proposal, { type: 'expire' }, now);
        if (!transitioned.changed) continue;
        file.proposals[proposal.id] = transitioned.proposal;
        file.outbox = enqueueUpdate(file.outbox, proposalUpdate(transitioned.proposal, now));
        changed = true;
      }
      if (fireSchedules(file, now)) changed = true;
      if (changed) {
        ports.save(file);
        ports.publish();
      }
      // 系统定时是档案与待办的派生状态，每分钟重算一次；放在触发之后，否则刚到期的待办提醒先被重算删掉
      syncSystemSchedules(ports, ports.profile(), ports.todos());
      flush(now);
    },

    recover() {
      if (!ports.enabled()) return;
      const now = ports.now();
      // 应用没运行期间错过的 cron 只算下一次，不补投
      const skipped = skipMissedCron(ports.schedules(), now);
      if (skipped.changed) ports.saveSchedules(skipped.schedules);
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
      if (changed) {
        ports.save(file);
        ports.publish();
      }
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
    },
  };
  return host;
}
