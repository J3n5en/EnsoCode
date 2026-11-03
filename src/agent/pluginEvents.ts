import { randomUUID } from 'node:crypto';
import type {
  ExtensionAPI,
  InlineExtension,
  InputEventResult,
  ToolCallEventResult,
  ToolResultEventResult,
} from '@earendil-works/pi-coding-agent';
import {
  AGENT_END_TEXT_MAX,
  CONTEXT_USAGE_BUCKETS,
  type ContextUsagePayload,
  isChildInterceptEvent,
  type PluginEventName,
  type PluginInterceptEvent,
} from '@shared/extensionPlugins/events';
import { PLUGIN_MESSAGE_TYPE, type PluginInjectImage } from '@shared/extensionPlugins/protocol';
import type { PluginEventPlan } from '@shared/extensionPlugins/types';
import type { ContextOccupancy, PluginInterceptRequest, TokenUsage } from '@shared/types/agent';

/** Main 等待 before_compact 最多 10 秒，本地再留余量后照常压缩 */
export const PLUGIN_COMPACT_TIMEOUT_MS = 12_000;
/** 拦截在 Main 侧按插件串行，本地兜底后放行 */
export const PLUGIN_INTERCEPT_TIMEOUT_MS = 30_000;
/** 子会话拦截在 Main 合计不超过 5 秒，本地再留余量后放行 */
export const PLUGIN_CHILD_INTERCEPT_TIMEOUT_MS = 8_000;

export type PluginSessionEmit =
  | { type: 'plugin-event'; event: PluginEventName; data: unknown }
  | ({ type: 'plugin-intercept'; requestId: string } & PluginInterceptRequest);

interface PendingIntercept {
  settle(value: unknown): void;
}

export interface PluginInjectMessage {
  pluginId: string;
  pluginName: string;
  text: string;
  images?: PluginInjectImage[];
  deliverAs: 'steer' | 'followUp' | 'nextTurn';
  triggerTurn: boolean;
}

type SendPluginMessage = ExtensionAPI['sendMessage'];

/** 插件看到的上下文占用：宿主分桶 + 最近一次带用量回复的实报 token */
export function contextUsagePayload(
  occupancy: ContextOccupancy,
  messages: ReadonlyArray<{ role?: string; usage?: TokenUsage }>
): ContextUsagePayload {
  const buckets = {} as ContextUsagePayload['buckets'];
  for (const id of CONTEXT_USAGE_BUCKETS) buckets[id] = occupancy.buckets[id];
  const last = messages.findLast((message) => message.role === 'assistant' && message.usage);
  const usage = last?.usage;
  return {
    used: occupancy.used,
    estimated: occupancy.estimated,
    ...(occupancy.contextWindow !== undefined ? { contextWindow: occupancy.contextWindow } : {}),
    ...(occupancy.percent !== undefined ? { percent: occupancy.percent } : {}),
    buckets,
    ...(usage
      ? {
          usage: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          },
        }
      : {}),
  };
}

/**
 * 子会话（子代理、coworker）的事件计划：通知型订阅全保留，拦截只保留 tool_call
 * （否则派子代理就能绕过工具拦截）；input / tool_result 的改写与注入只对主会话开放。
 */
export function childPluginEventPlan(
  plan: PluginEventPlan | undefined
): PluginEventPlan | undefined {
  if (!plan) return undefined;
  const intercept = plan.intercept.filter((item) => isChildInterceptEvent(item.event));
  if (plan.observe.length === 0 && intercept.length === 0) return undefined;
  return { observe: [...plan.observe], intercept, inject: false };
}

/**
 * 插件事件挂起表。通知型只上抛；拦截与 before_compact 等 Main 回复。
 * 超时、失败、shutdown 都放行，不把异常抛回 pi。
 */
export class PluginEventInvoker {
  private readonly pending = new Map<string, PendingIntercept>();
  private sender: SendPluginMessage | undefined;

  constructor(
    readonly plan: PluginEventPlan,
    private readonly emit: (event: PluginSessionEmit) => void,
    private readonly options: {
      interceptTimeoutMs?: number;
      compactTimeoutMs?: number;
      /** 子会话：只拦 tool_call（本地兜底更短），其余拦截项忽略，before_compact 只通知不等 */
      childSession?: boolean;
    } = {}
  ) {}

  get childSession(): boolean {
    return this.options.childSession === true;
  }

