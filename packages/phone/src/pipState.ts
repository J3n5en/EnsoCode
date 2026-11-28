import type { CatalogEntry } from '@enso/pair';
import type { GuestSessionView } from '@shared/pair/guestProjection';
import type { ProjectedMessage, ProjectedPart } from '@shared/types/agent';
import type { NativePipMessage, NativePipSnapshot } from './nativeBridge';
import { DeskWidgetTracker } from './widgetState';

/**
 * iOS 画中画实时对话浮窗的状态模型（纯函数 + 追踪器，便于单测）：
 * 精简版从 GuestSessionView 投影，完整版从 agent:event 流自建一份轻量消息表。
 */

export const NATIVE_PIP_AUTO_KEY = 'enso-native-pip-auto';
export const PIP_MAX_MESSAGES = 12;
/** 流式出字时推给原生的最小间隔：够顺滑，又不把 WKWebView postMessage 打满 */
export const PIP_SYNC_INTERVAL_MS = 120;
const LAST_ITEM_CHARS = 480;
const ITEM_CHARS = 220;
const THINKING_TAIL_CHARS = 120;
const HINT_CHARS = 80;
/** 只投影最近这么多条原始消息：工具结果多数不上卡片，留余量凑满 12 条 */
const RAW_WINDOW = 48;
const ARG_HINT_KEYS = ['path', 'command', 'pattern', 'query'] as const;

type PipStatus = NativePipSnapshot['status'];

export function loadNativePipAuto(storage: Pick<Storage, 'getItem'>): boolean {
  try {
    return storage.getItem(NATIVE_PIP_AUTO_KEY) === 'on';
  } catch {
    return false;
  }
}

export function saveNativePipAuto(storage: Pick<Storage, 'setItem'>, enabled: boolean): void {
  try {
    storage.setItem(NATIVE_PIP_AUTO_KEY, enabled ? 'on' : 'off');
  } catch {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(text: string, max: number, fromEnd: boolean): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return fromEnd
    ? `…${chars.slice(-max).join('').trimStart()}`
    : `${chars.slice(0, max).join('').trimEnd()}…`;
}

function firstLine(text: string, max: number): string {
  return clip(text.trim().split('\n')[0]?.trim() ?? '', max, false);
}

function joinText(parts: readonly ProjectedPart[], type: 'text' | 'thinking'): string {
  const out: string[] = [];
  for (const part of parts) if (part.type === type) out.push(part.text);
  return normalize(out.join('\n'));
}

function toolCallText(name: string, args: unknown): string {
  if (isRecord(args)) {
    for (const key of ARG_HINT_KEYS) {
      const value = args[key];
      if (typeof value === 'string' && value.trim())
        return `${name} · ${firstLine(value, HINT_CHARS)}`;
    }
  }
  return name;
}

/** 把会话消息投影成画中画卡片：只留对话正文、工具动作与失败，原始工具输出不上卡片 */
export function projectMessagesForPip(
  messages: readonly ProjectedMessage[],
  opts: { isRunning?: boolean; maxItems?: number; baseIndex?: number } = {}
): NativePipMessage[] {
  const baseIndex = opts.baseIndex ?? 0;
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  const items: NativePipMessage[] = [];
  for (let i = Math.max(0, messages.length - RAW_WINDOW); i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || !Array.isArray(msg.content)) continue;
    const id = String(baseIndex + i);
    const timestamp = Math.round(msg.timestamp ?? 0);
    const add = (
      suffix: string,
      role: NativePipMessage['role'],
      text: string,
      extra: Partial<NativePipMessage> = {}
    ) => {
      items.push({
        id: suffix ? `${id}:${suffix}` : id,
        role,
        text,
        toolName: null,
        isStreaming: false,
        isError: false,
        timestamp,
        ...extra,
      });
    };
    if (msg.role === 'user') {
      const text =
        joinText(msg.content, 'text') ||
        (msg.content.some((part) => part.type === 'image') ? '[图片]' : '');
      if (text) add('', 'user', text);
    } else if (msg.role === 'assistant') {
      const from = items.length;
      const streaming = opts.isRunning === true && i === lastAssistant;
      const text = joinText(msg.content, 'text');
      if (text) add('', 'assistant', text);
      msg.content.forEach((part, k) => {
        if (part.type === 'toolCall')
          add(`t${k}`, 'tool', toolCallText(part.name, part.arguments), { toolName: part.name });
      });
      if (streaming && items.length === from) {
        const thinking = joinText(msg.content, 'thinking');
        add(
          '',
          'assistant',
          thinking ? `思考中…\n${clip(thinking, THINKING_TAIL_CHARS, true)}` : '思考中…'
        );
      }
      const last = items[items.length - 1];
      if (streaming && last && items.length > from) last.isStreaming = true;
      if (msg.stopReason === 'error' && msg.errorMessage?.trim())
        add('e', 'system', normalize(msg.errorMessage), { isError: true });
    } else if (msg.role === 'toolResult' && msg.isError === true) {
      const toolName = msg.toolName ?? null;
      const detail = normalize(msg.errorMessage ?? '') || joinText(msg.content, 'text');
      add('', 'tool', detail || `${toolName ?? '工具'} 执行失败`, { toolName, isError: true });
    }
  }
  const kept = items.slice(-(opts.maxItems ?? PIP_MAX_MESSAGES));
  return kept.map((item, k) => {
    const isLast = k === kept.length - 1;
    const fromEnd = item.isStreaming || (isLast && item.role === 'assistant');
    return { ...item, text: clip(item.text, isLast ? LAST_ITEM_CHARS : ITEM_CHARS, fromEnd) };
  });
}

