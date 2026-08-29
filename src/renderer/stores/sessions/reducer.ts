import {
  type AgentSessionCustomEntry,
  type ApprovalRequestInfo,
  type AskRequestInfo,
  type BackgroundTaskInfo,
  type DispatchMainEvent,
  type NodeStatus,
  type ProjectedMessage,
  type RendererAgentEvent,
  type SessionIdentity,
  type SlashCommand,
  type SubagentInfo,
  shouldApplyDispatchMainEvent,
} from '@shared/types/agent';

export interface SessionProjection {
  generation?: string;
  status: NodeStatus;
  error?: string;
  messages: ProjectedMessage[];
  customEntries: AgentSessionCustomEntry[];
  commands: SlashCommand[];
  lastSeq: number;
  /** 独立Main派发流；worker seq不能修改或覆盖。 */
  dispatchMainEvents: Record<string, DispatchMainEvent>;
  /** 累计 running 时长（统计条的吞吐分母，含工具执行时间） */
  activeMs: number;
  /** 挂起的工具审批请求（审批条与输入框锁定依赖） */
  pendingApprovals: ApprovalRequestInfo[];
  /** 挂起的用户提问（提问条数据） */
  pendingAsks: AskRequestInfo[];
  /** 后台任务（任务胶囊条数据） */
  backgroundTasks: BackgroundTaskInfo[];
  /** 子代理（状态行数据） */
  subagents: SubagentInfo[];
  /** 本次 running 的起点（wall clock），idle/failed 时清空 */
  runStartedAt?: number;
}

export const emptyProjection: SessionProjection = {
  status: 'idle',
  messages: [],
  customEntries: [],
  commands: [],
  dispatchMainEvents: {},
  lastSeq: 0,
  activeMs: 0,
  pendingApprovals: [],
  pendingAsks: [],
  backgroundTasks: [],
  subagents: [],
};

const eventIdentity = (event: RendererAgentEvent): SessionIdentity | null => {
  if (event.type === 'worker-exited' || event.type === 'snapshot') return null;
  if (event.type === 'capability-invoke') return event.child;
  return event.identity;
};

/**
 * 把 agent 事件归并进会话投影。纯函数，now 仅用于 running 计时（测试可注入）。
 * `(sessionId, generation, seq)` 单调守卫：旧 generation 与低 seq 都直接丢弃。
 */
