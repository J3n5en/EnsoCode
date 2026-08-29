import type {
  AgentSessionCustomEntry,
  ProjectedMessage,
  TodoItem,
  TurnPerf,
} from '@shared/types/agent';

/** edit 工具的单个替换块（pi edit 工具参数 edits[] 的元素） */
export interface EditBlock {
  oldText: string;
  newText: string;
}

export type TimelineItem =
  | { kind: 'user'; key: string; text: string; images: { data: string; mimeType: string }[] }
  | {
      kind: 'text';
      key: string;
      text: string;
      streaming: boolean;
      timestamp?: number;
      perf?: TurnPerf;
    }
  | {
      kind: 'thinking';
      key: string;
      text: string;
      streaming: boolean;
      /** 思考耗时（结束后显示）；无打点为 null */
      durationMs: number | null;
      /** 思考起点（流式计时用）；无打点则缺省 */
      startedAt?: number;
    }
  | {
      kind: 'tool';
      key: string;
      name: string;
      summary: string;
      output: string | null;
      state: 'running' | 'ok' | 'error';
      /** edit 工具的替换块，用于渲染 diff；非 edit 为 null */
      edits: EditBlock[] | null;
      /** write 工具写入的文件内容,展开即可查看;非 write 为 null */
      writeContent: string | null;
      /** todo 工具的清单快照；非 todo 为 null */
      todos: TodoItem[] | null;
      /** 工具执行耗时（完成后显示）；未知为 null */
      durationMs: number | null;
      /** subagent 工具的执行元数据（模型/token/步数）；非 subagent 为 null */
      agentMeta: { modelId?: string; outputTokens?: number; steps?: number } | null;
    }
  | {
      kind: 'tool-group';
      key: string;
      expanded: boolean;
      /** 组内工具数（不含 edit——它平铺在组外） */
      count: number;
      stats: ToolGroupStats;
      /** 组内原始行（tool + 夹在其间的 thinking），展开时平铺为顶层行 */
      children: TimelineItem[];
    }
  | { kind: 'error'; key: string; text: string }
  /** 后台任务完成的合成注入消息（<background-task-update>），渲染为系统通知行 */
  | { kind: 'task-note'; key: string; summary: string; detail: string }
  /** 不进入 LLM context 的 parent/child SessionManager custom entry。 */
  | { kind: 'session-custom'; key: string; entry: AgentSessionCustomEntry };

export interface ToolGroupStats {
  commands: number;
  reads: number;
  searches: number;
  others: number;
}

/** 从工具参数里挑一个最能说明「对什么操作」的字段做摘要 */
const SUMMARY_KEYS = [
  'path',
  'file_path',
  'command',
  'pattern',
  'query',
  'url',
  'description',
  'summary',
  'reason',
];

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  const json = JSON.stringify(record);
  return json === '{}' ? '' : json.slice(0, 80);
}

/** write 工具参数里取出写入内容 */
function extractWriteContent(name: string, args: unknown): string | null {
  if (name !== 'write' || !args || typeof args !== 'object') return null;
  const content = (args as Record<string, unknown>).content;
  return typeof content === 'string' && content ? content : null;
}

/** edit 工具参数里取出替换块（保持同一数组引用，供 memo 做引用比较） */
function extractEdits(name: string, args: unknown): EditBlock[] | null {
  if (name !== 'edit' || !args || typeof args !== 'object') return null;
  let edits = (args as Record<string, unknown>).edits;
  // 部分模型把 edits 数组双重编码成 JSON 字符串（worker 执行侧已归一化，渲染侧同样兜底）
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const ok = edits.every(
    (e) =>
      e &&
      typeof e === 'object' &&
      typeof (e as EditBlock).oldText === 'string' &&
      typeof (e as EditBlock).newText === 'string'
  );
  return ok ? (edits as EditBlock[]) : null;
}

const partText = (message: ProjectedMessage): string =>
  message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

/** content 中最后一个「有内容」的 part（空白 text / unknown 不算）；全空返回 -1 */
function findLastActivePartIndex(content: ProjectedMessage['content']): number {
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (part.type === 'text' && part.text.trim()) return i;
    if (part.type === 'thinking' && part.text) return i;
    if (part.type === 'toolCall' || part.type === 'image') return i;
  }
  return -1;
}

