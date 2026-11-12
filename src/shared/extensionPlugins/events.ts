/** 插件可订阅的会话事件与等待语义；worker 与 Main 共用 */

export const PLUGIN_EVENTS = [
  'session_start',
  'session_end',
  'agent_start',
  'agent_end',
  'before_compact',
  'after_compact',
  'tool_call',
  'tool_result',
  'input',
  'context_usage',
  'session_status',
  'model_select',
  'before_agent_start',
] as const;
export type PluginEventName = (typeof PLUGIN_EVENTS)[number];

/** 由 Main 汇总派发、不经 worker 的事件；worker 发来的同名事件一律拒收 */
export const HOST_PLUGIN_EVENTS = ['session_status'] as const satisfies readonly PluginEventName[];
export const isHostPluginEvent = (event: string): boolean =>
  (HOST_PLUGIN_EVENTS as readonly string[]).includes(event);

/** 主会话（含其子会话）的汇总状态，优先级与侧栏圆点一致：error > waiting > running > idle */
export type PluginSessionState = 'idle' | 'running' | 'waiting' | 'error';

export interface PluginSessionStatus {
  sessionId: string;
  state: PluginSessionState;
  /** 等待用户回答的提问数（含子会话） */
  pendingAsks: number;
  /** 等待用户审批的工具调用数（含子会话） */
  pendingApprovals: number;
}

export interface SessionStatusPayload extends PluginSessionStatus {
  previous: PluginSessionState;
}

/** agent_end 携带的本轮最终回复正文上限（字符） */
export const AGENT_END_TEXT_MAX = 64 * 1024;

/** context_usage 的分桶：与宿主上下文占用一致，不含已废弃的 projectMemory */
export const CONTEXT_USAGE_BUCKETS = [
  'system',
  'instructions',
  'skills',
  'tools',
  'conversation',
  'compaction',
  'reminders',
] as const;
export type ContextUsageBucket = (typeof CONTEXT_USAGE_BUCKETS)[number];

export interface ContextUsagePayload {
  used: number;
  /** 没有模型实报用量可锚定时为 true */
  estimated: boolean;
  contextWindow?: number;
  percent?: number;
  buckets: Record<ContextUsageBucket, number>;
  /** 最近一次带用量的回复的实报 token */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** 与 magpie 同形的七类拆分，各类条目按大小排列（会话按轮次） */
  parts?: ContextPart[];
  /** 当前上下文里用户发言的轮数 */
  turns?: number;
}

export const CONTEXT_PART_KINDS = [
  'system',
  'tools',
  'skills',
  'memory',
  'files',
  'results',
  'chat',
] as const;
export type ContextPartKind = (typeof CONTEXT_PART_KINDS)[number];
/** 每类最多的条目数 */
export const CONTEXT_PART_ITEMS = 24;

export interface ContextPartItem {
  name: string;
  /** mcp / project / reminder / skills / read / shell / image / result / turn / turns / compacted / more */
  tag: string;
  /** 合并了多少项：MCP server 的工具数、工具的结果次数、合并的轮次或条目 */
  n?: number;
  tokens: number;
}

export interface ContextPart {
  kind: ContextPartKind;
  tokens: number;
  items: ContextPartItem[];
}

/** 可以拦截或改写的事件；其余只通知 */
export const PLUGIN_INTERCEPT_EVENTS = [
  'tool_call',
  'tool_result',
  'input',
  'before_agent_start',
] as const;
export type PluginInterceptEvent = (typeof PLUGIN_INTERCEPT_EVENTS)[number];
/** 只能追加、不能拒绝的拦截事件：声明 failClosed 没有意义，清单里拒绝 */
export const APPEND_ONLY_INTERCEPT_EVENTS = ['before_agent_start'] as const;
/** before_agent_start 所有插件追加的 system prompt 合计上限（字符） */
export const BEFORE_AGENT_START_APPEND_MAX = 16 * 1024;
/** before_agent_start 载荷里用户消息正文的上限（字符） */
export const BEFORE_AGENT_START_PROMPT_MAX = 64 * 1024;

/** before_compact 等插件落盘；超时照常压缩 */
export const BEFORE_COMPACT_TIMEOUT_MS = 10_000;
/** 拦截型事件每个插件的等待上限 */
export const INTERCEPT_TIMEOUT_MS = 5_000;
/** 一次拦截串行询问所有插件的总上限；须小于 worker 本地兜底 */
export const INTERCEPT_TOTAL_TIMEOUT_MS = 25_000;
/**
 * 子会话（子代理、coworker）只拦 tool_call，预算独立且更紧：并行的子会话各自计时，
 * 不占主会话的 5s/25s，插件侧串行时最多给别的会话增加一次合计的延迟
 */
export const CHILD_INTERCEPT_EVENTS = [
  'tool_call',
] as const satisfies readonly PluginInterceptEvent[];
export const CHILD_INTERCEPT_TIMEOUT_MS = 2_000;
export const CHILD_INTERCEPT_TOTAL_TIMEOUT_MS = 5_000;
/** 通知型事件在插件侧的处理上限；只用于收敛，不阻塞会话 */
export const OBSERVE_TIMEOUT_MS = 30_000;