export function applyAgentEvent(
  rawState: SessionProjection,
  sessionId: string,
  event: RendererAgentEvent,
  now: number = Date.now()
): SessionProjection {
  // persist 旧数据可能缺后加字段，入口统一归一，避免事件处理访问 undefined。
  const state: SessionProjection =
    rawState.pendingApprovals &&
    rawState.pendingAsks &&
    rawState.backgroundTasks &&
    rawState.subagents &&
    rawState.customEntries &&
    rawState.dispatchMainEvents
      ? rawState
      : {
          ...rawState,
          customEntries: rawState.customEntries ?? [],
          dispatchMainEvents: rawState.dispatchMainEvents ?? {},
          pendingApprovals: rawState.pendingApprovals ?? [],
          pendingAsks: rawState.pendingAsks ?? [],
          backgroundTasks: rawState.backgroundTasks ?? [],
          subagents: rawState.subagents ?? [],
        };

  if (event.type === 'worker-exited') {
    return {
      ...settleTiming(state, now),
      status: 'failed',
      error: 'agent worker exited',
      pendingApprovals: [],
      pendingAsks: [],
      backgroundTasks: state.backgroundTasks.map((task) =>
        task.status === 'running' ? { ...task, status: 'failed' as const } : task
      ),
      subagents: state.subagents.map((agent) =>
        agent.status === 'running' ? { ...agent, status: 'failed' as const } : agent
      ),
    };
  }

  if (event.type === 'snapshot') {
    const snapshot = event.sessions.find((candidate) => candidate.identity.sessionId === sessionId);
    if (!snapshot) return state;
    const sameGeneration = state.generation === snapshot.identity.generation;
    return {
      generation: snapshot.identity.generation,
      status: snapshot.status,
      messages: snapshot.messages,
      customEntries: snapshot.customEntries ?? [],
      commands: snapshot.commands,
      dispatchMainEvents: {},
      lastSeq: 0,
      activeMs: sameGeneration ? state.activeMs : 0,
      pendingApprovals: snapshot.pendingApprovals ?? [],
      pendingAsks: snapshot.pendingAsks ?? [],
      backgroundTasks: snapshot.backgroundTasks ?? [],
      subagents: snapshot.subagents ?? [],
    };
  }

  const identity = eventIdentity(event);
  if (
    !identity ||
    identity.sessionId !== sessionId ||
    (state.generation !== undefined && state.generation !== identity.generation) ||
    event.seq <= state.lastSeq
  ) {
    return state;
  }
  const current = state.generation ? state : { ...state, generation: identity.generation };

  switch (event.type) {
    case 'parent-ready':
    case 'child-ready':
      return {
        ...current,
        status: 'idle',
        error: undefined,
        lastSeq: event.seq,
      };
    case 'parent-rejected':
    case 'child-rejected':
      return {
        ...settleTiming(current, now),
        status: 'failed',
        error: event.reason,
        pendingApprovals: [],
        pendingAsks: [],
        lastSeq: event.seq,
      };
    case 'parent-ended':
    case 'child-ended':
      return {
        ...settleTiming(current, now),
        status: 'idle',
        pendingApprovals: [],
        pendingAsks: [],
        lastSeq: event.seq,
      };
    case 'status': {
      const base =
        event.status === 'running'
          ? { ...current, runStartedAt: current.runStartedAt ?? now }
          : settleTiming(current, now);
      return {
        ...base,
        status: event.status,
        error: event.error,
        lastSeq: event.seq,
      };
    }
    case 'message-upsert': {
      const messages = current.messages.slice();
      messages[event.index] = event.message;
      return { ...current, messages, lastSeq: event.seq };
    }
    case 'approval-request':
      return {
        ...current,
        pendingApprovals: current.pendingApprovals.some(
          (request) => request.requestId === event.request.requestId
        )
          ? current.pendingApprovals
          : [...current.pendingApprovals, event.request],
        lastSeq: event.seq,
      };
    case 'approval-resolved':
      return {
        ...current,
        pendingApprovals: current.pendingApprovals.filter(
          (request) => request.requestId !== event.requestId
        ),
        lastSeq: event.seq,
      };
    case 'ask-request':
      return {
        ...current,
        pendingAsks: current.pendingAsks.some((ask) => ask.requestId === event.ask.requestId)
          ? current.pendingAsks
          : [...current.pendingAsks, event.ask],
        lastSeq: event.seq,
      };
    case 'ask-resolved':
      return {
        ...current,
        pendingAsks: current.pendingAsks.filter((ask) => ask.requestId !== event.requestId),
        lastSeq: event.seq,
      };
    case 'subagent-update': {
      const exists = current.subagents.some((agent) => agent.id === event.agent.id);
      return {
        ...current,
        subagents: exists
          ? current.subagents.map((agent) => (agent.id === event.agent.id ? event.agent : agent))
          : [...current.subagents, event.agent],
        lastSeq: event.seq,
      };
    }
    case 'task-started':
      return {
        ...current,
        backgroundTasks: current.backgroundTasks.some((task) => task.taskId === event.task.taskId)
          ? current.backgroundTasks
          : [...current.backgroundTasks, event.task],
        lastSeq: event.seq,
      };
    case 'task-output':
      return {
        ...current,
        backgroundTasks: current.backgroundTasks.map((task) =>
          task.taskId === event.taskId ? { ...task, tail: event.tail, status: event.status } : task
        ),
        lastSeq: event.seq,
      };
    case 'task-ended':
      return {
        ...current,
        backgroundTasks: current.backgroundTasks.map((task) =>
          task.taskId === event.taskId
            ? { ...task, status: event.status, exitCode: event.exitCode }
            : task
        ),
        lastSeq: event.seq,
      };
    case 'turn-completed':
      return { ...settleTiming(current, now), lastSeq: event.seq };
    case 'messages-truncated':
      return { ...current, messages: current.messages.slice(0, event.length), lastSeq: event.seq };
    case 'commands':
      return { ...current, commands: event.commands, lastSeq: event.seq };
    case 'turn-failed':
      return {
        ...settleTiming(current, now),
        status: 'failed',
        error: event.error,
        lastSeq: event.seq,
      };
    case 'session-custom-entry':
      return {
        ...current,
        customEntries: [...current.customEntries, event.entry],
        lastSeq: event.seq,
      };
    default:
      return { ...current, lastSeq: event.seq };
  }
}
/** 独立Main dispatch投影：exact child generation、同dispatch递增mainSeq、terminal单次收口。 */
export function applyDispatchEvent(
  rawState: SessionProjection,
  sessionId: string,
  event: DispatchMainEvent,
  now: number = Date.now()
): SessionProjection {
  if (
    event.child.sessionId !== sessionId ||
    (rawState.generation !== undefined && rawState.generation !== event.child.generation)
  ) {
    return rawState;
  }
  const currentEvent = rawState.dispatchMainEvents?.[event.dispatchId] ?? null;
  if (!shouldApplyDispatchMainEvent(currentEvent, event)) return rawState;
  const state = rawState.dispatchMainEvents ? rawState : { ...rawState, dispatchMainEvents: {} };
  const dispatchMainEvents = { ...state.dispatchMainEvents, [event.dispatchId]: event };
  if (event.phase !== 'terminal') {
    return {
      ...state,
      generation: state.generation ?? event.child.generation,
      status: 'running',
      error: undefined,
      runStartedAt: state.runStartedAt ?? now,
      dispatchMainEvents,
    };
  }
  const settled = settleTiming(state, now);
  return {
    ...settled,
    generation: settled.generation ?? event.child.generation,
    status: event.terminal === 'failed' ? 'failed' : 'idle',
    error: event.terminal === 'failed' ? event.receiptSummary : undefined,
    dispatchMainEvents,
  };
}

/** 结算进行中的 running 计时：把 runStartedAt 到 now 的时长并入 activeMs */
function settleTiming(state: SessionProjection, now: number): SessionProjection {
  if (state.runStartedAt === undefined) return state;
  return {
    ...state,
    activeMs: state.activeMs + Math.max(0, now - state.runStartedAt),
    runStartedAt: undefined,
  };
}
