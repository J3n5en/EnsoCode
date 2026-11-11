import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

/** 两个流事件之间的最长静默；超时中断上游并以可重试错误收尾（错误文案须命中 pi 的 `timed out` 重试规则） */
export const STREAM_IDLE_TIMEOUT_MS = 300_000;
/** 本机模型长上下文 prefill 期间不出事件，放宽上限 */
export const LOCAL_STREAM_IDLE_TIMEOUT_MS = 900_000;
/** 静默到此只记一条日志 */
export const STREAM_STALL_LOG_MS = 90_000;
/**
 * 远端单次流的总寿命上限：涓流事件会不断重置空闲计时，网关滴灌或卡死的生成需要这道不重置的硬顶。
 * 留足超长输出（128k token 级）的余量；本机模型速度不可预期，不设。
 */
export const STREAM_MAX_LIFETIME_MS = 3_600_000;

const REPETITION_WINDOW = 16_384;
const REPETITION_MIN_SPAN = 4_000;
const REPETITION_MIN_REPEATS = 6;
const REPETITION_CHECK_STEP = 1_024;

export interface RepetitionCycle {
  /** 重复单元长度 */
  period: number;
  /** 末尾呈周期性的总长度 */
  span: number;
}

/**
 * 文本末尾是否陷入逐字循环：末尾 span 个字符以 period 为周期，且 span 足够长、重复足够多次。
 * 对窗口逆序求前缀函数，前缀 m 的最小周期 = m - π[m-1]，取满足阈值的最长 m。
 */
export function findRepetitionCycle(text: string): RepetitionCycle | undefined {
  const n = Math.min(text.length, REPETITION_WINDOW);
  if (n < REPETITION_MIN_SPAN) return undefined;
  const reversed = new Array<number>(n);
  for (let i = 0; i < n; i++) reversed[i] = text.charCodeAt(text.length - 1 - i);
  const pi = new Int32Array(n);
  for (let i = 1; i < n; i++) {
    let k = pi[i - 1];
    while (k > 0 && reversed[i] !== reversed[k]) k = pi[k - 1];
    if (reversed[i] === reversed[k]) k++;
    pi[i] = k;
  }
  for (let m = n; m >= REPETITION_MIN_SPAN; m--) {
    const period = m - pi[m - 1];
    if (m >= period * REPETITION_MIN_REPEATS) return { period, span: m };
  }
  return undefined;
}

type StreamMethod = (
  model: Model<Api>,
  context: Context,
  options?: unknown
) => AssistantMessageEventStream;

