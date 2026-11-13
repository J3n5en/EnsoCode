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
  /** 自己写回触发的合并回调不能再投递，否则同一条消息发两遍 */
  let saving = false;

  function runtimeOf(conversationId: string): HeadlessSessionRuntime | null {
    const row = ports.row(conversationId);
    if (row?.driver !== 'main') return null;
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
    const result = ports.prompt(conversationId, delivery, ports.newId());
    if (result.ok) return;
    const error = result.error ?? 'prompt failed';
    const flushed = applied.runtime.queued.length < previous.queued.length;
    save(conversationId, {
      ...applied.runtime,
      ...(flushed
        ? {
            queued: [
              {
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

  /** 空闲时才泵队列 / 续跑目标；轮次收束与压缩结束共用 */
  function settle(conversationId: string, runtime: HeadlessSessionRuntime): void {
    if (!runtime.started || runtime.status !== 'idle') return;
    commit(conversationId, runtime, onHeadlessIdle(runtime));
  }

  return {
    observe(event) {
      const conversationId = sessionIdOf(event);
      if (!conversationId) return;
      const runtime = runtimeOf(conversationId);
      if (!runtime) return;

      if (event.type === 'compaction') {
        compacting.set(conversationId, event.state !== 'end');
        // 压缩不发 turn-completed：压完再泵，否则排队消息会卡住
        if (event.state === 'end' && !event.abandoned) settle(conversationId, runtime);
        return;
      }
      if (event.type === 'goal-signal') {
        save(conversationId, applyHeadlessGoalSignal(runtime, event.kind, event.note));
        return;
      }
      if (event.type === 'turn-failed') {
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
      // 中断的轮不续跑、不泵队列；压缩中的收束等压缩结束事件再收
      if (event.aborted || compacting.get(conversationId)) return;
      const guarded = withProgress(runtime, event.digest?.assistantText);
      commit(
        conversationId,
        runtime,
        onHeadlessIdle({
          ...guarded,
          started: true,
          status: 'idle',
          abortRequested: false,
        })
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
  };
}
