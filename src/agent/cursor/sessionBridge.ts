import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { emptyUsage } from '@shared/providers/piProviderTypes';
import {
  type CursorBridgeTool,
  type CursorExecDispatchResult,
  type CursorExecEvent,
  type CursorExecFrame,
  dispatchCursorExec,
} from './execBridge';
import { handleCursorInteractionQuery } from './interactionQuery';
import { encodeExecWriteBack, encodeInteractionWriteBack } from './writeBack';

type SessionEvent = { type: string; [key: string]: unknown };
type SessionListener = (event: SessionEvent) => void;

export interface CursorSessionBridge {
  tools: Map<string, CursorBridgeTool>;
  cwd: string;
  dispatch(frame: CursorExecFrame): Promise<CursorExecDispatchResult>;
  emitSessionEvents(events: CursorExecEvent[]): void;
}

/**
 * 所有会话共用一个 worker，不能用模块级变量记「当前会话」：轮次重叠时 exec 会派错会话。
 * pi-cursor 在每次 streamSimple 内开 HTTP/2 流（连接可能复用），Node 把流回调绑在
 * request() 调用方的异步上下文上，所以 prompt 内建立的作用域能沿流回调传到 exec 钩子。
 * 不经 prompt/steer 起的轮次拿不到桥，钩子返回 false 交回 pi-cursor 拒绝，不会派到别的会话。
 */
const boundBridge = new AsyncLocalStorage<CursorSessionBridge>();

export function getBoundCursorBridge(): CursorSessionBridge | undefined {
  return boundBridge.getStore();
}

export function isCursorModel(model: { provider?: string; api?: string }): boolean {
  return model.provider === 'cursor' || model.api === 'cursor-native';
}

type SessionTool = {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown
  ): Promise<{
    content: Array<{ type?: string; text?: string }>;
    isError?: boolean;
    details?: unknown;
  }>;
};

export function indexCursorTools(tools: ReadonlyArray<SessionTool>): Map<string, CursorBridgeTool> {
  const map = new Map<string, CursorBridgeTool>();
  for (const tool of tools) {
    if (!tool?.name) continue;
    map.set(tool.name, {
      name: tool.name,
      execute: (toolCallId, params, signal, onUpdate, ctx) =>
        tool.execute(toolCallId, params, signal, onUpdate, ctx),
    });
  }
  return map;
}

export function createCursorSessionBridge(options: {
  tools: ReadonlyArray<SessionTool>;
  cwd: string;
  emit?: (event: SessionEvent) => void;
}): CursorSessionBridge {
  const tools = indexCursorTools(options.tools);
  const pendingResults: CursorExecEvent[] = [];
  const emit = options.emit;

  const bridge: CursorSessionBridge = {
    tools,
    cwd: options.cwd,
    async dispatch(frame) {
      const dispatched = await dispatchCursorExec(frame, tools);
      pendingResults.push(...dispatched.events.filter((event) => event.type === 'toolResult'));
      if (emit) {
        for (const event of dispatched.events) emit(toAgentEvent(event, dispatched.args));
      }
      return dispatched;
    },
    emitSessionEvents(events) {
      if (!emit) return;
      for (const event of events) emit(toAgentEvent(event, event.arguments ?? {}));
    },
  };

  const drain = () => pendingResults.splice(0);
  (bridge as CursorSessionBridge & { drain: () => CursorExecEvent[] }).drain = drain;
  return bridge;
}

/** 接到 createAgentSession 之后、subscribe 之前：工具帧走本会话工具，事件进 session.subscribe。 */
export function attachCursorBridgeToSession(
  session: AgentSession,
  tools: ReadonlyArray<SessionTool>,
  cwd: string
): CursorSessionBridge {
  const listeners = new Set<SessionListener>();
  const origSubscribe = session.subscribe.bind(session);
  const origPrompt = session.prompt.bind(session);
  const origSteer = session.steer.bind(session);

  const emit: SessionListener = (event) => {
    if (event.type === 'tool_execution_start') {
      recordToolCallOnAssistant(session, event);
    }
    for (const listener of listeners) listener(event);
  };

  const bridge = createCursorSessionBridge({ tools, cwd, emit });
  const drain = (bridge as CursorSessionBridge & { drain: () => CursorExecEvent[] }).drain;

  session.subscribe = ((listener: SessionListener) => {
    const wrapped: SessionListener = (event) => {
      listener(event);
      if (event.type === 'message_end' && isAssistant(event.message)) {
        for (const result of drain()) {
          const message = toolResultMessage(result);
          liveMessages(session)?.push(message);
          listener({ type: 'message_start', message });
          listener({ type: 'message_end', message });
        }
      }
    };
    listeners.add(wrapped);
    const unsub = origSubscribe(wrapped as Parameters<AgentSession['subscribe']>[0]);
    return () => {
      listeners.delete(wrapped);
      unsub();
    };
  }) as AgentSession['subscribe'];

  session.prompt = (async (text, options) => {
    await boundBridge.run(bridge, () => origPrompt(text, options));
  }) as AgentSession['prompt'];

  session.steer = (async (text, images, options) =>
    boundBridge.run(bridge, () => origSteer(text, images, options))) as AgentSession['steer'];

  return bridge;
}

