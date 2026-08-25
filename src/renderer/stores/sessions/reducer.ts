import type {
  ApprovalRequestInfo,
  BackgroundTaskInfo,
  NodeStatus,
  ProjectedMessage,
  RendererAgentEvent,
  SlashCommand,
} from '@shared/types/agent';

export interface SessionProjection {
  status: NodeStatus;
  error?: string;
  messages: ProjectedMessage[];
  commands: SlashCommand[];
  lastSeq: number;
  /** 累计 running 时长（统计条的吞吐分母，含工具执行时间） */
  activeMs: number;
  /** 挂起的工具审批请求（审批条与输入框锁定依赖） */
  pendingApprovals: ApprovalRequestInfo[];
  /** 后台任务（任务胶囊条数据） */
  backgroundTasks: BackgroundTaskInfo[];
  /** 本次 running 的起点（wall clock），idle/failed 时清空 */
  runStartedAt?: number;
}

export const emptyProjection: SessionProjection = {
  status: 'idle',
  messages: [],
  commands: [],
  lastSeq: 0,
  activeMs: 0,
  pendingApprovals: [],
  backgroundTasks: [],
};

/**
 * 把 agent 事件归并进会话投影。纯函数，now 仅用于 running 计时（测试可注入）。
 * seq 单调守卫：过期事件（seq <= lastSeq）直接丢弃，重连/重放时保证不回退。
 */
export function applyAgentEvent(
  state: SessionProjection,
  sessionId: string,
  event: RendererAgentEvent,
  now: number = Date.now()
): SessionProjection {
  if (event.type === 'worker-exited') {
    return {
      ...settleTiming(state, now),
      status: 'failed',
      error: 'agent worker exited',
      pendingApprovals: [],
      backgroundTasks: state.backgroundTasks.map((task) =>
        task.status === 'running' ? { ...task, status: 'failed' as const } : task
      ),
    };
  }
  if (event.type === 'snapshot') {
    const snapshot = event.sessions.find((s) => s.sessionId === sessionId);
    if (!snapshot) return state;
    return {
      status: snapshot.status,
      messages: snapshot.messages,
      commands: snapshot.commands,
      lastSeq: 0,
      activeMs: state.activeMs,
      pendingApprovals: snapshot.pendingApprovals ?? [],
      backgroundTasks: snapshot.backgroundTasks ?? [],
    };
  }
  if (event.sessionId !== sessionId || event.seq <= state.lastSeq) return state;

  switch (event.type) {
    case 'status': {
      const base =
        event.status === 'running'
          ? { ...state, runStartedAt: state.runStartedAt ?? now }
          : settleTiming(state, now);
      return {
        ...base,
        status: event.status,
        error: event.error,
        lastSeq: event.seq,
      };
    }
    case 'message-upsert': {
      const messages = state.messages.slice();
      messages[event.index] = event.message;
      return { ...state, messages, lastSeq: event.seq };
    }
    case 'approval-request':
      return {
        ...state,
        pendingApprovals: [...state.pendingApprovals, event.request],
        lastSeq: event.seq,
      };
    case 'approval-resolved':
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter(
          (request) => request.requestId !== event.requestId
        ),
        lastSeq: event.seq,
      };
    case 'task-started':
      return {
        ...state,
        backgroundTasks: [...state.backgroundTasks, event.task],
        lastSeq: event.seq,
      };
    case 'task-output':
      return {
        ...state,
        backgroundTasks: state.backgroundTasks.map((task) =>
          task.taskId === event.taskId ? { ...task, tail: event.tail, status: event.status } : task
        ),
        lastSeq: event.seq,
      };
    case 'task-ended':
      return {
        ...state,
        backgroundTasks: state.backgroundTasks.map((task) =>
          task.taskId === event.taskId
            ? { ...task, status: event.status, exitCode: event.exitCode }
            : task
        ),
        lastSeq: event.seq,
      };
    case 'turn-completed':
      return { ...settleTiming(state, now), lastSeq: event.seq };
    case 'messages-truncated':
      return { ...state, messages: state.messages.slice(0, event.length), lastSeq: event.seq };
    case 'commands':
      return { ...state, commands: event.commands, lastSeq: event.seq };
    case 'turn-failed':
      return {
        ...settleTiming(state, now),
        status: 'failed',
        error: event.error,
        lastSeq: event.seq,
      };
    default:
      return state;
  }
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
