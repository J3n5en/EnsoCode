import type { LoadedImage, UnavailableImage } from '@shared/secretary/attachments';
import { parseProfile } from '@shared/secretary/parse';
import {
  type QueuedStart,
  queuedStartOf,
  queueOwnerOf,
  queuePositions,
} from '@shared/secretary/queuedSession';
import type { AttachedImage } from '@shared/types/agent';
import type { SecretaryUpdate } from '@shared/types/secretary';
import type { SessionWorktree } from '@shared/types/worktree';
import { classifyUpstreamError, nextPendingRetryDelayMs } from '@shared/upstreamRecovery';
import { redactSecrets } from '../memory/distill';
import { notifySecretaryChanged, runningCount, type SecretaryDispatchPorts } from './dispatch';
import { enqueueUpdate } from './results';
import { type LaunchPorts, launchSession } from './sessionFactory';
import { markTodoProblem } from './todoLifecycle';

/**
 * 排队会话的启动泵。权威状态是会话行上的 queuedStart：有它就是排队会话。
 * 自动启动、手动「立即开始」与取消都排在同一条串行链上，任何时刻至多一个在进行；
 * 拿到链后从盘上重读行，spawn 前先把 startingAt 落盘作为认领，重启时据此恢复。
 */

export interface QueuedOwner {
  id: string;
  dispatch: SecretaryDispatchPorts;
}

export interface QueuedSessionPorts {
  launch: LaunchPorts;
  rows(): Readonly<Record<string, Record<string, unknown>>>;
  /** 同步读改写一行（一次落盘）；update 返回 null 表示不改。返回写入后的行，没改返回 null */
  updateRow(
    id: string,
    update: (row: Record<string, unknown>) => Record<string, unknown> | null
  ): Record<string, unknown> | null;
  removeWorktree(record: SessionWorktree): Promise<void>;
  removeRow(id: string): void;
  removeConversation(id: string): void;
  /** 管这个排队会话的秘书；已被删除时 null */
  owner(secretaryId: string): QueuedOwner | null;
  owners(): readonly QueuedOwner[];
  /** 全部秘书合计上限 */
  maxTotal(): number;
  loadAttachments(
    paths: readonly string[]
  ): Promise<{ images: LoadedImage[]; unavailable?: UnavailableImage[] }>;
  /** 回传队列里有了新条目：让这个秘书立刻试投 */
  flush?(secretaryId: string): void;
  /** agent 确实起来过（权威记录上有会话文件）；缺省只看行上的 sessionFile */
  agentStarted?(conversationId: string): boolean;
  now(): number;
  newId(): string;
}

export type QueuedActionResult = { ok: true } | { ok: false; error: string };

export interface QueuedFollowUp {
  text: string;
  images?: AttachedImage[];
}

export interface QueuedSessions {
  /** 有空位就按先进先出启动；并发调用合并成一次 */
  drain(): Promise<void>;
  /** 立即开始：不看上限；followUp 排在首条消息之后送达 */
  start(conversationId: string, followUp?: QueuedFollowUp): Promise<QueuedActionResult>;
  /** 取消：直接删掉这个还没开始的会话；已开始或正在启动的拒绝 */
  cancel(conversationId: string, by: string | null): Promise<QueuedActionResult>;
  /** 启动时：认领过但没收尾的，agent 已起来就按已启动收尾，否则放回队列 */
  recover(): void;
}

function defaultMax(): number {
  return parseProfile({})?.maxRunningDispatches ?? 3;
}

