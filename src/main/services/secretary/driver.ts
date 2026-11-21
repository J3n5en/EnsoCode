import {
  BACKGROUND_WAKE_GRACE_MS,
  type BackgroundStall,
  backgroundWaitStall,
  backgroundWakeText,
  type WatchedBackgroundTask,
} from '@shared/backgroundWatch';
import type { ConversationsPatch } from '@shared/conversationsPatch';
import {
  applyHeadlessGoalSignal,
  applyHeadlessQueueAction,
  type HeadlessDelivery,
  type HeadlessGoal,
  type HeadlessQueuedMessage,
  type HeadlessSessionRuntime,
  onHeadlessIdle,
} from '@shared/pair/headlessQueue';
import type { RendererAgentEvent } from '@shared/types/agent';
import type { SecretaryAuditEntry } from '@shared/types/secretary';

/** 与 renderer 的 continueGoal 同口径：连续 3 轮没有新输出就停，防无界烧钱 */
export const NO_PROGRESS_LIMIT = 3;

export interface DriverSessionStatus {
  state: string;
  pendingAsks: number;
  pendingApprovals: number;
}

export type GoalAction = 'set' | 'pause' | 'resume' | 'clear';

/**
 * 派出会话的驱动者。行的 queuedMessages 与 goal 是两端共用的权威值，
 * 这里只从磁盘读、写回磁盘；压缩状态是运行时标记，不进持久化。
 */
export interface DispatchDriverPorts {
  row(conversationId: string): Record<string, unknown> | undefined;
  saveRuntime(conversationId: string, runtime: HeadlessSessionRuntime): void;
  status(conversationId: string): DriverSessionStatus;
  alive(conversationId: string): boolean;
  prompt(
    conversationId: string,
    delivery: HeadlessDelivery,
    deliveryId: string
  ): { ok: boolean; error?: string };
  newId(): string;
  /** 审计：投递被拒时记一条，消息不悄悄蒸发 */
  audit?(entry: SecretaryAuditEntry): void;
  /** 看门狗计时；缺省用墙钟。测试注入逻辑时钟 */
  now?(): number;
  /**
   * 空闲等待出现超时 / 进程已死 / 完成未唤醒后，过宽限再看一眼。
   * 由 Main 接上 host.tick 以外的短定时，避免干等下一分钟。
   */
  requestWatch?(): void;
}

export interface DispatchDriver {
  /** worker 事件入口：只处理 driver === 'main' 的行 */
  observe(event: RendererAgentEvent): void;
  /** 用户排队消息经账本写回 Main 后补投 */
  onConversationsMerged(patch: ConversationsPatch): void;
  goalAction(
    conversationId: string,
    action: GoalAction,
    text?: string
  ): { ok: boolean; error?: string };
  /**
   * 给已完成或没有目标的会话挂上新目标：落成与 session_create 同一种 active 目标，
   * 不另发续跑（消息本身会把会话跑起来，轮次结束后续跑接上）。
   * 原来的目标还没完成时拒绝，目标原样保留；状态在 replaceable 里的才替换，并交回旧目标。
   */
  attachGoal(
    conversationId: string,
    text: string,
    replaceable?: readonly string[]
  ): { ok: boolean; error?: string; replaced?: { text: string; status: string } };
  /** 看一眼后台等待：该醒的醒，并返回还没交给秘书的停滞 */
  watch(now: number): BackgroundStall[];
  /** 会话被停止：撤掉续跑与看门狗，之后不许再唤醒它 */
  forget(conversationId: string): void;
}

interface TrackedTask extends WatchedBackgroundTask {
  status: 'running' | 'done' | 'failed';
  dead: boolean;
  overdue: boolean;
}

interface PendingStall {
  taskId: string;
  reason: BackgroundStall['reason'];
  reported: boolean;
  consumed: boolean;
  promptedAt?: number;
}

/** 已投出、worker 还没回执的投递：被拒时凭它把消息放回队首 */
interface InflightDelivery {
  conversationId: string;
  delivery: HeadlessDelivery;
  item?: HeadlessQueuedMessage;
}

