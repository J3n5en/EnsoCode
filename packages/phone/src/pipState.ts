import type { CatalogEntry } from '@enso/pair';
import type { GuestSessionView } from '@shared/pair/guestProjection';
import type { ProjectedMessage, ProjectedPart } from '@shared/types/agent';
import type {
  NativePipAspect,
  NativePipMessage,
  NativePipPendingDetail,
  NativePipSnapshot,
  NativePipTodoSummary,
  NativePipToolStep,
} from './nativeBridge';
import { DeskWidgetTracker } from './widgetState';

/**
 * iOS 画中画实时对话浮窗的状态模型（纯函数 + 追踪器，便于单测）：
 * 精简版从 GuestSessionView 投影，完整版从 agent:event 流自建一份轻量消息表。
 * 投影口径尽量与桌面/手机对话区（MessageTimeline）对齐：
 * - 工具调用与 toolResult 按 toolCallId 配对，显示真实状态（running / ok / error）与失败摘要
 * - 连续多条工具自动折叠为 `tool-group` 过程组（如「已完成 · 2 条命令、1 次读取」），不刷屏淹没对话正文
 * - 展示独立 `thinking` 思考过程行（流式展开尾巴、完成后折叠摘要）
 * - 保留更长的 Markdown 正文与代码块，并提取最新未完成 todo 清单与审批/提问详情
 */

export const NATIVE_PIP_AUTO_KEY = 'enso-native-pip-auto';
export const NATIVE_PIP_ASPECT_KEY = 'enso-native-pip-aspect';
export const PIP_MAX_MESSAGES = 18;
/** 流式出字时推给原生的最小间隔：够顺滑，又不把 WKWebView postMessage 打满 */
export const PIP_SYNC_INTERVAL_MS = 120;
const LAST_ITEM_CHARS = 1200;
const ITEM_CHARS = 420;
const THINKING_TAIL_CHARS = 180;
const HINT_CHARS = 90;
const OUTPUT_PREVIEW_CHARS = 140;
/** 只投影最近这么多条原始消息：工具结果与调用配对后数量会收敛，留足够窗口保留多轮上下文 */
const RAW_WINDOW = 80;
const ARG_HINT_KEYS = [
  'command',
  'path',
  'file_path',
  'pattern',
  'query',
  'url',
  'description',
  'label',
  'question',
  'title',
  'prompt',
] as const;

const TOOL_DISPLAY_LABELS: Readonly<Record<string, string>> = {
  bash: '终端',
  powershell: '终端',
  read: '读取',
  write: '写入',
  edit: '编辑',
  apply_patch: '补丁',
  grep: '搜索',
  find: '查找',
  ls: '列目录',
  codemode: '沙箱',
  exec: '沙箱',
  subagent: '子代理',
  workflow: '工作流',
  web_search: '联网搜索',
  web_fetch: '抓取网页',
  todo: '待办',
  ask_user: '提问',
  remind_me: '提醒',
  reminder_cancel: '取消提醒',
  memory_search: '检索记忆',
  memory_capture: '记录记忆',
};

const READ_TOOLS = new Set(['read', 'ls', 'image_view']);
const SEARCH_TOOLS = new Set(['grep', 'find', 'web_search', 'web_fetch', 'memory_search']);
const COMMAND_TOOLS = new Set(['bash', 'powershell', 'codemode', 'exec']);
const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch']);

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

export function loadNativePipAspect(storage: Pick<Storage, 'getItem'>): NativePipAspect {
  try {
    const raw = storage.getItem(NATIVE_PIP_ASPECT_KEY);
    if (raw === 'portrait' || raw === 'square' || raw === 'landscape') return raw;
  } catch {}
  return 'portrait';
}