/** 从该 step 的计时打点算 hover 操作条读数；打点不全则无对应字段 */
function perfFromTiming(message: ProjectedMessage): TurnPerf | undefined {
  const timing = message.timing;
  if (!timing?.completedMs) return undefined;
  const { stepStartMs, firstTokenMs, completedMs } = timing;
  const out = message.usage?.output ?? 0;
  const decodeMs = firstTokenMs !== undefined ? completedMs - firstTokenMs : 0;
  return {
    runMs: Math.max(0, completedMs - stepStartMs),
    ...(firstTokenMs !== undefined ? { ttftMs: Math.max(0, firstTokenMs - stepStartMs) } : {}),
    ...(out > 0 && decodeMs > 0 ? { tps: out / (decodeMs / 1000) } : {}),
  };
}

/**
 * 把消息投影聚合为渲染时间线：
 * - toolResult 不单独成行，折进对应 toolCall 条目（按 toolCallId 关联）
 * - assistant 的 text/thinking 各自成块，未完结（isLast 且会话 running）的块标 streaming
 * 纯函数，输入不被修改。
 */
function buildMessageTimeline(messages: ProjectedMessage[], running: boolean): TimelineItem[] {
  const results = new Map<
    string,
    {
      output: string;
      isError: boolean;
      todos: TodoItem[] | null;
      durationMs: number | null;
      agentMeta: { modelId?: string; outputTokens?: number; steps?: number } | null;
    }
  >();
  for (const message of messages) {
    if (message.role === 'toolResult' && message.toolCallId) {
      results.set(message.toolCallId, {
        output: partText(message),
        isError: message.isError === true,
        todos: message.todos ?? null,
        durationMs: message.toolDurationMs ?? null,
        agentMeta: message.subagentMeta ?? null,
      });
    }
  }

  const items: TimelineItem[] = [];
  messages.forEach((message, messageIndex) => {
    const isLastMessage = messageIndex === messages.length - 1;
    if (message.role === 'user') {
      const text = partText(message);
      const images = message.content.filter((part) => part.type === 'image');
      // 后台任务完成的合成注入：不按用户气泡渲染，转为系统通知行
      const noteMatch =
        /^<background-task-update>\n?([\s\S]*?)\n?<\/background-task-update>\s*$/.exec(text.trim());
      if (noteMatch && images.length === 0) {
        const detail = noteMatch[1].trim();
        items.push({
          kind: 'task-note',
          key: `${messageIndex}`,
          summary: detail.split('\n', 1)[0] ?? detail,
          detail,
        });
        return;
      }
      if (text || images.length > 0) {
        items.push({ kind: 'user', key: `${messageIndex}`, text, images });
      }
      return;
    }
    if (message.role === 'toolResult') return;
    if (message.role !== 'assistant') return;

    // 「流式中」= 最后一个有内容的 part：pi 流式时 thinking/text 后面常已跟着
    // 空占位 part，按「最后一个 part」判会把正在生成的块误判为已完结
    const lastActiveIndex = findLastActivePartIndex(message.content);
    message.content.forEach((part, partIndex) => {
      const key = `${messageIndex}-${partIndex}`;
      const isStreamingPart = isLastMessage && partIndex === lastActiveIndex;
      // pi 流式中的消息 stopReason 是 "pending"（非空！），只有真正的终止原因才算完结
      const settled = Boolean(message.stopReason) && message.stopReason !== 'pending';
      const streaming = running && isStreamingPart && !settled;
      switch (part.type) {
        case 'text':
          // trim：纯空白正文（工具轮的空 text part）不产出——否则显示为幽灵空行
          if (part.text.trim())
            items.push({
              kind: 'text',
              key,
              text: part.text,
              streaming,
              timestamp: message.timestamp,
              perf: perfFromTiming(message),
            });
          return;
        case 'thinking':
          if (part.text) {
            // 思考耗时：step 起点到首个非 thinking 输出（无则到 step 完成）
            const timing = message.timing;
            const end = timing?.thinkingEndMs ?? timing?.completedMs;
            items.push({
              kind: 'thinking',
              key,
              text: part.text,
              streaming,
              durationMs:
                timing && end !== undefined ? Math.max(0, end - timing.stepStartMs) : null,
              ...(timing ? { startedAt: timing.stepStartMs } : {}),
            });
          }
          return;
        case 'toolCall': {
          const result = results.get(part.id);
          items.push({
            kind: 'tool',
            key,
            name: part.name,
            summary: summarizeArgs(part.arguments),
            output: result ? result.output : null,
            state: result ? (result.isError ? 'error' : 'ok') : running ? 'running' : 'ok',
            edits: extractEdits(part.name, part.arguments),
            writeContent: extractWriteContent(part.name, part.arguments),
            todos: result?.todos ?? null,
            durationMs: result?.durationMs ?? null,
            agentMeta: result?.agentMeta ?? null,
          });
          return;
        }
        default:
          return;
      }
    });
    if (message.errorMessage) {
      items.push({ kind: 'error', key: `${messageIndex}-err`, text: message.errorMessage });
    }
  });
  return items;
}