/** 按 index 存的消息表取末尾连续的一段（中间有空洞就停），供投影按绝对 index 生成稳定 id */
function contiguousTail(
  messages: ReadonlyMap<number, ProjectedMessage>,
  limit = RAW_WINDOW
): { messages: ProjectedMessage[]; baseIndex: number } {
  let end = -1;
  for (const index of messages.keys()) if (index > end) end = index;
  const out: ProjectedMessage[] = [];
  let index = end;
  while (out.length < limit && index >= 0) {
    const msg = messages.get(index);
    if (!msg) break;
    out.push(msg);
    index -= 1;
  }
  out.reverse();
  return { messages: out, baseIndex: index + 1 };
}

function resolveStatus(connectionState: string, pending: number, status: string): PipStatus {
  if (connectionState !== 'online') return 'offline';
  if (pending > 0) return 'pending';
  if (status === 'running') return 'running';
  if (status === 'failed') return 'failed';
  return 'idle';
}

function approvalHint(tool: unknown): string {
  return typeof tool === 'string' && tool ? `等待审批 ${tool}` : '等待审批';
}

function askHint(question: unknown): string {
  return typeof question === 'string' && question.trim()
    ? firstLine(question, HINT_CHARS)
    : '等待回答';
}

function otherPendingHint(pendingCount: number): string | null {
  return pendingCount > 0 ? `有 ${pendingCount} 项待确认` : null;
}

interface PipSession {
  /** key = 绝对消息 index，与 message-upsert 同口径 */
  messages: Map<number, ProjectedMessage>;
  status: string;
  /** requestId → 卡片提示 */
  approvals: Map<string, string>;
  asks: Map<string, string>;
  updatedAt: number;
}

const pendingOf = (session: PipSession) => session.approvals.size + session.asks.size;

function isProjectedMessage(value: unknown): value is ProjectedMessage {
  return isRecord(value) && typeof value.role === 'string' && Array.isArray(value.content);
}

function parseJson(json: string | undefined): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function firstArg(payloadJson: string): unknown {
  const args = parseJson(payloadJson);
  return Array.isArray(args) ? args[0] : args;
}

/** 从 invoke 入参（`[sessionId, …]` 或 `[{ conversationId | sessionId }]`）取会话 id */
export function parseInvokeSessionId(payloadJson: string): string | null {
  const arg = firstArg(payloadJson);
  if (typeof arg === 'string') return arg || null;
  if (!isRecord(arg)) return null;
  const id = arg.conversationId ?? arg.sessionId;
  return typeof id === 'string' && id ? id : null;
}