export function createQueuedSessions(ports: QueuedSessionPorts): QueuedSessions {
  let chain: Promise<unknown> = Promise.resolve();
  let drainQueued: Promise<void> | null = null;

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  }

  function ownerOf(row: unknown): QueuedOwner | null {
    return ports.owner(queueOwnerOf(row));
  }

  function push(
    owner: QueuedOwner,
    conversationId: string,
    status: 'failed' | 'cancelled',
    text: string
  ): void {
    const file = owner.dispatch.dispatchFile();
    const record = file.dispatched[conversationId];
    const at = ports.now();
    const update: SecretaryUpdate = {
      key: `queued:${conversationId}:${status}:${at}`,
      at,
      text,
      kind: 'queued',
      conversationId,
      status,
      ...(record ? { secretaryConversationId: record.secretaryConversationId } : {}),
    };
    file.outbox = enqueueUpdate(file.outbox, update);
    owner.dispatch.saveDispatch(file);
    ports.flush?.(owner.id);
  }

  function titleOf(row: Record<string, unknown> | undefined, conversationId: string): string {
    return typeof row?.title === 'string' && row.title ? row.title : conversationId;
  }

  /** spawn 与首条消息都成功：撤掉排队标记、挂上目标、派发记录标运行中 */
  function finishStarted(conversationId: string, queued: QueuedStart, manual: boolean): void {
    const now = ports.now();
    const row = ports.updateRow(conversationId, (current) => {
      const { queuedStart: _queued, ...rest } = current;
      return {
        ...rest,
        ...(queued.goal
          ? { goal: { text: queued.goal, status: 'active', autoTurns: 0, noProgressRuns: 0 } }
          : {}),
      };
    });
    const owner = ownerOf(row);
    if (!owner) return;
    const file = owner.dispatch.dispatchFile();
    const record = file.dispatched[conversationId];
    if (record) {
      record.lastState = 'running';
      record.stateSince = now;
      record.lastEventAt = now;
      delete record.stoppedAt;
      delete record.lastResult;
      owner.dispatch.saveDispatch(file);
    }
    owner.dispatch.audit({
      at: now,
      secretaryConversationId: record?.secretaryConversationId ?? null,
      op: 'queued_start',
      targetId: conversationId,
      ok: true,
      detail: manual ? 'manual' : 'auto',
    });
  }

  /** 启动失败：会话与 worktree 保留，移出自动队列，等用户立即开始或取消 */
  function markFailed(conversationId: string, error: string, manual: boolean): void {
    const now = ports.now();
    const row = ports.updateRow(conversationId, (current) => {
      const queued = queuedStartOf(current);
      if (!queued) return null;
      const { startingAt: _startingAt, ...rest } = queued;
      return { ...current, queuedStart: { ...rest, failed: { at: now, error } } };
    });
    const owner = ownerOf(row);
    if (!owner) return;
    owner.dispatch.audit({
      at: now,
      secretaryConversationId:
        owner.dispatch.dispatchFile().dispatched[conversationId]?.secretaryConversationId ?? null,
      op: 'queued_start',
      targetId: conversationId,
      ok: false,
      detail: `${manual ? 'manual' : 'auto'} ${error}`,
    });
    push(
      owner,
      conversationId,
      'failed',
      `${titleOf(row ?? undefined, conversationId)} · 排队的会话没能启动：${redactSecrets(error)}。会话和 worktree 都还在，等用户立即开始或取消`
    );
  }

  /** 自动启动遇瞬态错误：退避放回排队，最多重试 5 次；超过上限或永久错误再 markFailed */
  function deferOrFail(conversationId: string, error: string, manual: boolean): void {
    if (!manual) {
      const now = ports.now();
      const classified = classifyUpstreamError({ error }, now);
      if (classified.kind !== 'permanent') {
        let deferredAttempt: number | undefined;
        const row = ports.updateRow(conversationId, (current) => {
          const queued = queuedStartOf(current);
          if (!queued) return null;
          const nextAttempt = (queued.retryCount ?? 0) + 1;
          const delay = nextPendingRetryDelayMs(nextAttempt);
          if (delay === null) return null;
          deferredAttempt = nextAttempt;
          const { startingAt: _startingAt, failed: _failed, ...rest } = queued;
          return {
            ...current,
            queuedStart: {
              ...rest,
              retryCount: nextAttempt,
              nextRetryAt: now + delay,
              lastError: error,
            },
          };
        });
        if (deferredAttempt !== undefined) {
          const owner = ownerOf(row);
          owner?.dispatch.audit({
            at: now,
            secretaryConversationId:
              owner.dispatch.dispatchFile().dispatched[conversationId]?.secretaryConversationId ??
              null,
            op: 'queued_start',
            targetId: conversationId,
            ok: false,
            detail: `transient-retry ${deferredAttempt} ${error}`,
          });
          return;
        }
      }
    }
    markFailed(conversationId, error, manual);
  }

  async function startLocked(
    conversationId: string,
    manual: boolean,
    followUp?: QueuedFollowUp
  ): Promise<QueuedActionResult> {
    const now = ports.now();
    let claimed: QueuedStart | undefined;
    const row = ports.updateRow(conversationId, (current) => {
      const queued = queuedStartOf(current);
      if (!queued || queued.startingAt !== undefined) return null;
      if (queued.failed && !manual) return null;
      claimed = queued;
      const { failed: _failed, ...rest } = queued;
      const queue = Array.isArray(current.queuedMessages) ? current.queuedMessages : [];
      return {
        ...current,
        queuedStart: { ...rest, startingAt: now },
        // 排队期间用户发的消息：进会话自己的队列，首轮结束后由驱动者投递，必然在首条之后
        ...(followUp
          ? {
              queuedMessages: [
                ...queue,
                {
                  id: ports.newId(),
                  text: followUp.text,
                  at: now,
                  ...(followUp.images?.length ? { images: followUp.images } : {}),
                },
              ],
            }
          : {}),
      };
    });
    if (!row || !claimed) return { ok: false, error: 'not-queued' };
    const queued: QueuedStart = claimed;
    notifySecretaryChanged();
    try {
      const attachments = queued.attachments?.length
        ? await ports.loadAttachments(queued.attachments)
        : undefined;
      const launched = await launchSession(ports.launch, row, {
        text: queued.text,
        ...(queued.goal ? { goal: queued.goal } : {}),
        ...(attachments ? { attachments } : {}),
        ...(queued.askRelay ? { askRelay: queued.askRelay } : {}),
      });
      if (launched.ok) finishStarted(conversationId, queued, manual);
      else deferOrFail(conversationId, launched.error, manual);
      return launched;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deferOrFail(conversationId, message, manual);
      return { ok: false, error: message };
    } finally {
      notifySecretaryChanged();
    }
  }

  /** 下一条该自动启动的：各秘书有空位、合计也没满，按排队时间最早的先来 */
  async function nextToStart(skip: ReadonlySet<string>): Promise<string | null> {
    const rows = ports.rows();
    const now = ports.now();
    const positions = queuePositions(rows);
    const heads = new Map<string, { id: string; at: number }>();
    for (const [id, position] of positions) {
      const queued = queuedStartOf(rows[id]);
      if (!queued || queued.startingAt !== undefined || skip.has(id)) continue;
      if (queued.nextRetryAt !== undefined && now < queued.nextRetryAt) continue;
      const owner = queueOwnerOf(rows[id]);
      const head = heads.get(owner);
      const at = queued.queuedAt;
      if (!head || position < (positions.get(head.id) ?? Number.POSITIVE_INFINITY))
        heads.set(owner, { id, at });
    }
    if (heads.size === 0) return null;
    let total = 0;
    const free = new Map<string, boolean>();
    for (const owner of ports.owners()) {
      const running = await runningCount(owner.dispatch, owner.dispatch.dispatchFile());
      total += running;
      const max = (await owner.dispatch.profile())?.maxRunningDispatches ?? defaultMax();
      free.set(owner.id, running < max);
    }
    if (total >= ports.maxTotal()) return null;
    let next: { id: string; at: number } | null = null;
    for (const [owner, head] of heads) {
      if (!free.get(owner)) continue;
      if (!next || head.at < next.at || (head.at === next.at && head.id < next.id)) next = head;
    }
    return next?.id ?? null;
  }

  async function drainLocked(): Promise<void> {
    const tried = new Set<string>();
    for (;;) {
      const next = await nextToStart(tried);
      if (!next) return;
      tried.add(next);
      await startLocked(next, false);
    }
  }

  async function cancelLocked(
    conversationId: string,
    by: string | null
  ): Promise<QueuedActionResult> {
    const row = ports.rows()[conversationId];
    const queued = queuedStartOf(row);
    if (!row || !queued) return { ok: false, error: 'not-queued' };
    if (queued.startingAt !== undefined) return { ok: false, error: 'starting' };
    const worktree = row.worktree as SessionWorktree | undefined;
    if (worktree) await ports.removeWorktree(worktree).catch(() => undefined);
    ports.removeRow(conversationId);
    ports.removeConversation(conversationId);
    const owner = ownerOf(row);
    if (owner) {
      const now = ports.now();
      const file = owner.dispatch.dispatchFile();
      const record = file.dispatched[conversationId];
      if (record) {
        if (record.lastState !== 'idle') record.stateSince = now;
        record.lastState = 'idle';
        record.stoppedAt = now;
        owner.dispatch.saveDispatch(file);
      }
      const stopped = markTodoProblem(await owner.dispatch.todos(), conversationId, 'stopped', now);
      if (stopped.changed) owner.dispatch.saveTodos(stopped.todos);
      owner.dispatch.unfollow?.(conversationId);
      owner.dispatch.audit({
        at: now,
        secretaryConversationId: by ?? record?.secretaryConversationId ?? null,
        op: 'queued_cancel',
        targetId: conversationId,
        ok: true,
        detail: by ? 'secretary' : 'user',
      });
      // 秘书自己用 session_stop 取消的已经从工具结果知道了；用户取消的要告诉它
      if (!by)
        push(
          owner,
          conversationId,
          'cancelled',
          `${titleOf(row, conversationId)} · 用户取消了这个排队的会话，会话已删除`
        );
    }
    notifySecretaryChanged();
    return { ok: true };
  }

  return {
    drain() {
      // 还没轮到的那一次会重新读盘，再排一次没有意义
      if (drainQueued) return drainQueued;
      const scheduled = serial(async () => {
        drainQueued = null;
        await drainLocked();
      });
      drainQueued = scheduled;
      return scheduled;
    },

    start(conversationId, followUp) {
      return serial(() => startLocked(conversationId, true, followUp));
    },

    cancel(conversationId, by) {
      return serial(() => cancelLocked(conversationId, by));
    },

    recover() {
      for (const [id, row] of Object.entries(ports.rows())) {
        const queued = queuedStartOf(row);
        if (queued?.startingAt === undefined) continue;
        // 有会话文件说明 agent 起来过：首条消息紧跟着 spawn 发出，按已启动收尾
        const started =
          ports.agentStarted?.(id) === true ||
          (typeof row.sessionFile === 'string' && row.sessionFile.length > 0);
        if (started) {
          finishStarted(id, queued, false);
          continue;
        }
        ports.updateRow(id, (current) => {
          const latest = queuedStartOf(current);
          if (!latest) return null;
          const { startingAt: _startingAt, ...rest } = latest;
          return { ...current, queuedStart: rest };
        });
      }
    },
  };
}

/** 生产实例由 IPC 层注册：dispatch / host 只认这几个入口，避免静态依赖 ipc */
let active: QueuedSessions | null = null;

export function setQueuedSessions(instance: QueuedSessions | null): void {
  active = instance;
}

export function requestQueuedDrain(): void {
  void active?.drain().catch(() => undefined);
}

export function startQueuedSession(
  conversationId: string,
  followUp?: QueuedFollowUp
): Promise<QueuedActionResult> {
  return active
    ? active.start(conversationId, followUp)
    : Promise.resolve({ ok: false, error: 'unavailable' });
}

export function cancelQueuedSession(
  conversationId: string,
  by: string | null
): Promise<QueuedActionResult> {
  return active
    ? active.cancel(conversationId, by)
    : Promise.resolve({ ok: false, error: 'unavailable' });
}