export function saveNativePipAspect(
  storage: Pick<Storage, 'setItem'>,
  aspect: NativePipAspect
): void {
  try {
    storage.setItem(NATIVE_PIP_ASPECT_KEY, aspect);
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

function displayToolName(name: string): string {
  return TOOL_DISPLAY_LABELS[name] ?? name;
}

/** 缩短文件路径，保留末尾 2 段（如 `App/EnsoPiPController.swift`），更适合窄窗扫读 */
function shortPath(raw: string): string {
  const clean = raw.trim();
  if (!clean.includes('/')) return clean;
  const segs = clean.split('/').filter(Boolean);
  if (segs.length <= 2) return clean;
  return segs.slice(-2).join('/');
}

/** 提取工具参数中最有信息量的一行摘要，不再重复拼接工具名 */
function toolCallSummary(name: string, args: unknown): string {
  if (isRecord(args)) {
    if (name === 'apply_patch' && typeof args.input === 'string') {
      const files = [...args.input.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)]
        .map((m) => shortPath(m[1] ?? ''))
        .filter(Boolean);
      if (files.length === 1) return files[0] ?? '';
      if (files.length > 1) return `${files[0]} 等 ${files.length} 个文件`;
    }
    if (name === 'todo' && Array.isArray(args.todos)) {
      const done = args.todos.filter((t) => isRecord(t) && t.status === 'completed').length;
      return `${done}/${args.todos.length} 项`;
    }
    if (name === 'subagent') {
      const op = typeof args.operation === 'string' ? args.operation : '';
      const desc = typeof args.description === 'string' ? args.description.trim() : '';
      if (desc) return firstLine(desc, HINT_CHARS);
      if (op) return op;
    }
    for (const key of ARG_HINT_KEYS) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) {
        const formatted = key === 'path' || key === 'file_path' ? shortPath(value) : value;
        return firstLine(formatted, HINT_CHARS);
      }
    }
  }
  return '';
}

/** 从消息流中提取最近一次未完成的 todo 清单（对齐桌面 TodoBar） */
export function extractLatestTodo(
  messages: readonly ProjectedMessage[]
): NativePipTodoSummary | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (let k = msg.content.length - 1; k >= 0; k -= 1) {
      const part = msg.content[k];
      if (part?.type !== 'toolCall' || part.name !== 'todo' || !isRecord(part.arguments)) continue;
      const raw = part.arguments.todos;
      if (!Array.isArray(raw) || raw.length === 0) return null;
      let done = 0;
      let current: string | null = null;
      let firstPending: string | null = null;
      let total = 0;
      for (const item of raw) {
        if (!isRecord(item) || typeof item.content !== 'string') continue;
        total += 1;
        if (item.status === 'completed') done += 1;
        else if (item.status === 'in_progress' && !current) current = firstLine(item.content, 80);
        else if (!firstPending) firstPending = firstLine(item.content, 80);
      }
      if (total === 0 || done >= total) return null;
      return { done, total, current: current ?? firstPending };
    }
  }
  return null;
}

function summarizeToolGroup(steps: readonly NativePipToolStep[], running: boolean): string {
  let commands = 0;
  let reads = 0;
  let searches = 0;
  let edits = 0;
  let others = 0;
  for (const s of steps) {
    if (COMMAND_TOOLS.has(s.name)) commands += 1;
    else if (READ_TOOLS.has(s.name)) reads += 1;
    else if (SEARCH_TOOLS.has(s.name)) searches += 1;
    else if (EDIT_TOOLS.has(s.name)) edits += 1;
    else others += 1;
  }
  const parts: string[] = [];
  if (edits > 0) parts.push(`${edits} 处修改`);
  if (commands > 0) parts.push(`${commands} 条命令`);
  if (reads > 0) parts.push(`${reads} 次读取`);
  if (searches > 0) parts.push(`${searches} 次检索`);
  if (others > 0) parts.push(`${others} 项操作`);
  const prefix = running ? '执行中' : '已完成';
  return parts.length > 0 ? `${prefix} · ${parts.join('、')}` : `${prefix} ${steps.length} 步`;
}

interface RawToolEntry {
  id: string;
  rawName: string;
  label: string;
  summary: string;
  state: 'running' | 'ok' | 'error';
  output: string | null;
  timestamp: number;
}