export function handlePiCursorExec(
  execCase: string | undefined,
  execMsg: {
    id?: number;
    execId?: string;
    message?: { case?: string; value?: Record<string, unknown> };
  },
  write: (bytes: Uint8Array) => void
): boolean | Promise<boolean> {
  const bridge = boundBridge.getStore();
  const frame = execFrameFromCase(execCase, execMsg.message?.value);
  if (!bridge || !frame) return false;
  return bridge.dispatch(frame).then((dispatched) => {
    write(encodeExecWriteBack(execCase || 'readArgs', execMsg, dispatched));
    return true;
  });
}

export function handlePiCursorInteraction(
  query: { id?: number; query?: { case?: string | null } },
  write: (bytes: Uint8Array) => void
): { handled: boolean; action: string; queryCase: string } | false {
  const queryCase = query.query?.case;
  // 无名 oneof 交给 pi-cursor 原 hi（unknown field 9 reject）；我们乱写会挡住那条路
  if (!queryCase) return false;
  const decision = handleCursorInteractionQuery({ id: query.id, queryCase });
  const bytes = encodeInteractionWriteBack(query.id ?? 0, decision);
  if (!bytes) return false;
  write(bytes);
  return {
    handled: decision.handled,
    action: decision.action,
    queryCase: decision.queryCase,
  };
}

function execFrameFromCase(
  execCase: string | undefined,
  value: Record<string, unknown> | undefined
): CursorExecFrame | null {
  const args = value ?? {};
  const toolCallId = str(args.toolCallId);
  switch (execCase) {
    case 'readArgs':
    case 'piRead':
      return {
        type: 'read',
        toolCallId,
        path: str(args.path) || '.',
        offset: num(args.offset),
        limit: num(args.limit),
      };
    case 'lsArgs':
    case 'piLs':
      return { type: 'ls', toolCallId, path: str(args.path) || '.' };
    case 'writeArgs':
    case 'piWrite': {
      const content =
        str(args.fileText) ||
        (args.fileBytes instanceof Uint8Array ? new TextDecoder().decode(args.fileBytes) : '') ||
        str(args.content);
      return { type: 'write', toolCallId, path: str(args.path) || '', content };
    }
    case 'piEdit': {
      const edits = Array.isArray(args.edits) ? args.edits : [];
      const first = (edits[0] ?? {}) as { oldText?: string; newText?: string };
      return {
        type: 'edit',
        toolCallId,
        path: str(args.path) || '',
        oldText: str(first.oldText) || str(args.oldText),
        newText: str(first.newText) || str(args.newText),
      };
    }
    case 'grepArgs':
    case 'piGrep':
      return {
        type: 'grep',
        toolCallId,
        pattern: str(args.pattern),
        path: str(args.path) || undefined,
        glob: str(args.glob) || undefined,
      };
    // 原生 shellArgs/shellStreamArgs 不接管：回写后 Cursor 不再推进，交给 pi-cursor 引导走 Pi bash
    case 'piBash':
      return {
        type: 'shell',
        toolCallId,
        command: str(args.command),
        cwd: str(args.workingDirectory) || undefined,
        timeout: num(args.timeout),
      };
    default:
      return null;
  }
}

function toAgentEvent(event: CursorExecEvent, args: Record<string, unknown>): SessionEvent {
  if (event.type === 'toolCall') {
    return {
      type: 'tool_execution_start',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args,
    };
  }
  return {
    type: 'tool_execution_end',
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    result: { content: event.content, isError: event.isError },
    isError: event.isError === true,
  };
}

function liveMessages(session: AgentSession): unknown[] | undefined {
  const direct = (session as { messages?: unknown }).messages;
  if (Array.isArray(direct)) return direct;
  const nested = (session as { agent?: { state?: { messages?: unknown[] } } }).agent?.state
    ?.messages;
  return Array.isArray(nested) ? nested : undefined;
}

function recordToolCallOnAssistant(session: AgentSession, event: SessionEvent): void {
  const list = liveMessages(session);
  const last = list?.at(-1) as { role?: string; content?: unknown[] } | undefined;
  const toolCall = {
    type: 'toolCall',
    id: event.toolCallId,
    name: event.toolName,
    arguments: event.args ?? {},
  };
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    if (
      !last.content.some(
        (part) =>
          Boolean(part) &&
          typeof part === 'object' &&
          (part as { type?: string; id?: string }).type === 'toolCall' &&
          (part as { id?: string }).id === event.toolCallId
      )
    ) {
      last.content.push(toolCall);
    }
    return;
  }
  list?.push({
    role: 'assistant',
    content: [toolCall],
    usage: emptyUsage(),
    timestamp: Date.now(),
  });
}

function toolResultMessage(event: CursorExecEvent) {
  return {
    role: 'toolResult',
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    content: event.content ?? [],
    isError: event.isError === true,
    timestamp: Date.now(),
  };
}

function isAssistant(message: unknown): boolean {
  return Boolean(
    message && typeof message === 'object' && (message as { role?: string }).role === 'assistant'
  );
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
