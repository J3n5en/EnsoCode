import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { type AgentToolResult, runToolCall } from '@earendil-works/pi-agent-core';
import {
  type AssistantMessage,
  getCurrentSystemPrompt,
  type JsonObject,
  type ToolCall,
} from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { AGY_API_ID, AGY_PROVIDER_ID } from '@shared/agy/constants';
import {
  type AgyHostToolSet,
  agyHostTools,
  ENSO_TOOL_CALL,
  ENSO_TOOL_SEARCH,
  lazyCallOf,
  mcpContent,
  searchLazyTools,
} from '@shared/agy/hostTools';
import { ensoSystemAppend } from '@shared/agy/systemAppend';
import type { AgyToolCard, PromptMessage, TranslatorEffect } from '@shared/agy/types';
import { emptyUsage } from '@shared/providers/piProviderTypes';
import type { ApprovalMode } from '@shared/types/agentConstants';
import type { ApprovalGate } from '../approval';
import { type HostMcpResult, issueHostMcp } from './hostMcp';
import { closeAgySession } from './registry';
import { openBoundAgySession } from './runtimeHost';
import type { AgyHostMcp, AgySession, AgyTurnResult } from './session';
import { readAgySessionId, writeAgySessionId } from './sessionStore';

type SessionEvent = { type: string; [key: string]: unknown };
type SessionListener = (event: SessionEvent) => void;
type Part = { type: string; id?: string; [key: string]: unknown };
type AssistantLike = { role: string; content: Part[]; [key: string]: unknown };
/** 工具卡。Enso 自己经 Host MCP 执行的那些带上真实结果（含 details），落盘时原样写进 toolResult。 */
type Card = AgyToolCard & { result?: AgentToolResult<unknown>; isError?: boolean };

export interface AgyTurnHooks {
  messages: readonly PromptMessage[];
  modelId: string;
  modelLabel: string;
  signal?: AbortSignal;
  onText: (delta: string) => void;
  onThinking: (delta: string) => void;
  /** 第一次看到某个 agy 工具时调用：provider 把 toolCall 放进正在流的 assistant，卡片实时出现 */
  onTool: (tool: { id: string; name: string; args: Record<string, unknown> }) => void;
}

export interface AgySessionBridge {
  runTurn(input: AgyTurnHooks): Promise<AgyTurnResult>;
}

const boundBridge = new AsyncLocalStorage<AgySessionBridge>();

export function getAgyBridge(): AgySessionBridge | undefined {
  return boundBridge.getStore();
}