/** 把相邻 ≥2 条工具步聚合成一条 `tool-group`，单条则保持 `tool`（对齐桌面过程折叠组） */
function flushToolsInto(items: NativePipMessage[], buffer: RawToolEntry[]): void {
  if (buffer.length === 0) return;
  if (buffer.length === 1) {
    const only = buffer[0];
    if (only) {
      items.push({
        id: only.id,
        role: 'tool',
        text: only.summary,
        toolName: only.label,
        toolState: only.state,
        detail: only.output,
        steps: null,
        stepCount: null,
        isStreaming: only.state === 'running',
        isError: only.state === 'error',
        timestamp: only.timestamp,
      });
    }
    buffer.length = 0;
    return;
  }
  const hasError = buffer.some((s) => s.state === 'error');
  const hasRunning = buffer.some((s) => s.state === 'running');
  const groupState: 'running' | 'ok' | 'error' = hasRunning ? 'running' : hasError ? 'error' : 'ok';
  const steps: NativePipToolStep[] = buffer.map((entry) => ({
    id: entry.id,
    name: entry.rawName,
    summary: entry.summary ? `${entry.label} · ${entry.summary}` : entry.label,
    state: entry.state,
    output: entry.output,
  }));
  // 组内只展示末尾 3 步，避免把正文顶出视口
  const visibleSteps = steps.slice(-3);
  const last = buffer[buffer.length - 1];
  items.push({
    id: `grp:${buffer[0]?.id ?? ''}:${last?.id ?? ''}`,
    role: 'tool-group',
    text: summarizeToolGroup(steps, hasRunning),
    toolName: null,
    toolState: groupState,
    detail: hasError ? (buffer.findLast((s) => s.state === 'error')?.output ?? null) : null,
    steps: visibleSteps,
    stepCount: steps.length,
    isStreaming: hasRunning,
    isError: hasError,
    timestamp: last?.timestamp ?? 0,
  });
  buffer.length = 0;
}

/**
 * 把会话消息投影成与对话区对齐的时间线项：
 * - `user`：用户气泡（含图片占位）
 * - `thinking`：模型思考行（流式展尾巴，完成后一行摘要）
 * - `tool` / `tool-group`：工具调用与 toolResult 配对后的状态行/过程组（含 running/ok/error 与报错预览）
 * - `assistant`：保留完整 Markdown 正文与代码块
 * - `system`：错误中断说明
 */
