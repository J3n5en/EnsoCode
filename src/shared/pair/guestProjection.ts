import type {
  ApprovalRequestInfo,
  AskRequestInfo,
  BackgroundTaskInfo,
  ProjectedMessage,
  SessionSnapshot,
  SubagentInfo,
} from '@shared/types/agent';
import { applyRetryEvent, applyTaskEvent, type RetryInfo } from './taskProjection';

/**
 * guest 端（手机 PWA / 桌面远程节点视图）对 host 下发 agent 事件的投影，纯函数。
 * 与桌面 sessions/reducer 同为「按 index 幂等写入、整条替换」。
 * 游标持久化不在此处：返回 lastIndex 由调用方决定落盘位置（手机 localStorage、桌面按节点分桶）。
 */

export interface GuestSessionView {
  /** key = 消息 index，与桌面同为按 index 幂等写入 */
  messages: Map<number, ProjectedMessage>;
  status: string;
  approvals: ApprovalRequestInfo[];
  asks: AskRequestInfo[];
  /** 后台任务 / subagent 状态（TaskBar 胶囊用，与桌面同源事件投影） */
  tasks: BackgroundTaskInfo[];
  subagents: SubagentInfo[];
  /** 自动重试中（非终态）：与桌面 SessionProjection.retry 同规则 */
  retry?: RetryInfo;
  /** 上下文压缩进度：排队中 / 压缩中；与桌面 Conversation.compaction 同语义 */
  compaction?: 'queued' | 'running';
  /**
   * 压完提示的锚点，取**绝对消息 index** 口径（压完那刻 maxIndex + 1）。
   * 桌面存的是稠密数组长度，guest 侧消息是稀疏尾窗，两者不同源，
   * 渲染前须经 localCompactionNoticeIndex() 换算成数组下标。
   */
  compactionNoticeAt?: number;
}

/**
 * 绝对 index 锚点 → 尾窗展开后的数组下标（buildTimeline 的 compactionNoticeAt 是数组下标口径）。
 * 手机只持有尾部若干条消息，直接把绝对 index 传给 buildTimeline 会被它的「锚点过新」保护吞掉。
 */
export function localCompactionNoticeIndex(
  indices: readonly number[],
  noticeAt: number | undefined
): number | undefined {
  if (noticeAt === undefined) return undefined;
  let local = 0;
  for (const index of indices) if (index < noticeAt) local += 1;
  return local;
}

export function emptyGuestView(): GuestSessionView {
  return { messages: new Map(), status: 'idle', approvals: [], asks: [], tasks: [], subagents: [] };
}

export interface GuestEventResult {
  view: GuestSessionView;
  /**
   * 事件后的权威游标 = 视图内最大消息 index（空为 -1），仅改动了消息集的事件有。
   * 调用方应直接覆写落盘（可回退）：游标只涨不跌会在重试/压缩截断后永远高于真实尾部，
   * host 据此把后续所有新消息当旧消息过掉，手机就「卡住」。
   */
  lastIndex?: number;
}

const maxIndex = (messages: ReadonlyMap<number, unknown>): number =>
  messages.size ? Math.max(...messages.keys()) : -1;

/** 单条（非 snapshot）agent 事件 → 新视图。返回的 messages 总是新 Map，不与入参共享。 */
export function applyGuestEvent(
  current: GuestSessionView,
  event: Record<string, unknown>,
  opts?: { now?: number }
): GuestEventResult {
  const view: GuestSessionView = { ...current, messages: new Map(current.messages) };
  view.retry = applyRetryEvent(view.retry, event, opts?.now);

  const taskNext = applyTaskEvent({ tasks: view.tasks, subagents: view.subagents }, event);
  if (taskNext) return { view: { ...view, ...taskNext } };

  switch (event.type) {
    case 'message-upsert': {
      const index = event.index as number;
      view.messages.set(index, event.message as ProjectedMessage);
      return { view, lastIndex: maxIndex(view.messages) };
    }
    case 'messages-truncated': {
      // 重试/压缩后尾部被删：同步裁掉并回退游标
      const length = event.length as number;
      for (const i of view.messages.keys()) if (i >= length) view.messages.delete(i);
      return { view, lastIndex: length - 1 };
    }
    case 'status':
      view.status = event.status as string;
      break;
    case 'turn-completed':
      view.status = 'idle';
      break;
    case 'turn-failed':
      view.status = 'failed';
      break;
    case 'approval-request': {
      // worker 新格式载荷嵌在 request 里；旧格式平铺在事件上，两者都兼容
      const approval = (event.request ?? event) as unknown as ApprovalRequestInfo;
      view.approvals = [...view.approvals, approval];
      break;
    }
    case 'approval-resolved':
      view.approvals = view.approvals.filter((a) => a.requestId !== event.requestId);
      break;
    case 'ask-request': {
      const ask = (event.ask ?? event) as unknown as AskRequestInfo;
      view.asks = [...view.asks, ask];
      break;
    }
    case 'ask-resolved':
      view.asks = view.asks.filter((a) => a.requestId !== event.requestId);
      break;
    case 'compaction': {
      const state = event.state as string;
      view.compaction = state === 'queued' ? 'queued' : state === 'start' ? 'running' : undefined;
      // host 先对齐消息再发 end，此时 maxIndex 已含摘要消息；失败则消息没变，锚点保持原样
      if (state === 'end' && !event.error) view.compactionNoticeAt = maxIndex(view.messages) + 1;
      break;
    }
  }
  return { view };
}