  /** 计划里声明了拦截，且本会话允许拦这个事件 */
  intercepts(event: PluginInterceptEvent): boolean {
    if (this.childSession && !isChildInterceptEvent(event)) return false;
    return this.plan.intercept.some((item) => item.event === event);
  }

  bindSender(sender: SendPluginMessage): void {
    this.sender = sender;
  }

  notify(event: PluginEventName, data: unknown): void {
    try {
      this.emit({ type: 'plugin-event', event, data });
    } catch {
      // 会话已释放：通知可以丢
    }
  }

  intercept<R extends PluginInterceptRequest>(
    event: R['event'],
    payload: R['payload']
  ): Promise<unknown> {
    const requestId = randomUUID();
    const timeoutMs =
      event === 'before_compact'
        ? (this.options.compactTimeoutMs ?? PLUGIN_COMPACT_TIMEOUT_MS)
        : (this.options.interceptTimeoutMs ??
          (this.childSession ? PLUGIN_CHILD_INTERCEPT_TIMEOUT_MS : PLUGIN_INTERCEPT_TIMEOUT_MS));
    let settled = false;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(value);
      };
      timer = setTimeout(() => finish(undefined), timeoutMs);
      this.pending.set(requestId, { settle: finish });
      try {
        this.emit({ type: 'plugin-intercept', requestId, event, payload } as PluginSessionEmit);
      } catch {
        finish(undefined);
      }
    });
  }

  resolve(result: { requestId: string; ok: boolean; result?: unknown }): boolean {
    const entry = this.pending.get(result.requestId);
    if (!entry) return false;
    entry.settle(result.ok ? result.result : undefined);
    return true;
  }

  /**
   * 结束所有挂起的等待。主会话缺省放行，不把插件失败变成工具失败；
   * 子会话只挂 tool_call，缺省按拦下收敛，避免未检查完的工具在中断或解雇后继续执行。
   */
  cancelAll(outcome?: unknown): void {
    const value =
      outcome ??
      (this.childSession
        ? { block: true, reason: '子会话已中断或关闭，插件检查未完成' }
        : undefined);
    for (const entry of [...this.pending.values()]) entry.settle(value);
  }

  deliver(message: PluginInjectMessage): { ok: true } | { ok: false; error: string } {
    // 主会话一律接收：事件计划在会话启动时拍下，之后启用的插件也要能发进来。
    // 能不能发由 Main 的权限门决定；子会话的注入仍不对它开放。
    if (this.childSession) return { ok: false, error: '会话未声明注入' };
    if (!this.sender) return { ok: false, error: '会话未就绪' };
    try {
      this.sender(
        {
          customType: PLUGIN_MESSAGE_TYPE,
          content: message.images?.length
            ? [
                { type: 'text' as const, text: message.text },
                ...message.images.map((image) => ({ type: 'image' as const, ...image })),
              ]
            : message.text,
          display: true,
          details: { pluginId: message.pluginId, pluginName: message.pluginName },
        },
        { deliverAs: message.deliverAs, triggerTurn: message.triggerTurn }
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  watchesTool(event: PluginInterceptEvent, toolName: string): boolean {
    const entry = this.plan.intercept.find((item) => item.event === event);
    if (!entry) return false;
    return !entry.tools || entry.tools.length === 0 || entry.tools.includes(toolName);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

const textContent = (content: readonly { type?: string; text?: string }[]): string =>
  content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');

/** 本轮最后一条助手消息的文字部分；agent_end.messages 只含本轮 */
function lastAssistantText(messages: readonly unknown[] | undefined): string {
  const last = [...(messages ?? [])]
    .reverse()
    .find((m) => (m as { role?: unknown })?.role === 'assistant') as
    | { content?: unknown }
    | undefined;
  const parts = Array.isArray(last?.content) ? last.content : [];
  return parts
    .flatMap((p: { type?: unknown; text?: unknown }) =>
      p?.type === 'text' && typeof p.text === 'string' ? [p.text] : []
    )
    .join('\n')
    .slice(0, AGENT_END_TEXT_MAX);
}

function applyToolCall(
  input: Record<string, unknown>,
  raw: unknown
): ToolCallEventResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const result = raw as { block?: unknown; reason?: unknown; input?: unknown };
  if (result.block === true) {
    return {
      block: true,
      ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
    };
  }
  if (result.input && typeof result.input === 'object' && !Array.isArray(result.input)) {
    for (const key of Object.keys(input)) delete input[key];
    Object.assign(input, result.input);
  }
  return undefined;
}

function applyToolResult(raw: unknown): ToolResultEventResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const result = raw as { content?: unknown; isError?: unknown };
  const next: ToolResultEventResult = {};
  if (typeof result.content === 'string') {
    next.content = [{ type: 'text', text: result.content }];
  }
  if (typeof result.isError === 'boolean') next.isError = result.isError;
  return next.content || next.isError !== undefined ? next : undefined;
}

function applyInput(
  raw: unknown,
  images: ReadonlyArray<{ type: string }> | undefined
): InputEventResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const result = raw as { action?: unknown; text?: unknown };
  if (result.action === 'handled') return { action: 'handled' };
  if (result.action === 'transform' && typeof result.text === 'string') {
    const kept = images as NonNullable<
      Extract<InputEventResult, { action: 'transform' }>['images']
    >;
    return { action: 'transform', text: result.text, ...(images ? { images: kept } : {}) };
  }
  return undefined;
}

/** 只订阅计划里声明的事件。工具不在过滤名单里的拦截不上报。 */
export function createPluginEventsExtension(invoker: PluginEventInvoker): InlineExtension {
  const observe = new Set(invoker.plan.observe);
  return {
    name: 'enso-plugin-events',
    hidden: true,
    factory: (pi) => {
      invoker.bindSender((message, options) => pi.sendMessage(message, options));
      if (observe.has('session_start')) {
        pi.on('session_start', (event) => {
          invoker.notify('session_start', { reason: event.reason });
        });
      }
      if (observe.has('session_end')) {
        pi.on('session_shutdown', (event) => {
          invoker.notify('session_end', { reason: event.reason });
        });
      }
      if (observe.has('agent_start')) {
        pi.on('agent_start', () => {
          invoker.notify('agent_start', {});
        });
      }
      if (observe.has('agent_end')) {
        pi.on('agent_end', (event) => {
          invoker.notify('agent_end', { text: lastAssistantText(event.messages) });
        });
      }
      if (observe.has('before_compact')) {
        pi.on('session_before_compact', async (event) => {
          if (invoker.childSession) {
            invoker.notify('before_compact', { reason: event.reason });
            return;
          }
          try {
            await invoker.intercept('before_compact', { reason: event.reason });
          } catch {
            // 超时已放行；这里再兜一层，压缩照常进行
          }
        });
      }
      if (observe.has('after_compact')) {
        pi.on('session_compact', (event) => {
          invoker.notify('after_compact', { reason: event.reason });
        });
      }
      const intercepts = (event: PluginInterceptEvent) => invoker.intercepts(event);
      if (intercepts('tool_call') || observe.has('tool_call')) {
        pi.on('tool_call', async (event) => {
          const input = event.input as Record<string, unknown>;
          let result: ToolCallEventResult | undefined;
          if (intercepts('tool_call') && invoker.watchesTool('tool_call', event.toolName)) {
            try {
              result = applyToolCall(
                input,
                await invoker.intercept('tool_call', {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  input: { ...input },
                })
              );
            } catch {
              result = undefined;
            }
          }
          if (observe.has('tool_call') && !result?.block) {
            invoker.notify('tool_call', {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: { ...input },
            });
          }
          return result;
        });
      }
      if (intercepts('tool_result') || observe.has('tool_result')) {
        pi.on('tool_result', async (event) => {
          let result: ToolResultEventResult | undefined;
          if (intercepts('tool_result') && invoker.watchesTool('tool_result', event.toolName)) {
            try {
              result = applyToolResult(
                await invoker.intercept('tool_result', {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  input: event.input,
                  content: textContent(event.content),
                  isError: event.isError,
                })
              );
            } catch {
              result = undefined;
            }
          }
          if (observe.has('tool_result')) {
            invoker.notify('tool_result', {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input,
              content: textContent(result?.content ?? event.content),
              isError: result?.isError ?? event.isError,
            });
          }
          return result;
        });
      }
      if (intercepts('input') || observe.has('input')) {
        pi.on('input', async (event) => {
          if (event.source === 'extension') return;
          let result: InputEventResult | undefined;
          if (intercepts('input')) {
            try {
              result = applyInput(
                await invoker.intercept('input', { text: event.text, source: event.source }),
                event.images
              );
            } catch {
              result = undefined;
            }
          }
          if (observe.has('input') && result?.action !== 'handled') {
            invoker.notify('input', {
              text: result?.action === 'transform' ? result.text : event.text,
              source: event.source,
            });
          }
          return result;
        });
      }
    },
  };
}
