import type {
  CatalogEntry,
  HostToPhone,
  PhoneToHost,
  ProjectEntry,
  ProviderEntry,
} from '@enso/pair';
import {
  applyGuestEvent,
  applyGuestHistory,
  applyGuestSnapshot,
  emptyGuestView,
  type GuestSessionView,
  markAllFailed,
} from '@shared/pair/guestProjection';
import {
  applyCatalog,
  applySnapshot,
  applySubscribe,
  initialSync,
  type SyncTracking,
} from '@shared/pair/syncProjection';

/**
 * 单个远程节点的视图 reducer（纯函数）。
 * 与手机 App.tsx + client.ts 的状态机同语义，但把副作用（发命令、存游标、幽灵跳离）
 * 以 effects 返回，由 zustand store 执行，便于测试。
 */

export interface NodeView {
  catalog: CatalogEntry[];
  pinnedOrder: string[];
  projects: ProjectEntry[];
  providers: ProviderEntry[];
  sessions: Record<string, GuestSessionView>;
  /** 正在看的会话（null = 列表态） */
  activeSessionId: string | null;
  /** 已向 host 订阅的会话 */
  subscribedId: string | null;
  sync: SyncTracking;
  /** 分页请求在途（每会话一次一发） */
  historyPending: ReadonlySet<string>;
}

export type NodeEffect =
  | { kind: 'send'; command: PhoneToHost }
  | { kind: 'cursor'; sessionId: string; index: number }
  /** 订阅的会话已被对方删除：上层应跳离 */
  | { kind: 'ghost'; sessionId: string };

export interface NodeReduceResult {
  view: NodeView;
  effects: NodeEffect[];
}

/** sessionId → 已看到的最大消息 index */
export type Cursors = Record<string, number>;

export function emptyNodeView(): NodeView {
  return {
    catalog: [],
    pinnedOrder: [],
    projects: [],
    providers: [],
    sessions: {},
    activeSessionId: null,
    subscribedId: null,
    sync: initialSync,
    historyPending: new Set(),
  };
}

function subscribeCommand(sessionId: string, cursors: Cursors): PhoneToHost {
  const sinceIndex = cursors[sessionId];
  return {
    type: 'subscribe',
    sessionId,
    ...(typeof sinceIndex === 'number' ? { sinceIndex } : {}),
  };
}

/** 选中/取消选中会话：更新订阅与同步态，发 subscribe。fresh = 本机刚 spawn 的新会话，不进 syncing */
export function selectSession(
  view: NodeView,
  sessionId: string | null,
  cursors: Cursors,
  opts?: { fresh?: boolean }
): NodeReduceResult {
  const next: NodeView = {
    ...view,
    activeSessionId: sessionId,
    subscribedId: sessionId,
    sync: applySubscribe(view.sync, sessionId, opts),
    // 换了订阅，旧会话的分页请求作废
    historyPending: new Set(),
  };
  const command: PhoneToHost = sessionId
    ? subscribeCommand(sessionId, cursors)
    : { type: 'subscribe', sessionId: null };
  return { view: next, effects: [{ kind: 'send', command }] };
}

/** 对方上线：重发订阅（带游标只补增量）并要目录；下线不发 */
export function onHostOnlineChanged(
  view: NodeView,
  online: boolean,
  cursors: Cursors
): NodeReduceResult {
  if (!online) return { view, effects: [] };
  const effects: NodeEffect[] = [];
  if (view.subscribedId) {
    effects.push({ kind: 'send', command: subscribeCommand(view.subscribedId, cursors) });
  }
  effects.push({ kind: 'send', command: { type: 'snapshot' } });
  return {
    view: { ...view, sync: applySubscribe(view.sync, view.subscribedId) },
    effects,
  };
}

/** 上滑加载更早一页：无更早内容或已在途时不发 */
export function requestHistory(view: NodeView, sessionId: string): NodeReduceResult {
  const session = view.sessions[sessionId];
  if (!session || session.messages.size === 0 || view.historyPending.has(sessionId)) {
    return { view, effects: [] };
  }
  const beforeIndex = Math.min(...session.messages.keys());
  if (beforeIndex <= 0) return { view, effects: [] };
  return {
    view: { ...view, historyPending: new Set([...view.historyPending, sessionId]) },
    effects: [{ kind: 'send', command: { type: 'history', sessionId, beforeIndex } }],
  };
}

/** host 下行帧（main 已解密并过滤 appearance/push-config） */
export function applyNodeMessage(view: NodeView, payload: unknown): NodeReduceResult {
  if (typeof payload !== 'object' || payload === null) return { view, effects: [] };
  const frame = payload as HostToPhone;
  switch (frame.type) {
    case 'catalog': {
      const { tracking, ghost } = applyCatalog(
        view.sync,
        view.subscribedId,
        frame.entries.map((e) => e.id)
      );
      const effects: NodeEffect[] = [];
      let activeSessionId = view.activeSessionId;
      if (ghost && view.subscribedId) {
        effects.push({ kind: 'ghost', sessionId: view.subscribedId });
        if (activeSessionId === view.subscribedId) activeSessionId = null;
      }
      return {
        view: {
          ...view,
          catalog: frame.entries,
          pinnedOrder: frame.pinnedOrder ?? [],
          sync: tracking,
          activeSessionId,
        },
        effects,
      };
    }
    case 'projects':
      return { view: { ...view, projects: frame.projects }, effects: [] };
    case 'providers':
      return { view: { ...view, providers: frame.providers }, effects: [] };
    case 'agent-event':
      return applyAgentEvent(view, frame.event as Record<string, unknown>);
    case 'history': {
      const session = view.sessions[frame.sessionId];
      const historyPending = new Set(view.historyPending);
      historyPending.delete(frame.sessionId);
      if (!session) return { view: { ...view, historyPending }, effects: [] };
      const next = applyGuestHistory(session, frame);
      return {
        view: { ...view, historyPending, sessions: { ...view.sessions, [frame.sessionId]: next } },
        effects: [],
      };
    }
    default:
      return { view, effects: [] };
  }
}

function applyAgentEvent(view: NodeView, event: Record<string, unknown>): NodeReduceResult {
  if (typeof event !== 'object' || event === null) return { view, effects: [] };
  const type = event.type as string;

  if (type === 'worker-exited') {
    const failed = markAllFailed(new Map(Object.entries(view.sessions)));
    return { view: { ...view, sessions: Object.fromEntries(failed) }, effects: [] };
  }

  if (type === 'snapshot') {
    const sessions = new Map(Object.entries(view.sessions));
    const results = applyGuestSnapshot(sessions, event as { sessions?: unknown[] });
    const effects: NodeEffect[] = [];
    const nextSessions = { ...view.sessions };
    for (const { id, view: sessionView, lastIndex } of results) {
      nextSessions[id] = sessionView;
      if (lastIndex !== undefined)
        effects.push({ kind: 'cursor', sessionId: id, index: lastIndex });
    }
    return {
      view: {
        ...view,
        sessions: nextSessions,
        sync: applySnapshot(
          view.sync,
          view.subscribedId,
          results.map((r) => r.id)
        ),
      },
      effects,
    };
  }

  const sessionId = event.sessionId as string | undefined;
  if (!sessionId) return { view, effects: [] };
  const { view: sessionView, lastIndex } = applyGuestEvent(
    view.sessions[sessionId] ?? emptyGuestView(),
    event
  );
  return {
    view: { ...view, sessions: { ...view.sessions, [sessionId]: sessionView } },
    effects: lastIndex !== undefined ? [{ kind: 'cursor', sessionId, index: lastIndex }] : [],
  };
}