function lastTimestamp(messages: readonly ProjectedMessage[]): number | undefined {
  const ts = messages[messages.length - 1]?.timestamp;
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : undefined;
}

/**
 * 完整版（Desk 模式）画中画追踪器：
 * - 会话标题 / 项目名 / 桌面当前会话取自 settings、source-authority、conversations 读结果与补丁
 * - 消息、运行态、待确认取自 agent:event 与 agent:parent-history-tail；子会话不上浮窗
 */
export class DeskPipTracker {
  private readonly directory = new DeskWidgetTracker();
  private readonly sessions = new Map<string, PipSession>();
  private focusedSessionId: string | null = null;

  ingestSettingsJson(json: string | undefined): boolean {
    return this.directory.ingestSettingsJson(json);
  }

  ingestSourceAuthorityJson(json: string | undefined): boolean {
    return this.directory.ingestSourceAuthorityJson(json);
  }

  ingestConversationsJson(json: string | undefined): boolean {
    return this.directory.ingestConversationsJson(json);
  }

  applyConversationsPatchPayload(payloadJson: string): boolean {
    let changed = this.directory.applyConversationsPatchPayload(payloadJson);
    const patch = firstArg(payloadJson);
    if (isRecord(patch) && Array.isArray(patch.removes)) {
      for (const id of patch.removes) {
        if (typeof id === 'string' && this.sessions.delete(id)) changed = true;
      }
    }
    return changed;
  }

  setFocusedSession(sessionId: string | null): boolean {
    if (this.focusedSessionId === sessionId) return false;
    this.focusedSessionId = sessionId;
    return true;
  }

  private ensure(sessionId: string, now: number): PipSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        messages: new Map(),
        status: 'idle',
        approvals: new Map(),
        asks: new Map(),
        updatedAt: now,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  /** agent:parent-history-tail 结果：只补表里还没有的 index，实时事件比历史尾窗新 */
  ingestHistoryTail(conversationId: string, responseJson: string, now = Date.now()): boolean {
    const result = parseJson(responseJson);
    if (!isRecord(result) || result.ok !== true || !Array.isArray(result.messages)) return false;
    const baseIndex = typeof result.baseIndex === 'number' ? result.baseIndex : 0;
    const session = this.ensure(conversationId, now);
    let changed = false;
    result.messages.forEach((msg, k) => {
      const index = baseIndex + k;
      if (!isProjectedMessage(msg) || session.messages.has(index)) return;
      session.messages.set(index, msg);
      changed = true;
    });
    if (changed) session.updatedAt = now;
    return changed;
  }

  applyAgentEventPayload(payloadJson: string, now = Date.now()): boolean {
    const event = firstArg(payloadJson);
    if (!isRecord(event) || typeof event.type !== 'string') return false;
    return this.applyAgentEvent(event, now);
  }