type Applied = { runtime: HeadlessSessionRuntime; deliver?: HeadlessDelivery };

function sessionIdOf(event: RendererAgentEvent): string | undefined {
  if (!('identity' in event) || !event.identity) return undefined;
  return 'sessionId' in event.identity ? event.identity.sessionId : undefined;
}

function queuedFrom(value: unknown): HeadlessQueuedMessage[] {
  if (!Array.isArray(value)) return [];
  const queued: HeadlessQueuedMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const message = item as Record<string, unknown>;
    if (typeof message.id !== 'string' || typeof message.text !== 'string') continue;
    queued.push({
      id: message.id,
      text: message.text,
      ...(Array.isArray(message.images)
        ? { images: message.images as HeadlessQueuedMessage['images'] }
        : {}),
      // 秘书排的消息带来源标记：驱动者写回整份队列时不能把它洗掉，否则秘书撤不回自己排的
      ...(message.origin === 'secretary' ? { origin: 'secretary' as const } : {}),
      ...(typeof message.by === 'string' ? { by: message.by } : {}),
      ...(typeof message.at === 'number' ? { at: message.at } : {}),
    });
  }
  return queued;
}

function goalFrom(value: unknown): HeadlessGoal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const goal = value as Record<string, unknown>;
  if (typeof goal.text !== 'string') return undefined;
  const status = goal.status;
  if (
    status !== 'active' &&
    status !== 'paused' &&
    status !== 'completed' &&
    status !== 'blocked' &&
    status !== 'waiting'
  )
    return undefined;
  return {
    text: goal.text,
    status,
    ...(typeof goal.note === 'string' ? { note: goal.note } : {}),
    autoTurns: typeof goal.autoTurns === 'number' ? goal.autoTurns : 0,
    ...(typeof goal.noProgressRuns === 'number' ? { noProgressRuns: goal.noProgressRuns } : {}),
    ...(typeof goal.lastOutput === 'string' ? { lastOutput: goal.lastOutput } : {}),
  };
}