export function projectMessagesForPip(
  messages: readonly ProjectedMessage[],
  opts: { isRunning?: boolean; maxItems?: number; baseIndex?: number } = {}
): NativePipMessage[] {
  const baseIndex = opts.baseIndex ?? 0;
  const start = Math.max(0, messages.length - RAW_WINDOW);
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  // 预扫描 toolResult，按 toolCallId 建立配对索引，这样每条 toolCall 都知道自己成功/报错/仍在运行
  const resultsByCallId = new Map<
    string,
    { isError: boolean; output: string | null; toolName: string | null }
  >();
  for (let i = start; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg?.role !== 'toolResult') continue;
    const callId = typeof msg.toolCallId === 'string' && msg.toolCallId ? msg.toolCallId : null;
    if (!callId) continue;
    const isError = msg.isError === true;
    const rawErr = isError
      ? normalize(msg.errorMessage ?? '') || joinText(msg.content, 'text')
      : '';
    resultsByCallId.set(callId, {
      isError,
      output: rawErr ? firstLine(rawErr, OUTPUT_PREVIEW_CHARS) : null,
      toolName: msg.toolName ?? null,
    });
  }

  const items: NativePipMessage[] = [];
  const toolBuffer: RawToolEntry[] = [];
  const flushTools = () => flushToolsInto(items, toolBuffer);

  for (let i = start; i < messages.length; i += 1) {
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
        toolState: null,
        detail: null,
        steps: null,
        stepCount: null,
        isStreaming: false,
        isError: false,
        timestamp,
        ...extra,
      });
    };
    if (msg.role === 'user') {
      flushTools();
      const text =
        joinText(msg.content, 'text') ||
        (msg.content.some((part) => part.type === 'image') ? '[图片]' : '');
      if (text) add('', 'user', text);
    } else if (msg.role === 'assistant') {
      const streaming = opts.isRunning === true && i === lastAssistant;
      const thinking = joinText(msg.content, 'thinking');
      const text = joinText(msg.content, 'text');
      const hasToolCalls = msg.content.some((part) => part.type === 'toolCall');
      const onlyThinkingNow = streaming && !text && !hasToolCalls;
      if (thinking && (onlyThinkingNow || !text)) {
        flushTools();
        add(
          'th',
          'thinking',
          onlyThinkingNow
            ? clip(thinking, THINKING_TAIL_CHARS, true)
            : firstLine(thinking, HINT_CHARS),
          { isStreaming: onlyThinkingNow }
        );
      } else if (onlyThinkingNow) {
        flushTools();
        add('th', 'thinking', '思考中…', { isStreaming: true });
      }

      if (text) {
        flushTools();
        add('', 'assistant', text, { isStreaming: streaming && !hasToolCalls });
      }

      msg.content.forEach((part, k) => {
        if (part.type !== 'toolCall') return;
        const result = part.id ? resultsByCallId.get(part.id) : undefined;
        const state: 'running' | 'ok' | 'error' = result
          ? result.isError
            ? 'error'
            : 'ok'
          : streaming
            ? 'running'
            : 'ok';
        toolBuffer.push({
          id: `${id}:t${k}`,
          rawName: part.name,
          label: displayToolName(part.name),
          summary: toolCallSummary(part.name, part.arguments),
          state,
          output: result?.output ?? null,
          timestamp,
        });
      });

      if (msg.stopReason === 'error' && msg.errorMessage?.trim()) {
        flushTools();
        add('e', 'system', normalize(msg.errorMessage), { isError: true });
      }
    } else if (msg.role === 'toolResult' && msg.isError === true) {
      // 已经与上面的 toolCall 配对过的不重复输出；孤立报错仍保留
      const callId = typeof msg.toolCallId === 'string' && msg.toolCallId ? msg.toolCallId : null;
      if (callId && resultsByCallId.has(callId)) continue;
      const toolName = msg.toolName ?? '工具';
      const detail = normalize(msg.errorMessage ?? '') || joinText(msg.content, 'text');
      toolBuffer.push({
        id,
        rawName: toolName,
        label: displayToolName(toolName),
        summary: firstLine(detail || `${toolName} 执行失败`, HINT_CHARS),
        state: 'error',
        output: firstLine(detail, OUTPUT_PREVIEW_CHARS) || null,
        timestamp,
      });
    }
  }
  flushTools();
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

function approvalDetail(req: Record<string, unknown>): NativePipPendingDetail {
  const tool =
    typeof req.tool === 'string' && req.tool
      ? req.tool
      : typeof req.toolName === 'string' && req.toolName
        ? req.toolName
        : '';
  const rawSummary = typeof req.summary === 'string' ? req.summary.trim() : '';
  return {
    kind: 'approval',
    title: tool ? `等待审批 · ${displayToolName(tool)}` : '等待审批',
    summary: rawSummary ? firstLine(rawSummary, 140) : null,
  };
}