  private applyAgentEvent(event: Record<string, unknown>, now: number): boolean {
    const type = event.type;
    if (type === 'worker-crashed' || type === 'worker-restarted') {
      let changed = false;
      for (const session of this.sessions.values()) {
        if (session.status !== 'running' && pendingOf(session) === 0) continue;
        session.status = 'idle';
        session.approvals.clear();
        session.asks.clear();
        changed = true;
      }
      return changed;
    }

    if (type === 'snapshot' && Array.isArray(event.sessions)) {
      const listed = new Set<string>();
      for (const snap of event.sessions) {
        if (!isRecord(snap) || !isRecord(snap.identity)) continue;
        const sid = snap.identity.sessionId;
        if (typeof sid !== 'string' || !sid) continue;
        if (typeof snap.identity.parentSessionId === 'string' && snap.identity.parentSessionId)
          continue;
        listed.add(sid);
        const messages = Array.isArray(snap.messages)
          ? snap.messages.filter(isProjectedMessage)
          : [];
        const baseIndex = typeof snap.baseIndex === 'number' ? snap.baseIndex : 0;
        const prev = this.sessions.get(sid);
        const session: PipSession = {
          messages: new Map(messages.map((msg, k) => [baseIndex + k, msg])),
          status: typeof snap.status === 'string' ? snap.status : 'idle',
          approvals: new Map(),
          asks: new Map(),
          updatedAt: lastTimestamp(messages) ?? prev?.updatedAt ?? now,
        };
        if (Array.isArray(snap.pendingApprovals)) {
          for (const req of snap.pendingApprovals) {
            if (isRecord(req) && typeof req.requestId === 'string')
              session.approvals.set(req.requestId, approvalHint(req.tool ?? req.toolName));
          }
        }
        if (Array.isArray(snap.pendingAsks)) {
          for (const ask of snap.pendingAsks) {
            if (isRecord(ask) && typeof ask.requestId === 'string' && !ask.answered)
              session.asks.set(ask.requestId, askHint(ask.question));
          }
        }
        this.sessions.set(sid, session);
      }
      // 全量快照没列出的会话已不在 worker 里：消息留着可看，运行态归零
      if (event.partial !== true && typeof event.sessionId !== 'string') {
        for (const [sid, session] of this.sessions) {
          if (listed.has(sid)) continue;
          session.status = 'idle';
          session.approvals.clear();
          session.asks.clear();
        }
      }
      return true;
    }

    const identity = isRecord(event.identity) ? event.identity : null;
    const sid = identity && typeof identity.sessionId === 'string' ? identity.sessionId : '';
    if (!sid) return false;
    if (identity && typeof identity.parentSessionId === 'string' && identity.parentSessionId)
      return false;

    switch (type) {
      case 'message-upsert': {
        if (typeof event.index !== 'number' || !isProjectedMessage(event.message)) return false;
        const session = this.ensure(sid, now);
        session.messages.set(event.index, event.message);
        session.updatedAt = now;
        return true;
      }
      case 'messages-truncated': {
        const length = event.length;
        const session = this.sessions.get(sid);
        if (!session || typeof length !== 'number') return false;
        let changed = false;
        for (const index of [...session.messages.keys()]) {
          if (index >= length) changed = session.messages.delete(index) || changed;
        }
        if (changed) session.updatedAt = now;
        return changed;
      }
      case 'status': {
        if (typeof event.status !== 'string') return false;
        const session = this.ensure(sid, now);
        const changed = session.status !== event.status;
        session.status = event.status;
        session.updatedAt = now;
        return changed;
      }
      case 'approval-request': {
        const req = isRecord(event.request) ? event.request : null;
        if (!req || typeof req.requestId !== 'string') return false;
        const session = this.ensure(sid, now);
        session.approvals.set(req.requestId, approvalHint(req.tool ?? req.toolName));
        session.updatedAt = now;
        return true;
      }
      case 'ask-request': {
        const ask = isRecord(event.ask) ? event.ask : null;
        if (!ask || typeof ask.requestId !== 'string') return false;
        const session = this.ensure(sid, now);
        session.asks.set(ask.requestId, askHint(ask.question));
        session.updatedAt = now;
        return true;
      }
      case 'approval-resolved':
      case 'ask-resolved': {
        const session = this.sessions.get(sid);
        if (!session || typeof event.requestId !== 'string') return false;
        const pending = type === 'approval-resolved' ? session.approvals : session.asks;
        if (!pending.delete(event.requestId)) return false;
        session.updatedAt = now;
        return true;
      }
      case 'turn-completed':
      case 'turn-failed':
      case 'parent-ended': {
        const session = this.sessions.get(sid);
        if (!session) return false;
        session.status = type === 'turn-failed' ? 'failed' : 'idle';
        session.approvals.clear();
        session.asks.clear();
        session.updatedAt = now;
        return true;
      }
      default:
        return false;
    }
  }

  /** 浮窗跟哪个会话：正在看且有动静的 > 待确认 > 运行中 > 正在看的 > 最近有消息的 */
  private pickFocus(): string | null {
    const focused = this.focusedSessionId ?? this.directory.activeConversationId;
    const focusedSession = focused ? this.sessions.get(focused) : undefined;
    if (focusedSession && (pendingOf(focusedSession) > 0 || focusedSession.status === 'running'))
      return focused;
    const recent = [...this.sessions].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    const pick =
      recent.find(([, s]) => pendingOf(s) > 0) ?? recent.find(([, s]) => s.status === 'running');
    if (pick) return pick[0];
    if (focused && (focusedSession || this.directory.describeSession(focused, ''))) return focused;
    return recent.find(([, s]) => s.messages.size > 0)?.[0] ?? null;
  }

