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

/**
 * 时间线消息：乐观回显（本地先上屏、worker 尚未确认）带 optimistic 标记，
 * 只允许出现在数组尾部（权威消息之后）。
 */
export type TimelineMessage = ProjectedMessage & { optimistic?: boolean };

function textOf(message: ProjectedMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .trim();
}

const SKILL_SLASH = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/;
const SKILL_BLOCK =
  /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

function sameUserText(optimistic: string, delivered: string): boolean {
  if (optimistic === delivered) return true;
  const slash = SKILL_SLASH.exec(optimistic);
  const block = SKILL_BLOCK.exec(delivered);
  if (!slash || !block) return false;
  return slash[1] === block[1] && (slash[2] ?? '').trim() === (block[4] ?? '').trim();
}

export interface SessionProjection {
  generation?: string;
  status: NodeStatus;
  error?: string;
  messages: TimelineMessage[];
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
  /** child 会话终态：已结束，跨重启不复活（随 partialize 持久化，重启后 Main 级联恢复据此跳过） */
  ended?: boolean;
  /** 本次 running 的起点（wall clock），idle/failed 时清空 */
  runStartedAt?: number;
  /** 最近一次权威 message-upsert 落地时间：运行中计时显示「距上次返回」，随 running 结束清空 */
  lastOutputAt?: number;
  /** 自动重试中（非终态）：turn-retry 设置，下一个 status/turn-* 事件清除 */
  retry?: { attempt: number; maxAttempts: number; delayMs: number; error: string; at: number };
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
  // spawn 拒绝恒以 seq:0 发出（worker 侧此时尚未建会话，没有 seq 计数器），
  // 过不了下面的 (generation, seq) 单调守卫。一并丢弃的后果是 spawn 失败在
  // UI 上完全无声：spawning 被别处清掉、status 停在 idle、error 为空，用户
  // 只看到会话点开一片空白。故单独处理：仅当代未领养或同代时生效（旧代
  // 迟到的拒绝不得回退活着的新代），并把 generation 重置为 undefined，
  // 重试 spawn 的新代事件才能被干净领养而不是被钉死在被拒的这代上。
  if (
    (event.type === 'parent-rejected' || event.type === 'child-rejected') &&
    identity?.sessionId === sessionId
  ) {
    if (state.generation !== undefined && state.generation !== identity.generation) return state;
    return {
      ...settleTiming(state, now),
      generation: undefined,
      status: 'failed',
      error: event.reason,
      pendingApprovals: [],
      pendingAsks: [],
      // 拒绝对该代是终态：child 标 ended，重启后不再重试恢复（历史仍可读）
      ...(event.type === 'child-rejected' ? { ended: true } : {}),
    };
  }

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
        // 新代 ready = 成功复活，清掉上一代的终态标记
        ended: undefined,
        lastSeq: event.seq,
      };
    case 'parent-ended':
    case 'child-ended':
      return {
        ...settleTiming(current, now),
        status: 'idle',
        pendingApprovals: [],
        pendingAsks: [],
        // 只有 child 有「跨重启不复活」语义；父会话 ended 由 source authority 管
        ...(event.type === 'child-ended' ? { ended: true } : {}),
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
        retry: undefined,
        lastSeq: event.seq,
      };
    }
    case 'turn-retry':
      return {
        ...current,
        retry: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.error,
          at: now,
        },
        lastSeq: event.seq,
      };
    case 'message-upsert': {
      // 乐观回显是未确认的本地尾巴：权威 upsert 只写权威区，尾巴永远浮在后面。
      // running 中 steer 的回显若按裸 index 覆盖，会被当前轮的 assistant 消息
      // 顶掉（用户看到消息凭空消失，轮次结束后又出现）。
      const firstOptimistic = current.messages.findIndex((message) => message.optimistic);
      const authoritative =
        firstOptimistic === -1
          ? current.messages.slice()
          : current.messages.slice(0, firstOptimistic);
      let tail = firstOptimistic === -1 ? [] : current.messages.slice(firstOptimistic);
      authoritative[event.index] = event.message;
      // 同文本的 user upsert 到达 = 回显对应的真消息落地，消费掉避免重复
      if (event.message.role === 'user' && tail.length > 0) {
        const deliveredText = textOf(event.message);
        const matched = tail.findIndex(
          (message) => message.role === 'user' && sameUserText(textOf(message), deliveredText)
        );
        if (matched !== -1) tail = tail.toSpliced(matched, 1);
      }
      return {
        ...current,
        messages: [...authoritative, ...tail],
        lastOutputAt: now,
        lastSeq: event.seq,
      };
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
      return { ...settleTiming(current, now), retry: undefined, lastSeq: event.seq };
    case 'messages-truncated':
      return { ...current, messages: current.messages.slice(0, event.length), lastSeq: event.seq };
    case 'commands':
      return { ...current, commands: event.commands, lastSeq: event.seq };
    case 'turn-failed':
      return {
        ...settleTiming(current, now),
        status: 'failed',
        error: event.error,
        retry: undefined,
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
    lastOutputAt: undefined,
  };
}