export interface StreamGuardOptions {
  onStall?: (silentMs: number, model: Model<Api>) => void;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function isLocalModel(model: Model<Api>): boolean {
  try {
    const host = new URL(model.baseUrl).hostname;
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    // 无 baseUrl 的 provider 按远端处理
    return false;
  }
}

function emptyMessage(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    timestamp: Date.now(),
    stopReason: 'error',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function blockText(message: AssistantMessage | undefined, index: number): string | undefined {
  const block = message?.content[index];
  if (block?.type === 'text') return block.text;
  if (block?.type === 'thinking') return block.thinking;
  return undefined;
}

function withBlockText(message: AssistantMessage, index: number, text: string): AssistantMessage {
  const content = message.content.map((block, i) => {
    if (i !== index) return block;
    if (block.type === 'text') return { ...block, text };
    if (block.type === 'thinking') return { ...block, thinking: text };
    return block;
  });
  return { ...message, content };
}

/**
 * 流守卫：事件间静默超时（先记卡顿日志，再中断并抛可重试错误）、远端总寿命上限（同为可重试错误）、
 * 正文 / 思考逐字复读检测（中断并抛不可重试错误）。
 * 守卫自己的中断通过派生 signal 传给上游；调用方的中断原样透传。
 */
export function guardStream(inner: StreamMethod, guard: StreamGuardOptions = {}): StreamMethod {
  return (model, context, options) => {
    const controller = new AbortController();
    const callerSignal = (options as { signal?: AbortSignal } | undefined)?.signal;
    if (callerSignal?.aborted) controller.abort(callerSignal.reason);
    else
      callerSignal?.addEventListener('abort', () => controller.abort(callerSignal.reason), {
        once: true,
      });
    const out = createAssistantMessageEventStream();
    const local = isLocalModel(model);
    const idleMs = local ? LOCAL_STREAM_IDLE_TIMEOUT_MS : STREAM_IDLE_TIMEOUT_MS;
    let finished = false;
    let partial: AssistantMessage | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
    const texts = new Map<number, string>();
    const checkedAt = new Map<number, number>();

    const clear = () => {
      clearTimeout(idleTimer);
      clearTimeout(stallTimer);
      clearTimeout(lifetimeTimer);
    };
    const fail = (text: string, base: AssistantMessage | undefined) => {
      if (finished) return;
      finished = true;
      clear();
      controller.abort();
      const error: AssistantMessage = {
        ...(base ?? emptyMessage(model)),
        stopReason: 'error',
        errorMessage: text,
      };
      out.push({ type: 'error', reason: 'error', error });
      out.end(error);
    };
    const arm = () => {
      clearTimeout(idleTimer);
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (guard.onStall) guard.onStall(STREAM_STALL_LOG_MS, model);
        else
          console.warn(
            `[stream-guard] ${model.provider}/${model.id}: no stream events for ${STREAM_STALL_LOG_MS / 1000}s`
          );
      }, STREAM_STALL_LOG_MS);
      idleTimer = setTimeout(
        () =>
          fail(
            `LLM stream timed out: no data received for ${Math.round(idleMs / 1000)}s, so the request was aborted.`,
            partial
          ),
        idleMs
      );
    };

    const input = inner(model, context, {
      ...(options as object | undefined),
      signal: controller.signal,
    });
    arm();
    if (!local)
      lifetimeTimer = setTimeout(
        () =>
          fail(
            `LLM stream timed out: still incomplete after ${Math.round(STREAM_MAX_LIFETIME_MS / 60_000)} minutes, so the request was aborted.`,
            partial
          ),
        STREAM_MAX_LIFETIME_MS
      );
    void (async () => {
      try {
        for await (const event of input) {
          if (finished) break;
          arm();
          if ('partial' in event) partial = event.partial;
          if (event.type === 'text_delta' || event.type === 'thinking_delta') {
            const index = event.contentIndex;
            const text = blockText(event.partial, index) ?? (texts.get(index) ?? '') + event.delta;
            texts.set(index, text);
            if (text.length - (checkedAt.get(index) ?? 0) >= REPETITION_CHECK_STEP) {
              checkedAt.set(index, text.length);
              const cycle = findRepetitionCycle(text);
              if (cycle) {
                const kept = text.slice(0, text.length - cycle.span + cycle.period);
                fail(
                  'Model output entered an exact repetition loop, so the response was stopped.',
                  withBlockText(event.partial, index, kept)
                );
                break;
              }
            }
          }
          out.push(event);
          if (event.type === 'done' || event.type === 'error') {
            finished = true;
            clear();
          }
        }
        if (!finished) {
          // 上游没推终态事件就结束：以它自己的最终结果收尾，保证 result() 一定会兑现
          const final = await input.result().catch(() => undefined);
          if (finished) return;
          if (final) {
            finished = true;
            clear();
            out.end(final);
          } else {
            fail('LLM stream ended without a final response.', partial);
          }
        }
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error), partial);
      }
    })();
    return out;
  };
}

/** 包共享 runtime 的出口（会话、压缩、辅助补全都经过这里）；虚拟模型递归到真实模型时再守卫 */
export function installStreamGuard(runtime: ModelRuntime, guard: StreamGuardOptions = {}): void {
  const target = runtime as unknown as { stream?: StreamMethod; streamSimple?: StreamMethod };
  for (const name of ['stream', 'streamSimple'] as const) {
    const method = target[name];
    if (typeof method !== 'function') continue;
    const original: StreamMethod = method.bind(runtime);
    const guarded = guardStream(original, guard);
    target[name] = (model, context, options) =>
      model.api === 'pi-virtual'
        ? original(model, context, options)
        : guarded(model, context, options);
  }
}