export interface GuestSnapshotResult {
  id: string;
  view: GuestSessionView;
  /** 快照内最大消息 index；空快照为 undefined */
  lastIndex?: number;
}

type SnapshotSession = Partial<SessionSnapshot> & {
  sessionId?: string;
  identity?: { sessionId?: string };
};

/**
 * 尾窗快照：按 baseIndex 偏移合并进已有投影。
 * 不能整张 Map 替换——用户可能已上滑加载了更早的分页；
 * 但尾窗与已有内容接不上（离线太久）时丢弃旧段保持时间线连续，上滑可重新拉回。
 * 尾窗末就是时间线末：已有的更靠后消息（离线期间被截断）一律丢掉。
 */
export function applyGuestSnapshot(
  sessions: ReadonlyMap<string, GuestSessionView>,
  event: { sessions?: unknown[] }
): GuestSnapshotResult[] {
  const out: GuestSnapshotResult[] = [];
  for (const snap of (event.sessions ?? []) as SnapshotSession[]) {
    // host 归一化后有扁平 sessionId；identity 兜底防旧桌面版
    const id = snap.sessionId ?? snap.identity?.sessionId;
    if (!id) continue;
    const base = snap.baseIndex ?? 0;
    const existing = sessions.get(id)?.messages;
    const prevMax = existing?.size ? Math.max(...existing.keys()) : -1;
    const messages =
      existing && base <= prevMax + 1 ? new Map(existing) : new Map<number, ProjectedMessage>();
    const incoming = snap.messages ?? [];
    for (const i of messages.keys()) if (i >= base + incoming.length) messages.delete(i);
    for (const [i, message] of incoming.entries()) messages.set(base + i, message);
    out.push({
      id,
      view: {
        messages,
        status: snap.status ?? 'idle',
        approvals: snap.pendingApprovals ?? [],
        asks: snap.pendingAsks ?? [],
        tasks: snap.backgroundTasks ?? [],
        subagents: snap.subagents ?? [],
        // 快照带了就以快照为准（手机刷新后无旧投影）；旧 host 不带则沿用，重连不抹掉进度/提示
        compaction: snap.compaction ?? sessions.get(id)?.compaction,
        compactionNoticeAt: snap.compactionNoticeAt ?? sessions.get(id)?.compactionNoticeAt,
      },
      lastIndex: base + incoming.length - 1,
    });
  }
  return out;
}

/** history 应答：只并入消息，不动 status/审批（那些以尾窗快照为准）。空页返回原视图。 */
export function applyGuestHistory(
  view: GuestSessionView,
  payload: { baseIndex: number; messages: unknown[] }
): GuestSessionView {
  if (payload.messages.length === 0) return view;
  const messages = new Map(view.messages);
  for (const [i, message] of payload.messages.entries()) {
    messages.set(payload.baseIndex + i, message as ProjectedMessage);
  }
  return { ...view, messages };
}

/** worker-exited：host 侧 worker 崩了，所有会话置 failed（消息保留） */
export function markAllFailed(
  sessions: ReadonlyMap<string, GuestSessionView>
): Map<string, GuestSessionView> {
  const out = new Map<string, GuestSessionView>();
  for (const [id, view] of sessions) {
    out.set(id, { ...view, status: 'failed', messages: new Map(view.messages) });
  }
  return out;
}