export function attachAgyBridgeToSession(
  session: AgentSession,
  options: {
    ensoSessionId: string;
    cwd: string;
    sessionDir: string;
    clientVersion: string;
    gate: ApprovalGate;
    planActive: () => boolean;
    readRoots: () => readonly string[];
    /** 临时会话（插件 agent.run 等）不记 agy sessionId，下次也不 resume */
    resumable?: boolean;
  }
): AgySessionBridge {
  const tools = new Map<string, Card>();
  const storeFile = `${options.sessionDir}/agy-sessions.json`;
  const resumable = options.resumable !== false;
  let turn: AgyTurnHooks | undefined;
  /** 最近一次打开的 agy 会话：插话要发给它。换模型 / dispose 时 registry 会关掉它，steer 随之返回 false */
  let live: AgySession | undefined;

  // 合成的工具事件走 pi 自己的出口：桥可能在监听者之后才挂上（会话中途切到 agy）
  const emit: SessionListener = (event) => {
    (session as unknown as { _emit?: SessionListener })._emit?.call(session, event);
  };

  /** agy 经 Host MCP 调本会话的 Enso 工具：走会话自己的工具管线（参数校验、tool_call 钩子、审批包装）。 */
  const callEnsoTool = async (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<HostMcpResult> => {
    const hooks = turn;
    if (!hooks)
      return { content: [{ type: 'text', text: 'No EnsoCode turn is running.' }], isError: true };
    const id = `enso_${randomUUID()}`;
    tools.set(id, { id, name, status: 'in_progress', args });
    hooks.onTool({ id, name, args });
    emit({ type: 'tool_execution_start', toolCallId: id, toolName: name, args });
    // MCP 的 arguments 来自 JSON 解析，本来就是 JSON 值
    const toolCall: ToolCall = { type: 'toolCall', id, name, arguments: args as JsonObject };
    const outcome = await runToolCall(toolCall, {
      tools: session.agent.state.tools,
      assistantMessage: issuingMessage(toolCall),
      context: { messages: session.agent.state.messages, tools: session.agent.state.tools },
      beforeToolCall: session.agent.beforeToolCall,
      afterToolCall: session.agent.afterToolCall,
      signal: hooks.signal ? AbortSignal.any([signal, hooks.signal]) : signal,
      onUpdate: (partialResult) =>
        emit({
          type: 'tool_execution_update',
          toolCallId: id,
          toolName: name,
          args,
          partialResult,
        }),
    });
    const card = tools.get(id);
    if (card) {
      card.status = outcome.isError ? 'failed' : 'completed';
      card.result = outcome.result;
      card.isError = outcome.isError;
    }
    emit({
      type: 'tool_execution_end',
      toolCallId: id,
      toolName: name,
      result: outcome.result,
      isError: outcome.isError,
    });
    return { content: mcpContent(outcome.result.content), isError: outcome.isError };
  };

  const failed = (text: string): Promise<HostMcpResult> =>
    Promise.resolve({ content: [{ type: 'text', text }], isError: true });

  /**
   * agy 进程按直挂的工具名换（见 runtimeHost），懒加载的工具不进 key：每次查、调都按会话当下的工具表算，
   * 插件工具增减不用换进程。enso_tool_call 只认当下的懒加载工具，执行仍走会话自己的工具管线，
   * 卡片和落盘都是真实工具名和参数。
   */
  const hostMcpFor = (set: AgyHostToolSet): AgyHostMcp => {
    const names = set.eager.map((tool) => tool.name);
    const call = (name: string, args: Record<string, unknown>, signal: AbortSignal) => {
      if (!names.includes(name)) return failed(`Unknown tool ${name}`);
      if (name === ENSO_TOOL_SEARCH) {
        const { lazy } = agyHostTools(session.agent.state.tools);
        return Promise.resolve({
          content: [{ type: 'text', text: searchLazyTools(lazy, args.query) }],
        });
      }
      if (name !== ENSO_TOOL_CALL) return callEnsoTool(name, args, signal);
      const target = lazyCallOf(args);
      if ('error' in target) return failed(target.error);
      const { lazy } = agyHostTools(session.agent.state.tools);
      if (!lazy.some((tool) => tool.name === target.name)) {
        return failed(
          names.includes(target.name)
            ? `${target.name} is listed directly: call it as mcp_enso_${target.name}, not through ${ENSO_TOOL_CALL}.`
            : `No EnsoCode tool named ${target.name}. Find tools with ${ENSO_TOOL_SEARCH}.`
        );
      }
      return callEnsoTool(target.name, target.arguments, signal);
    };
    return {
      tools: names,
      issue: () => issueHostMcp({ tools: () => set.eager, call }),
    };
  };

  /**
   * 第一次真的跑 agy 时才挂：其他模型的会话（和 supervisor 测试里的假会话）的 steer / dispose 原样不动。
   * 插话的唯一入队点是 agent.steer（session.steer、streamingBehavior: 'steer'、Enso 的可撤回插话都经这里）：
   * 先照常进 pi 的队列，pi 在本段回复收尾后把它作为 user 消息送进上下文；agy 正在流时同时原样发给 agy。
   */
  let hooked = false;
  const hookAgySession = () => {
    if (hooked) return;
    hooked = true;
    const agent = session.agent as { steer?: (message: unknown) => void } | undefined;
    const steer = agent?.steer;
    if (agent && typeof steer === 'function') {
      agent.steer = (message: unknown) => {
        steer.call(agent, message);
        const row = message as PromptMessage | undefined;
        if (row?.role === 'user') live?.steer([row]);
      };
    }
    const dispose = session.dispose.bind(session);
    session.dispose = (() => {
      void closeAgySession(options.ensoSessionId);
      dispose();
    }) as AgentSession['dispose'];
  };

  const bridge: AgySessionBridge = {
    async runTurn(input) {
      // pi 这一轮的系统提示词（含 Enso 扩展追加的段）在上下文的 system 消息里；只取 Enso 自有段
      const systemAppend = ensoSystemAppend(getCurrentSystemPrompt(input.messages));
      const runtime = await openBoundAgySession({
        ensoSessionId: options.ensoSessionId,
        cwd: options.cwd,
        readRoots: options.readRoots(),
        clientVersion: options.clientVersion,
        resumeSessionId: resumable ? readAgySessionId(storeFile, options.ensoSessionId) : undefined,
        hostMcp: hostMcpFor(agyHostTools(session.agent.state.tools)),
        systemAppend,
      });
      live = runtime;
      hookAgySession();
      turn = input;
      const result = await runtime
        .turn({
          messages: input.messages,
          planMode: options.planActive(),
          approvalMode: options.gate.mode as ApprovalMode,
          workspaceRoot: options.cwd,
          modelId: input.modelId,
          thinkingLevel: session.thinkingLevel,
          modelLabel: input.modelLabel,
          systemAppend,
          signal: input.signal,
          ask: async (request, signal) => {
            const answer = await options.gate.ask(
              request.toolCall.title || request.toolCall.kind || 'agy',
              request.toolCall.kind === 'execute' ? 'command' : 'file-edit',
              request.toolCall.title || request.toolCall.toolCallId,
              signal,
              request.toolCall.toolCallId
            );
            if (answer === 'allow' || answer === 'deny' || answer === 'revise') return answer;
            if (answer === 'timeout' || answer === 'no-approver' || answer === 'block')
              return 'block';
            return 'cancel';
          },
          onEvent: (event) => noteTool(event, tools, emit, input),
        })
        .finally(() => {
          turn = undefined;
        });
      if (resumable) writeAgySessionId(storeFile, options.ensoSessionId, result.sessionId);
      return result;
    },
  };

  // pi 在监听者之后、agent-loop 找 toolCall 之前落盘 message_end：在这里把 agy 已执行的工具拆成
  // 「assistant(toolCall) + toolResult」写在最终回复之前，最终回复不留 toolCall，pi 不会再执行。
  session.subscribe(((event: SessionEvent) => {
    if (event.type === 'message_end') settleAgyTools(session, event.message, tools);
  }) as Parameters<AgentSession['subscribe']>[0]);

  // pi 的每次模型请求都经 agent.streamFunction：只给 agent 循环的对话请求（prompt、continue、重试）绑桥。
  // 压缩、分支摘要、bug 报告摘要也走它，但 agy 自己管上下文，它们一律不进 agy（见 isAgentLoopRequest）
  const agent = session.agent as { streamFunction?: (...args: unknown[]) => unknown } | undefined;
  const stream = agent?.streamFunction;
  if (agent && typeof stream === 'function') {
    agent.streamFunction = (...args: unknown[]) =>
      isAgentLoopRequest(args[2])
        ? boundBridge.run(bridge, () => stream.apply(agent, args))
        : stream.apply(agent, args);
  }
  disableAutoCompactionForAgy(session);
  return bridge;
}

const guardedSettings = new WeakSet<object>();

/**
 * agy 自己管上下文，Enso 每轮只把最后一条 user 发给它：压 Enso 的记录对 agy 毫无作用，
 * 只会多一条「已压缩」或一次失败提示。会话模型是 agy 时 pi 的自动压缩（阈值、溢出、截断重试、
 * 发请求前的阈值检查）一律不跑；手动压缩不看 enabled，照常经 compactGuard 走本地摘要。
 * 按模型判断：会话中途切走 agy，自动压缩随即恢复。
 */
function disableAutoCompactionForAgy(session: AgentSession): void {
  const settings = session.settingsManager as AgentSession['settingsManager'] | undefined;
  if (typeof settings?.getCompactionSettings !== 'function' || guardedSettings.has(settings)) {
    return;
  }
  guardedSettings.add(settings);
  const read = settings.getCompactionSettings.bind(settings);
  settings.getCompactionSettings = ((model) => {
    const value = read(model);
    return model?.provider === AGY_PROVIDER_ID ? { ...value, enabled: false } : value;
  }) as typeof settings.getCompactionSettings;
}

/**
 * agent 循环发请求时把整份 AgentLoopConfig 摊进 options，其中 `convertToLlm` 是必填项；
 * pi 的摘要类调用（compaction / branch summary / bug report）只给新建的 SimpleStreamOptions。
 */
function isAgentLoopRequest(options: unknown): boolean {
  return (
    typeof options === 'object' &&
    options !== null &&
    typeof (options as { convertToLlm?: unknown }).convertToLlm === 'function'
  );
}

function noteTool(
  event: TranslatorEffect,
  tools: Map<string, Card>,
  emit: SessionListener,
  input: AgyTurnHooks
) {
  if (event.type === 'text') {
    input.onText(event.delta);
    return;
  }
  if (event.type === 'thinking') {
    input.onThinking(event.delta);
    return;
  }
  if (event.type !== 'tool') return;
  const existing = tools.get(event.id);
  const card: AgyToolCard = {
    id: event.id,
    name: event.name,
    status: event.status,
    args: event.args,
    ...(event.output !== undefined ? { output: event.output } : {}),
  };
  if (!existing) {
    tools.set(card.id, card);
    input.onTool({ id: card.id, name: card.name, args: card.args });
    emit({
      type: 'tool_execution_start',
      toolCallId: card.id,
      toolName: card.name,
      args: card.args,
    });
    if (!isFinal(card.status)) return;
  } else {
    if (isFinal(existing.status)) return;
    existing.status = card.status;
    existing.args = { ...existing.args, ...card.args };
    if (card.output !== undefined) existing.output = card.output;
  }
  const current = tools.get(card.id) ?? card;
  if (current.output !== undefined) {
    emit({
      type: 'tool_execution_update',
      toolCallId: current.id,
      toolName: current.name,
      partialResult: { content: [{ type: 'text', text: current.output }] },
    });
  }
  if (!isFinal(current.status)) return;
  emit({
    type: 'tool_execution_end',
    toolCallId: current.id,
    toolName: current.name,
    isError: current.status === 'failed',
    result: toolResultContent(current),
  });
}

function isFinal(status: AgyToolCard['status']): boolean {
  return status === 'completed' || status === 'failed';
}

function toolResultContent(tool: Card) {
  if (tool.result) return { ...tool.result, isError: tool.isError === true };
  const isError = tool.status !== 'completed';
  return { content: [{ type: 'text', text: tool.output ?? tool.status }], isError };
}

/** runToolCall 要一条「发起这次调用的 assistant」交给钩子；agy 的调用没有，就合成一条。 */
function issuingMessage(toolCall: ToolCall): AssistantMessage {
  return {
    role: 'assistant',
    content: [toolCall],
    api: AGY_API_ID,
    provider: AGY_PROVIDER_ID,
    model: 'agy',
    usage: emptyUsage(),
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as AssistantMessage;
}

/**
 * 把最终 assistant 里的 toolCall 段拆出去：每段「文字… toolCall…」成一条 toolUse assistant，
 * 紧跟各自的 toolResult，插在最终回复前面（内存和会话文件同序）；最终回复只留最后一段文字。
 */
function settleAgyTools(session: AgentSession, message: unknown, tools: Map<string, Card>): void {
  const final = message as AssistantLike | undefined;
  if (final?.role !== 'assistant' || final.api !== AGY_API_ID || !Array.isArray(final.content))
    return;
  if (!final.content.some((part) => part.type === 'toolCall')) return;
  const inserted: unknown[] = [];
  let segment: Part[] = [];
  const flush = () => {
    inserted.push({
      role: 'assistant',
      content: segment,
      api: final.api,
      provider: final.provider,
      model: final.model,
      usage: emptyUsage(),
      stopReason: 'toolUse',
      timestamp: final.timestamp,
    });
    for (const part of segment) {
      if (part.type !== 'toolCall' || !part.id) continue;
      const tool = tools.get(part.id);
      const fallback: Card = {
        id: part.id,
        name: String(part.name ?? 'tool'),
        status: 'pending',
        args: {},
      };
      const body = toolResultContent(tool ?? fallback);
      inserted.push({
        role: 'toolResult',
        toolCallId: part.id,
        toolName: tool?.name ?? fallback.name,
        content: body.content,
        ...('details' in body && body.details !== undefined ? { details: body.details } : {}),
        isError: body.isError,
        timestamp: Date.now(),
      });
      tools.delete(part.id);
    }
    segment = [];
  };
  final.content.forEach((part, index) => {
    segment.push(part);
    const next = final.content[index + 1];
    if (part.type === 'toolCall' && next?.type !== 'toolCall') flush();
  });
  final.content = segment;
  const list = liveMessages(session);
  const at = list ? list.lastIndexOf(final) : -1;
  if (list && at >= 0) list.splice(at, 0, ...inserted);
  for (const entry of inserted) {
    session.sessionManager.appendMessage(
      entry as Parameters<AgentSession['sessionManager']['appendMessage']>[0]
    );
  }
}

function liveMessages(session: AgentSession): unknown[] | undefined {
  const direct = (session as { messages?: unknown }).messages;
  if (Array.isArray(direct)) return direct;
  const nested = (session as { agent?: { state?: { messages?: unknown[] } } }).agent?.state
    ?.messages;
  return Array.isArray(nested) ? nested : undefined;
}
