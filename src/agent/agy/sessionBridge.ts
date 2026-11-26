import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { AgyToolCard, PromptMessage, TranslatorEffect } from '@shared/agy/types';
import type { ApprovalMode } from '@shared/types/agentConstants';
import type { ApprovalGate } from '../approval';
import { closeAgySession } from './registry';
import { openBoundAgySession } from './runtimeHost';
import type { AgyTurnResult } from './session';
import { readAgySessionId, writeAgySessionId } from './sessionStore';

type SessionEvent = { type: string; [key: string]: unknown };
type SessionListener = (event: SessionEvent) => void;

export interface AgyTurnHooks {
  messages: readonly PromptMessage[];
  modelId: string;
  modelLabel: string;
  signal?: AbortSignal;
  onText: (delta: string) => void;
  onThinking: (delta: string) => void;
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
  const tools: AgyToolCard[] = [];
  const storeFile = `${options.sessionDir}/agy-sessions.json`;
  const resumable = options.resumable !== false;

  const emit: SessionListener = (event) => {
    for (const listener of listeners) listener(event);
  };

  const bridge: AgySessionBridge = {
    async runTurn(input) {
      tools.length = 0;
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

  session.subscribe = ((listener: SessionListener) => {
    const wrapped: SessionListener = (event) => {
      listener(event);
      if (event.type === 'agent_end') publishTools(session, tools, listener);
    };
    listeners.add(wrapped);
    const unsub = origSubscribe(wrapped as Parameters<AgentSession['subscribe']>[0]);
    return () => {
      listeners.delete(wrapped);
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
  tools: AgyToolCard[],
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
  const existing = tools.find((tool) => tool.id === event.id);
  const card: AgyToolCard = {
    id: event.id,
    name: event.name,
    status: event.status,
    args: event.args,
    ...(event.output !== undefined ? { output: event.output } : {}),
  };
  if (!existing) {
    tools.push(card);
    emit({
      type: 'tool_execution_start',
      toolCallId: card.id,
      toolName: card.name,
      args: card.args,
    });
    return;
  }
  existing.status = card.status;
  existing.args = { ...existing.args, ...card.args };
  if (card.status === 'completed' || card.status === 'failed') {
    emit({
      type: 'tool_execution_end',
      toolCallId: card.id,
      toolName: card.name,
      isError: card.status === 'failed',
      result: {
        content: [{ type: 'text', text: card.output ?? card.status }],
        isError: card.status === 'failed',
      },
    });
  }
}

function publishTools(session: AgentSession, tools: AgyToolCard[], listener: SessionListener) {
  if (tools.length === 0) return;
  const list = liveMessages(session);
  const assistant = [...(list ?? [])].reverse().find(isAssistant) as
    | { role: string; content: unknown[] }
    | undefined;
  if (assistant && Array.isArray(assistant.content)) {
    for (const tool of tools) {
      if (assistant.content.some((part) => isToolCall(part, tool.id))) continue;
      assistant.content.push({
        type: 'toolCall',
        id: tool.id,
        name: tool.name,
        arguments: tool.args,
      });
    }
    listener({ type: 'message_update', message: assistant });
  }
  for (const tool of tools) {
    const message = {
      role: 'toolResult',
      toolCallId: tool.id,
      toolName: tool.name,
      content: [{ type: 'text', text: tool.output ?? tool.status }],
      isError: tool.status === 'failed',
      timestamp: Date.now(),
    };
    list?.push(message);
    listener({ type: 'message_start', message });
    listener({ type: 'message_end', message });
  }
  tools.length = 0;
}

function liveMessages(session: AgentSession): unknown[] | undefined {
  const direct = (session as { messages?: unknown }).messages;
  if (Array.isArray(direct)) return direct;
  const nested = (session as { agent?: { state?: { messages?: unknown[] } } }).agent?.state
    ?.messages;
  return Array.isArray(nested) ? nested : undefined;
}

function isAssistant(message: unknown): boolean {
  return Boolean(
    message && typeof message === 'object' && (message as { role?: string }).role === 'assistant'
  );
}

function isToolCall(part: unknown, id: string): boolean {
  return Boolean(
    part &&
      typeof part === 'object' &&
      (part as { type?: string }).type === 'toolCall' &&
      (part as { id?: string }).id === id
  );
}