function askDetail(ask: Record<string, unknown>): NativePipPendingDetail {
  const question = typeof ask.question === 'string' ? ask.question.trim() : '';
  const options = Array.isArray(ask.options)
    ? ask.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
    : [];
  return {
    kind: 'ask',
    title: question ? firstLine(question, 90) : '等待回答',
    summary: options.length > 0 ? options.slice(0, 3).join(' / ') : null,
  };
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
  /** requestId → 详细审批/提问卡片 */
  approvalDetails: Map<string, NativePipPendingDetail>;
  askDetails: Map<string, NativePipPendingDetail>;
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
        approvalDetails: new Map(),
        askDetails: new Map(),
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
        session.approvalDetails.clear();
        session.askDetails.clear();
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
          approvalDetails: new Map(),
          askDetails: new Map(),
          updatedAt: lastTimestamp(messages) ?? prev?.updatedAt ?? now,
        };
        if (Array.isArray(snap.pendingApprovals)) {
          for (const req of snap.pendingApprovals) {
            if (isRecord(req) && typeof req.requestId === 'string') {
              session.approvals.set(req.requestId, approvalHint(req.tool ?? req.toolName));
              session.approvalDetails.set(req.requestId, approvalDetail(req));
            }
          }
        }
        if (Array.isArray(snap.pendingAsks)) {
          for (const ask of snap.pendingAsks) {
            if (isRecord(ask) && typeof ask.requestId === 'string' && !ask.answered) {
              session.asks.set(ask.requestId, askHint(ask.question));
              session.askDetails.set(ask.requestId, askDetail(ask));
            }
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
          session.approvalDetails.clear();
          session.askDetails.clear();
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
        session.approvalDetails.set(req.requestId, approvalDetail(req));
        session.updatedAt = now;
        return true;
      }
      case 'ask-request': {
        const ask = isRecord(event.ask) ? event.ask : null;
        if (!ask || typeof ask.requestId !== 'string') return false;
        const session = this.ensure(sid, now);
        session.asks.set(ask.requestId, askHint(ask.question));
        session.askDetails.set(ask.requestId, askDetail(ask));
        session.updatedAt = now;
        return true;
      }
      case 'approval-resolved':
      case 'ask-resolved': {
        const session = this.sessions.get(sid);
        if (!session || typeof event.requestId !== 'string') return false;
        const pending = type === 'approval-resolved' ? session.approvals : session.asks;
        const details = type === 'approval-resolved' ? session.approvalDetails : session.askDetails;
        details.delete(event.requestId);
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
        session.approvalDetails.clear();
        session.askDetails.clear();
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
    theme?: 'dark' | 'light';
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
    const pendingDetail = session
      ? (session.approvalDetails.values().next().value ??
        session.askDetails.values().next().value ??
        null)
      : null;
    return {
      sessionId,
      title: meta?.title ?? (sessionId ? '未命名会话' : params.deviceLabel || 'EnsoCode'),
      projectName: meta?.projectName ?? params.deviceLabel,
      status: resolveStatus(params.connectionState, pending, session?.status ?? 'idle'),
      pendingHint: hint ?? otherPendingHint(pendingCount),
      pendingDetail,
      todo: extractLatestTodo(tail.messages),
      meta: null,
      theme: params.theme ?? 'dark',
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
  theme?: 'dark' | 'light';
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
  const pendingDetail: NativePipPendingDetail | null = approval
    ? approvalDetail(approval as unknown as Record<string, unknown>)
    : ask
      ? askDetail(ask as unknown as Record<string, unknown>)
      : null;
  const tail = view ? contiguousTail(view.messages) : { messages: [], baseIndex: 0 };
  const status = view?.status ?? entry?.status ?? 'idle';
  const metaParts: string[] = [];
  if (entry?.modelLabel) metaParts.push(entry.modelLabel);
  if (entry?.context && typeof entry.context.used === 'number' && entry.context.max > 0) {
    const pct = Math.min(100, Math.round((entry.context.used / entry.context.max) * 100));
    metaParts.push(`${pct}%`);
  }
  return {
    sessionId: activeId,
    title: entry?.title?.trim() || (activeId ? '未命名会话' : input.deviceLabel || 'EnsoCode'),
    projectName: entry?.projectName || input.deviceLabel,
    status: resolveStatus(input.connectionState, pending, status),
    pendingHint: hint ?? otherPendingHint(pending > 0 ? pending : pendingCount),
    pendingDetail,
    todo: extractLatestTodo(tail.messages),
    meta: metaParts.length > 0 ? metaParts.join(' · ') : null,
    theme: input.theme ?? 'dark',
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
