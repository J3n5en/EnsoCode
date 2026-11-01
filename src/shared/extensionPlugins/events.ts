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
] as const;
export type PluginEventName = (typeof PLUGIN_EVENTS)[number];

/** 可以拦截或改写的事件；其余只通知 */
export const PLUGIN_INTERCEPT_EVENTS = ['tool_call', 'tool_result', 'input'] as const;
export type PluginInterceptEvent = (typeof PLUGIN_INTERCEPT_EVENTS)[number];

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

export type InterceptPayload = {
  tool_call: ToolCallPayload;
  tool_result: ToolResultPayload;
  input: InputPayload;
};

export type InterceptResult = {
  tool_call: { block?: true; reason?: string; input?: Record<string, unknown> };
  tool_result: { content?: string; isError?: boolean };
  input: { action: 'continue' } | { action: 'transform'; text: string } | { action: 'handled' };
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
  return { action: 'handled' } as InterceptResult[E];
}