const customEntryTime = (entry: AgentSessionCustomEntry): number =>
  entry.kind === 'capability-receipt' ? entry.receipt.occurredAt : entry.at;

const messageItemTime = (item: TimelineItem, messages: readonly ProjectedMessage[]): number => {
  const separator = item.key.indexOf('-');
  const index = Number.parseInt(separator === -1 ? item.key : item.key.slice(0, separator), 10);
  return Number.isInteger(index)
    ? (messages[index]?.timestamp ?? Number.NEGATIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;
};

/** Messages 与 custom entries 仅在展示层按时间合并；custom entries 从不进入 messages。 */
export function buildTimeline(
  messages: ProjectedMessage[],
  running: boolean,
  customEntries: readonly AgentSessionCustomEntry[] = []
): TimelineItem[] {
  const messageItems = buildMessageTimeline(messages, running);
  if (customEntries.length === 0) return messageItems;
  return [
    ...messageItems.map((item, order) => ({
      item,
      at: messageItemTime(item, messages),
      order,
    })),
    ...customEntries.map((entry, index) => ({
      item: {
        kind: 'session-custom' as const,
        key:
          entry.kind === 'capability-receipt'
            ? `custom:receipt:${entry.receipt.receiptId}`
            : `custom:${entry.kind}:${entry.child.generation}:${entry.at}:${index}`,
        entry,
      },
      at: customEntryTime(entry),
      order: messageItems.length + index,
    })),
  ]
    .sort((left, right) => left.at - right.at || left.order - right.order)
    .map(({ item }) => item);
}

/** 折叠门槛：段内非 edit 工具数达到该值才收拢 */
const FOLD_MIN_TOOLS = 3;

const SEARCH_TOOLS = new Set(['grep', 'find', 'glob', 'ls']);

function classifyTool(name: string, stats: ToolGroupStats): void {
  if (name === 'bash') stats.commands += 1;
  else if (name === 'read') stats.reads += 1;
  else if (SEARCH_TOOLS.has(name)) stats.searches += 1;
  else stats.others += 1;
}

/**
 * 工具行分组折叠（折中方案）：
 * - 段 = 连续的 tool/thinking 行（text/user/error 打断）；thinking 收进段内，门槛只数 tool。
 * - 带 diff 的 edit 行不进组，紧跟组头之后平铺（改动是核心产物，不折）。
 * - running 时最后一个 user 之后的段不折（进行中的轮实时展示）。
 * - expandedKeys 含组 key 时组头后平铺 children（参与虚拟化）。
 * 纯函数。
 */
export function foldTimeline(
  items: TimelineItem[],
  running: boolean,
  expandedKeys: ReadonlySet<string>
): TimelineItem[] {
  const lastUserIndex = items.findLastIndex((item) => item.kind === 'user');
  const result: TimelineItem[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (item.kind !== 'tool' && item.kind !== 'thinking') {
      result.push(item);
      i += 1;
      continue;
    }
    // 收集连续段
    let end = i;
    while (end < items.length && (items[end].kind === 'tool' || items[end].kind === 'thinking')) {
      end += 1;
    }
    const segment = items.slice(i, end);
    const liveSegment = running && lastUserIndex >= 0 && i > lastUserIndex;
    // 钉住的行不进组：edit 的 diff、write 的内容与 todo 清单都是核心产物，不折进黑盒
    const pinned = (s: TimelineItem): boolean =>
      s.kind === 'tool' && (s.edits !== null || !!s.writeContent || s.name === 'todo');
    const editRows = segment.filter(pinned);
    const groupRows = segment.filter((s) => !pinned(s));
    const toolCount = groupRows.filter((s) => s.kind === 'tool').length;
    if (liveSegment || toolCount < FOLD_MIN_TOOLS) {
      result.push(...segment);
    } else {
      const stats: ToolGroupStats = { commands: 0, reads: 0, searches: 0, others: 0 };
      for (const row of groupRows) {
        if (row.kind === 'tool') classifyTool(row.name, stats);
      }
      const key = `group-${segment[0].key}`;
      const expanded = expandedKeys.has(key);
      result.push({
        kind: 'tool-group',
        key,
        expanded,
        count: toolCount,
        stats,
        children: groupRows,
      });
      // 展开：原始顺序全量平铺；收拢：仅 edit 行（diff）跟在组头后
      if (expanded) result.push(...segment);
      else result.push(...editRows);
    }
    i = end;
  }
  return result;
}
