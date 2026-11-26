import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { AGY_API_ID } from '@shared/agy/constants';
import type { AgyToolCard, PromptMessage, TranslatorEffect } from '@shared/agy/types';
import { emptyUsage } from '@shared/providers/piProviderTypes';
import type { ApprovalMode } from '@shared/types/agentConstants';
import type { ApprovalGate } from '../approval';
import { closeAgySession } from './registry';
import { openBoundAgySession } from './runtimeHost';
import type { AgyTurnResult } from './session';
import { readAgySessionId, writeAgySessionId } from './sessionStore';

type SessionEvent = { type: string; [key: string]: unknown };
type SessionListener = (event: SessionEvent) => void;
type Part = { type: string; id?: string; [key: string]: unknown };
type AssistantLike = { role: string; content: Part[]; [key: string]: unknown };

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
  const listeners = new Set<SessionListener>();
  const origSubscribe = session.subscribe.bind(session);
  const origPrompt = session.prompt.bind(session);
  const origSteer = session.steer.bind(session);
  const origDispose = session.dispose.bind(session);
  const tools = new Map<string, AgyToolCard>();
  const storeFile = `${options.sessionDir}/agy-sessions.json`;
  const resumable = options.resumable !== false;

  const emit: SessionListener = (event) => {
    for (const listener of listeners) listener(event);
  };

  const bridge: AgySessionBridge = {
    async runTurn(input) {
      const runtime = await openBoundAgySession({
        ensoSessionId: options.ensoSessionId,
        cwd: options.cwd,
        readRoots: options.readRoots(),
        clientVersion: options.clientVersion,
        resumeSessionId: resumable ? readAgySessionId(storeFile, options.ensoSessionId) : undefined,
      });
      const result = await runtime.turn({
        messages: input.messages,
        planMode: options.planActive(),
        approvalMode: options.gate.mode as ApprovalMode,
        workspaceRoot: options.cwd,
        modelId: input.modelId,
        thinkingLevel: session.thinkingLevel,
        modelLabel: input.modelLabel,
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
      });
      if (resumable) writeAgySessionId(storeFile, options.ensoSessionId, result.sessionId);
      return result;
    },
  };

  // pi 在监听者之后、agent-loop 找 toolCall 之前落盘 message_end：在这里把 agy 已执行的工具拆成
  // 「assistant(toolCall) + toolResult」写在最终回复之前，最终回复不留 toolCall，pi 不会再执行。
  origSubscribe(((event: SessionEvent) => {
    if (event.type === 'message_end') settleAgyTools(session, event.message, tools);
  }) as Parameters<AgentSession['subscribe']>[0]);

  session.subscribe = ((listener: SessionListener) => {
    listeners.add(listener);
    const unsub = origSubscribe(listener as Parameters<AgentSession['subscribe']>[0]);
    return () => {
      listeners.delete(listener);
      unsub();
    };
  }) as AgentSession['subscribe'];

  session.prompt = (async (text, promptOptions) => {
    await boundBridge.run(bridge, () => origPrompt(text, promptOptions));
  }) as AgentSession['prompt'];
  session.steer = (async (text, images, steerOptions) =>
    boundBridge.run(bridge, () => origSteer(text, images, steerOptions))) as AgentSession['steer'];
  session.dispose = (() => {
    void closeAgySession(options.ensoSessionId);
    origDispose();
  }) as AgentSession['dispose'];
  return bridge;
}

function noteTool(
  event: TranslatorEffect,
  tools: Map<string, AgyToolCard>,
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

function toolResultContent(tool: AgyToolCard) {
  const isError = tool.status !== 'completed';
  return { content: [{ type: 'text', text: tool.output ?? tool.status }], isError };
}

/**
 * 把最终 assistant 里的 toolCall 段拆出去：每段「文字… toolCall…」成一条 toolUse assistant，
 * 紧跟各自的 toolResult，插在最终回复前面（内存和会话文件同序）；最终回复只留最后一段文字。
 */
function settleAgyTools(
  session: AgentSession,
  message: unknown,
  tools: Map<string, AgyToolCard>
): void {
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
      const fallback: AgyToolCard = {
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