  buildSnapshot(params: {
    deviceLabel: string;
    connectionState: string;
    now?: number;
  }): NativePipSnapshot {
    let runningCount = 0;
    let pendingCount = 0;
    for (const session of this.sessions.values()) {
      if (session.status === 'running') runningCount += 1;
      pendingCount += pendingOf(session);
    }
    const sessionId = this.pickFocus();
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const meta = sessionId ? this.directory.describeSession(sessionId, params.deviceLabel) : null;
    const tail = session ? contiguousTail(session.messages) : { messages: [], baseIndex: 0 };
    const pending = session ? pendingOf(session) : 0;
    const hint = session
      ? (session.approvals.values().next().value ?? session.asks.values().next().value)
      : undefined;
    return {
      sessionId,
      title: meta?.title ?? (sessionId ? '未命名会话' : params.deviceLabel || 'EnsoCode'),
      projectName: meta?.projectName ?? params.deviceLabel,
      status: resolveStatus(params.connectionState, pending, session?.status ?? 'idle'),
      pendingHint: hint ?? otherPendingHint(pendingCount),
      runningCount,
      pendingCount,
      connectionState: params.connectionState,
      messages: projectMessagesForPip(tail.messages, {
        isRunning: session?.status === 'running',
        baseIndex: tail.baseIndex,
      }),
      updatedAt: Math.round(params.now ?? Date.now()),
    };
  }
}

/** 精简版：当前打开的会话视图 + 会话目录 → 画中画快照 */
export function buildPipSnapshotFromGuestView(input: {
  activeId: string | null;
  entry: CatalogEntry | undefined;
  view: GuestSessionView | undefined;
  catalog: readonly CatalogEntry[];
  connectionState: string;
  deviceLabel: string;
  now?: number;
}): NativePipSnapshot {
  const { activeId, entry, view } = input;
  let runningCount = 0;
  let pendingCount = 0;
  for (const c of input.catalog) {
    if (c.archived || c.parentId) continue;
    if (c.status === 'running') runningCount += 1;
    pendingCount += (c.pendingApprovalCount ?? 0) + (c.pendingAskCount ?? 0);
  }
  const approval = view?.approvals[0];
  const ask = view?.asks.find((a) => !a.answered);
  const pending = view
    ? view.approvals.length + view.asks.filter((a) => !a.answered).length
    : (entry?.pendingApprovalCount ?? 0) + (entry?.pendingAskCount ?? 0);
  const hint = approval ? approvalHint(approval.tool) : ask ? askHint(ask.question) : null;
  const tail = view ? contiguousTail(view.messages) : { messages: [], baseIndex: 0 };
  const status = view?.status ?? entry?.status ?? 'idle';
  return {
    sessionId: activeId,
    title: entry?.title?.trim() || (activeId ? '未命名会话' : input.deviceLabel || 'EnsoCode'),
    projectName: entry?.projectName || input.deviceLabel,
    status: resolveStatus(input.connectionState, pending, status),
    pendingHint: hint ?? otherPendingHint(pending > 0 ? pending : pendingCount),
    runningCount,
    pendingCount,
    connectionState: input.connectionState,
    messages: projectMessagesForPip(tail.messages, {
      isRunning: status === 'running',
      baseIndex: tail.baseIndex,
    }),
    updatedAt: Math.round(input.now ?? Date.now()),
  };
}

/** 尾随节流：一段时间内的多次 schedule 合成一次；flush 立即执行并清掉挂起的那次 */
export function createTrailingThrottle(run: () => void, intervalMs = PIP_SYNC_INTERVAL_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    schedule() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        run();
      }, intervalMs);
    },
    flush() {
      cancel();
      run();
    },
    cancel,
  };
}