function normalizeOutput(text: string | undefined): string {
  return (text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 无进展守卫：最终文本归一化后与上一轮相同或为空即计一次 */
function withProgress(
  runtime: HeadlessSessionRuntime,
  assistantText?: string
): HeadlessSessionRuntime {
  const goal = runtime.goal;
  if (goal?.status !== 'active') return runtime;
  const output = normalizeOutput(assistantText);
  const noProgress = output === '' || output === goal.lastOutput;
  const noProgressRuns = noProgress ? (goal.noProgressRuns ?? 0) + 1 : 0;
  const next = { ...runtime, goal: { ...goal, noProgressRuns, lastOutput: output } };
  if (noProgressRuns < NO_PROGRESS_LIMIT) return next;
  return {
    ...next,
    goal: {
      ...next.goal,
      status: 'paused',
      note: `no progress in ${NO_PROGRESS_LIMIT} consecutive runs`,
    },
  };
}

export function createDispatchDriver(ports: DispatchDriverPorts): DispatchDriver {
  /** 压缩状态只在 worker 事件里有，行里没有：按会话记在内存 */
  const compacting = new Map<string, boolean>();
  /** 这一轮空闲已经投过 goal 续跑：压缩结束不能再投一次，否则第二次 prompt 会把会话打成 error */
  const continued = new Set<string>();
  /**
   * 后台任务。等它们时不续跑，完成通知会自己唤醒会话。
   * 通知没到、进程没了或到了截止时间，由 watch 补一次唤醒并交给秘书报停滞。
   */
  const tasksBySession = new Map<string, Map<string, TrackedTask>>();
  /** 这一轮结束时还有后台任务：会话空闲是在等通知，不是做完了 */
  const awaiting = new Set<string>();
  const pending = new Map<string, PendingStall>();
  /** 超时或进程已死之后，完成通知已经把会话跑完一轮：还要报停滞，但不要再 prompt */
  const consumedWaits = new Set<string>();
  const watchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 投出去的投递：worker 回执 delivery-settled / delivery-rejected 时结算 */
  const inflight = new Map<string, InflightDelivery>();
  /** 自己写回触发的合并回调不能再投递，否则同一条消息发两遍 */
  let saving = false;

  function clock(): number {
    return ports.now?.() ?? Date.now();
  }

  function taskMap(conversationId: string): Map<string, TrackedTask> {
    let tasks = tasksBySession.get(conversationId);
    if (!tasks) {
      tasks = new Map();
      tasksBySession.set(conversationId, tasks);
    }
    return tasks;
  }

  function runningCount(conversationId: string): number {
    let count = 0;
    for (const task of taskMap(conversationId).values()) {
      if (task.status === 'running') count += 1;
    }
    return count;
  }

  function hasHardFailure(conversationId: string): boolean {
    for (const task of taskMap(conversationId).values()) {
      if (task.overdue || task.dead) return true;
    }
    return false;
  }

  function rememberTask(
    conversationId: string,
    raw: {
      taskId?: unknown;
      status?: unknown;
      deadlineAt?: unknown;
      alive?: unknown;
    },
    at: number
  ): void {
    if (typeof raw.taskId !== 'string' || raw.taskId.length === 0) return;
    const status =
      raw.status === 'done' || raw.status === 'failed' || raw.status === 'running'
        ? raw.status
        : 'running';
    const prev = taskMap(conversationId).get(raw.taskId);
    const deadlineAt =
      typeof raw.deadlineAt === 'number' && Number.isFinite(raw.deadlineAt)
        ? raw.deadlineAt
        : prev?.deadlineAt;
    // alive 缺省或 null = worker 看门狗还没探测过，按未知处理，绝不当成已退出；
    // 进程已死也只对还在跑的任务有意义，结束之后由完成通知收口。
    const dead = status === 'running' && (prev?.dead === true || raw.alive === false);
    const overdue =
      prev?.overdue === true ||
      ((status === 'running' || prev?.status === 'running') &&
        deadlineAt !== undefined &&
        at >= deadlineAt);
    const endedAt = status === 'running' ? undefined : (prev?.endedAt ?? at);
    const deadAt = dead ? (prev?.deadAt ?? at) : undefined;
    taskMap(conversationId).set(raw.taskId, {
      taskId: raw.taskId,
      status,
      dead,
      overdue,
      ...(deadlineAt !== undefined ? { deadlineAt } : {}),
      ...(deadAt !== undefined ? { deadAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
    });
  }

  function seedTasks(conversationId: string, row: Record<string, unknown> | undefined): void {
    if (tasksBySession.has(conversationId)) return;
    taskMap(conversationId);
    if (Array.isArray(row?.backgroundTasks)) {
      for (const task of row.backgroundTasks) {
        if (!task || typeof task !== 'object') continue;
        rememberTask(conversationId, task as { taskId?: unknown; status?: unknown }, clock());
      }
    }
  }

  /** 宽限后再看：完成通知若会到，这两秒内会话会离开 idle */
  function armWatch(conversationId: string): void {
    if (!ports.requestWatch || !awaiting.has(conversationId) || watchTimers.has(conversationId))
      return;
    const timer = setTimeout(() => {
      watchTimers.delete(conversationId);
      ports.requestWatch?.();
    }, BACKGROUND_WAKE_GRACE_MS);
    timer.unref?.();
    watchTimers.set(conversationId, timer);
  }

  function isContinuation(delivery: HeadlessDelivery | undefined): boolean {
    return delivery?.text.includes('<goal-continuation>') === true;
  }

  function runtimeOf(conversationId: string): HeadlessSessionRuntime | null {
    const row = ports.row(conversationId);
    if (row?.driver !== 'main') return null;
    seedTasks(conversationId, row);
    const status = ports.status(conversationId);
    return {
      status: status.state,
      started: ports.alive(conversationId),
      queued: queuedFrom(row.queuedMessages),
      ...(goalFrom(row.goal) ? { goal: goalFrom(row.goal) } : {}),
      pendingApprovals: status.pendingApprovals,
      pendingAsks: status.pendingAsks,
      compaction: compacting.get(conversationId) === true,
      abortRequested: false,
    };
  }

  function save(conversationId: string, runtime: HeadlessSessionRuntime): void {
    saving = true;
    try {
      ports.saveRuntime(conversationId, runtime);
    } finally {
      saving = false;
    }
  }

  /** 落盘后投递；投递失败把这一条放回队首或暂停目标，不能让消息蒸发 */
  function commit(
    conversationId: string,
    previous: HeadlessSessionRuntime,
    applied: Applied
  ): void {
    save(conversationId, applied.runtime);
    const delivery = applied.deliver;
    if (!delivery) return;
    const deliveryId = ports.newId();
    // 从队列里取出的那一条：被拒时原样放回队首，来源标记跟着回来
    const flushed = previous.queued.find(
      (item) => !applied.runtime.queued.some((next) => next.id === item.id)
    );
    inflight.set(deliveryId, {
      conversationId,
      delivery,
      ...(flushed ? { item: flushed } : {}),
    });
    const result = ports.prompt(conversationId, delivery, deliveryId);
    if (result.ok) return;
    inflight.delete(deliveryId);
    const error = result.error ?? 'prompt failed';
    // 投递失败的那一条放回队首：来源标记跟着回来，秘书还能撤回它
    save(conversationId, {
      ...applied.runtime,
      ...(flushed
        ? {
            queued: [
              {
                ...flushed,
                id: ports.newId(),
                text: delivery.text,
                ...(delivery.images ? { images: delivery.images } : {}),
              },
              ...applied.runtime.queued,
            ],
          }
        : {}),
      // worker 已不在：继续续跑只会一轮轮失败，先停住等用户
      ...(applied.runtime.goal
        ? {
            goal: {
              ...applied.runtime.goal,
              ...(applied.runtime.goal.status === 'active'
                ? { status: 'paused' as const, note: error }
                : {}),
            },
          }
        : {}),
    });
  }

  /** worker 回执拒收：消息放回队首（或暂停目标），审计记一条，绝不悄悄丢 */
  function requeue(conversationId: string, deliveryId: string): void {
    const pending = inflight.get(deliveryId);
    if (!pending) return;
    inflight.delete(deliveryId);
    const runtime = runtimeOf(conversationId);
    if (!runtime) return;
    const item = pending.item;
    save(conversationId, {
      ...runtime,
      ...(item ? { queued: [{ ...item, id: ports.newId() }, ...runtime.queued] } : {}),
      // 续跑没被接住：worker 侧没有新轮，先停住目标等用户
      ...(item || runtime.goal?.status !== 'active'
        ? {}
        : { goal: { ...runtime.goal, status: 'paused' as const, note: 'delivery rejected' } }),
    });
    ports.audit?.({
      at: clock(),
      secretaryConversationId: item?.by ?? null,
      op: 'delivery-rejected',
      targetId: conversationId,
      ok: false,
      detail: item ? 'requeued' : 'goal-paused',
    });
  }

  /** 该会话的投递已有结果（轮次收束）：不再等回执 */
  function forgetDeliveries(conversationId: string): void {
    for (const [deliveryId, pending] of inflight) {
      if (pending.conversationId === conversationId) inflight.delete(deliveryId);
    }
  }

  /** 空闲时才泵队列 / 续跑目标；轮次收束与压缩结束共用 */
  function settle(conversationId: string, runtime: HeadlessSessionRuntime): void {
    if (!runtime.started || runtime.status !== 'idle') return;
    pump(conversationId, runtime, !continued.has(conversationId));
  }

  /** 排队消息照投；goal 续跑一轮只投一次，且后台任务还在跑时不投 */
  function pump(
    conversationId: string,
    runtime: HeadlessSessionRuntime,
    allowContinue: boolean
  ): void {
    const applied = onHeadlessIdle(runtime);
    const continuation = isContinuation(applied.deliver);
    if (continuation && (!allowContinue || runningCount(conversationId) > 0)) return;
    if (continuation) continued.add(conversationId);
    commit(conversationId, runtime, applied);
  }

  function watchOne(conversationId: string, now: number): BackgroundStall | null {
    const status = ports.status(conversationId);
    for (const task of taskMap(conversationId).values()) {
      if (task.status === 'running' && task.deadlineAt !== undefined && now >= task.deadlineAt) {
        task.overdue = true;
      }
    }
    const decision = backgroundWaitStall(
      {
        awaiting: awaiting.has(conversationId),
        idle: status.state === 'idle',
        pendingUser: status.pendingAsks + status.pendingApprovals > 0,
        consumed:
          pending.get(conversationId)?.consumed === true || consumedWaits.has(conversationId),
        tasks: [...taskMap(conversationId).values()],
      },
      now
    );
    if (!decision) return null;
    let item = pending.get(conversationId);
    if (!item) {
      item = {
        taskId: decision.taskId,
        reason: decision.reason,
        reported: false,
        consumed: false,
      };
      pending.set(conversationId, item);
    }
    let reported: BackgroundStall | null = null;
    if (!item.reported) {
      item.reported = true;
      reported = { conversationId, taskId: item.taskId, reason: item.reason };
    }
    if (decision.wake && (item.promptedAt === undefined || now - item.promptedAt >= 60_000)) {
      const result = ports.prompt(
        conversationId,
        { kind: 'prompt', text: backgroundWakeText(decision.reason, item.taskId) },
        ports.newId()
      );
      if (result.ok) item.promptedAt = now;
    }
    if (item.reported && (item.consumed || consumedWaits.has(conversationId))) {
      awaiting.delete(conversationId);
      consumedWaits.delete(conversationId);
    }
    return reported;
  }

  return {
    observe(event) {
      const conversationId = sessionIdOf(event);
      if (!conversationId) return;
      const runtime = runtimeOf(conversationId);
      if (!runtime) return;

      if (event.type === 'delivery-rejected') {
        requeue(conversationId, event.deliveryId);
        return;
      }
      if (event.type === 'delivery-settled') {
        inflight.delete(event.deliveryId);
        return;
      }
      if (event.type === 'compaction') {
        compacting.set(conversationId, event.state !== 'end');
        // 压缩不发 turn-completed：压完再泵，否则排队消息会卡住
        if (event.state === 'end' && !event.abandoned) settle(conversationId, runtime);
        return;
      }
      if (event.type === 'task-started') {
        rememberTask(conversationId, event.task, clock());
        armWatch(conversationId);
        return;
      }
      if (
        event.type === 'task-ended' ||
        (event.type === 'task-output' && event.status !== 'running')
      ) {
        rememberTask(conversationId, { taskId: event.taskId, status: event.status }, clock());
        armWatch(conversationId);
        return;
      }
      if (event.type === 'background-tasks-level') {
        const seen = new Set<string>();
        const at = clock();
        for (const task of event.tasks) {
          if (!task || typeof task.taskId !== 'string') continue;
          seen.add(task.taskId);
          rememberTask(conversationId, task, at);
        }
        // 全量快照里消失的还在跑任务：进程侧已经收口，但完成通知未必送到
        for (const [taskId, task] of taskMap(conversationId)) {
          if (seen.has(taskId) || task.status !== 'running') continue;
          rememberTask(conversationId, { taskId, status: 'done' }, at);
        }
        armWatch(conversationId);
        return;
      }
      if (event.type === 'goal-signal') {
        // 与桌面会话一致：完成即撤下目标；共享的 headless 逻辑保留 completed 给手机端与 server run
        const next = applyHeadlessGoalSignal(runtime, event.kind, event.note);
        save(conversationId, event.kind === 'complete' ? { ...next, goal: undefined } : next);
        return;
      }
      if (event.type === 'turn-failed') {
        forgetDeliveries(conversationId);
        commit(
          conversationId,
          runtime,
          onHeadlessIdle({
            ...runtime,
            started: true,
            status: 'failed',
            ...(runtime.goal?.status === 'active'
              ? { goal: { ...runtime.goal, status: 'paused' as const, note: event.error } }
              : {}),
          })
        );
        return;
      }
      if (event.type !== 'turn-completed') return;
      forgetDeliveries(conversationId);
      // 中断的轮不续跑、不泵队列；压缩中的收束等压缩结束事件再收
      if (event.aborted || compacting.get(conversationId)) {
        // 本轮还没投过：压缩结束时允许补投一次
        if (!event.aborted) continued.delete(conversationId);
        return;
      }
      continued.delete(conversationId);
      if (runningCount(conversationId) > 0) {
        const item = pending.get(conversationId);
        // 上一轮失败已经叫醒并跑完，这次又开始等：允许再报一次
        if (item?.consumed) pending.delete(conversationId);
        awaiting.add(conversationId);
        armWatch(conversationId);
      } else {
        const item = pending.get(conversationId);
        if (item) item.consumed = true;
        if (hasHardFailure(conversationId) && !item?.reported) {
          // 看门狗还没报出去，会话却已经被完成通知跑完了：留到下一次 watch 只报不唤醒
          consumedWaits.add(conversationId);
        } else {
          awaiting.delete(conversationId);
          consumedWaits.delete(conversationId);
        }
      }
      const guarded = withProgress(runtime, event.digest?.assistantText);
      pump(
        conversationId,
        { ...guarded, started: true, status: 'idle', abortRequested: false },
        true
      );
    },

    onConversationsMerged(patch) {
      if (saving) return;
      const ids = Object.entries(patch.upserts)
        .filter(([, row]) => Array.isArray(row.set.queuedMessages))
        .map(([conversationId]) => conversationId);
      if (ids.length === 0) return;
      // 通知早于写回方落盘：此刻改行会被随后的整份写入覆盖，消息留在盘上下一轮再投一遍
      queueMicrotask(() => {
        for (const conversationId of ids) {
          const runtime = runtimeOf(conversationId);
          if (runtime && runtime.queued.length > 0) settle(conversationId, runtime);
        }
      });
    },

    attachGoal(conversationId, text, replaceable = []) {
      const runtime = runtimeOf(conversationId);
      if (!runtime) return { ok: false, error: 'not-main-driven' };
      // completed 不会留在行上（完成即撤下），这里只挡还活着的目标
      const live = runtime.goal?.status === 'completed' ? undefined : runtime.goal;
      if (live && !replaceable.includes(live.status)) return { ok: false, error: 'goal-active' };
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, error: 'empty goal' };
      save(conversationId, {
        ...runtime,
        goal: { text: trimmed, status: 'active', autoTurns: 0, noProgressRuns: 0 },
      });
      return { ok: true, ...(live ? { replaced: { text: live.text, status: live.status } } : {}) };
    },

    goalAction(conversationId, action, text) {
      const runtime = runtimeOf(conversationId);
      if (!runtime) return { ok: false, error: 'not-main-driven' };
      if (action === 'set' && !text?.trim()) return { ok: false, error: 'empty goal' };
      // 恢复即重置安全计数：人已过目（与 renderer 的 resumeGoal 同口径）
      const current: HeadlessSessionRuntime =
        action === 'resume' && runtime.goal
          ? {
              ...runtime,
              goal: {
                ...runtime.goal,
                autoTurns: 0,
                noProgressRuns: 0,
                lastOutput: undefined,
              },
            }
          : runtime;
      const applied: Applied = applyHeadlessQueueAction(
        current,
        action === 'set'
          ? { type: 'goal-set', sessionId: conversationId, text: text?.trim() ?? '' }
          : { type: `goal-${action}`, sessionId: conversationId },
        ports.newId
      );
      commit(conversationId, current, applied);
      return { ok: true };
    },

    watch(now) {
      const stalls: BackgroundStall[] = [];
      const ids = new Set<string>([...awaiting, ...pending.keys()]);
      for (const conversationId of ids) {
        const stall = watchOne(conversationId, now);
        if (stall) stalls.push(stall);
      }
      return stalls;
    },

    forget(conversationId) {
      awaiting.delete(conversationId);
      pending.delete(conversationId);
      consumedWaits.delete(conversationId);
      continued.delete(conversationId);
      tasksBySession.delete(conversationId);
      const timer = watchTimers.get(conversationId);
      if (timer) {
        clearTimeout(timer);
        watchTimers.delete(conversationId);
      }
      forgetDeliveries(conversationId);
    },
  };
}