export const isInterceptEvent = (event: string): event is PluginInterceptEvent =>
  (PLUGIN_INTERCEPT_EVENTS as readonly string[]).includes(event);

export const isChildInterceptEvent = (event: string): event is 'tool_call' =>
  (CHILD_INTERCEPT_EVENTS as readonly string[]).includes(event);

export interface PluginEventSubscription {
  event: PluginEventName;
  mode: 'observe' | 'intercept';
  /** 拦截型：超时或失败时 true=拒绝，false=放行 */
  failClosed: boolean;
  /** tool_call / tool_result 只关心这些工具；缺省全部 */
  tools?: string[];
}

export interface ToolCallPayload {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}
export interface ToolResultPayload extends ToolCallPayload {
  content: string;
  isError: boolean;
}
export interface InputPayload {
  text: string;
  source: string;
}
/** 一轮开始前；kind=custom 是插件或系统消息触发的轮次，prompt 为空串 */
export interface BeforeAgentStartPayload {
  prompt: string;
  kind: 'user' | 'custom';
}
export interface ModelSelectPayload {
  provider: string;
  modelId: string;
  previous?: { provider: string; modelId: string };
  source: 'set' | 'cycle' | 'restore';
}

export type InterceptPayload = {
  tool_call: ToolCallPayload;
  tool_result: ToolResultPayload;
  input: InputPayload;
  before_agent_start: BeforeAgentStartPayload;
};

export type InterceptResult = {
  tool_call: { block?: true; reason?: string; input?: Record<string, unknown> };
  tool_result: { content?: string; isError?: boolean };
  input: { action: 'continue' } | { action: 'transform'; text: string } | { action: 'handled' };
  /** 追加到本轮 system prompt 末尾的文本，多个插件按 id 顺序用空行拼接 */
  before_agent_start: { append?: string };
};

export interface InterceptState<E extends PluginInterceptEvent> {
  event: E;
  payload: InterceptPayload[E];
  result: InterceptResult[E];
  /** 已拦截或已处理，后续插件不再询问 */
  done: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function initialInterceptState<E extends PluginInterceptEvent>(
  event: E,
  payload: InterceptPayload[E]
): InterceptState<E> {
  const result = (event === 'input' ? { action: 'continue' } : {}) as InterceptResult[E];
  return { event, payload, result, done: false };
}

/**
 * 把一个插件的拦截结果合并进状态。后一个插件看到的是前一个改写后的参数；
 * 不合法的返回值当作“不改”。
 */
export function applyInterceptResult<E extends PluginInterceptEvent>(
  state: InterceptState<E>,
  raw: unknown
): InterceptState<E> {
  if (state.done || !isRecord(raw)) return state;
  if (state.event === 'tool_call') {
    const payload = state.payload as ToolCallPayload;
    const result = { ...(state.result as InterceptResult['tool_call']) };
    if (raw.block === true) {
      return {
        ...state,
        done: true,
        result: {
          ...result,
          block: true,
          ...(typeof raw.reason === 'string' ? { reason: raw.reason.slice(0, 2000) } : {}),
        } as InterceptResult[E],
      };
    }
    if (!isRecord(raw.input)) return state;
    return {
      ...state,
      payload: { ...payload, input: raw.input } as InterceptPayload[E],
      result: { ...result, input: raw.input } as InterceptResult[E],
    };
  }
  if (state.event === 'tool_result') {
    const payload = state.payload as ToolResultPayload;
    const result = { ...(state.result as InterceptResult['tool_result']) };
    const nextPayload = { ...payload };
    if (typeof raw.content === 'string') {
      result.content = raw.content;
      nextPayload.content = raw.content;
    }
    if (typeof raw.isError === 'boolean') {
      result.isError = raw.isError;
      nextPayload.isError = raw.isError;
    }
    return {
      ...state,
      payload: nextPayload as InterceptPayload[E],
      result: result as InterceptResult[E],
    };
  }
  if (state.event === 'before_agent_start') {
    if (typeof raw.append !== 'string' || raw.append.length === 0) return state;
    const previous = (state.result as InterceptResult['before_agent_start']).append;
    const append = (previous ? `${previous}\n\n${raw.append}` : raw.append).slice(
      0,
      BEFORE_AGENT_START_APPEND_MAX
    );
    return { ...state, result: { append } as InterceptResult[E] };
  }
  if (raw.action === 'handled')
    return { ...state, done: true, result: { action: 'handled' } as InterceptResult[E] };
  if (raw.action === 'transform' && typeof raw.text === 'string') {
    return {
      ...state,
      payload: { ...(state.payload as InputPayload), text: raw.text } as InterceptPayload[E],
      result: { action: 'transform', text: raw.text } as InterceptResult[E],
    };
  }
  return state;
}

/** 拦截失败或超时且声明 fail-closed 时的结果 */
export function failClosedResult<E extends PluginInterceptEvent>(
  event: E,
  pluginName: string
): InterceptResult[E] {
  const reason = `插件 ${pluginName} 未能完成检查，已按其策略拒绝`;
  if (event === 'tool_call') return { block: true, reason } as InterceptResult[E];
  if (event === 'tool_result') return { content: reason, isError: true } as InterceptResult[E];
  if (event === 'before_agent_start') return {} as InterceptResult[E];
  return { action: 'handled' } as InterceptResult[E];
}
