import type { ProjectedMessage, TodoItem, TurnPerf } from '@shared/types/agent';

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
  | { kind: 'thinking'; key: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      key: string;
      name: string;
      summary: string;
      output: string | null;
      state: 'running' | 'ok' | 'error';
      /** edit 工具的替换块，用于渲染 diff；非 edit 为 null */
      edits: EditBlock[] | null;
      /** todo 工具的清单快照；非 todo 为 null */
      todos: TodoItem[] | null;
      /** 工具执行耗时（完成后显示）；未知为 null */
      durationMs: number | null;
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
  | { kind: 'error'; key: string; text: string };

export interface ToolGroupStats {
  commands: number;
  reads: number;
  searches: number;
  others: number;
}

/** 从工具参数里挑一个最能说明「对什么操作」的字段做摘要 */
const SUMMARY_KEYS = ['path', 'file_path', 'command', 'pattern', 'query', 'url', 'description'];

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

/** edit 工具参数里取出替换块（保持同一数组引用，供 memo 做引用比较） */
function extractEdits(name: string, args: unknown): EditBlock[] | null {
  if (name !== 'edit' || !args || typeof args !== 'object') return null;
  const edits = (args as Record<string, unknown>).edits;
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
export function buildTimeline(messages: ProjectedMessage[], running: boolean): TimelineItem[] {
  const results = new Map<
    string,
    { output: string; isError: boolean; todos: TodoItem[] | null; durationMs: number | null }
  >();
  for (const message of messages) {
    if (message.role === 'toolResult' && message.toolCallId) {
      results.set(message.toolCallId, {
        output: partText(message),
        isError: message.isError === true,
        todos: message.todos ?? null,
        durationMs: message.toolDurationMs ?? null,
      });
    }
  }

  const items: TimelineItem[] = [];
  messages.forEach((message, messageIndex) => {
    const isLastMessage = messageIndex === messages.length - 1;
    if (message.role === 'user') {
      const text = partText(message);
      const images = message.content.filter((part) => part.type === 'image');
      if (text || images.length > 0) {
        items.push({ kind: 'user', key: `${messageIndex}`, text, images });
      }
      return;
    }
    if (message.role === 'toolResult') return;
    if (message.role !== 'assistant') return;

    message.content.forEach((part, partIndex) => {
      const key = `${messageIndex}-${partIndex}`;
      const isLastPart = isLastMessage && partIndex === message.content.length - 1;
      const streaming = running && isLastPart && !message.stopReason;
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
          if (part.text) items.push({ kind: 'thinking', key, text: part.text, streaming });
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
            todos: result?.todos ?? null,
            durationMs: result?.durationMs ?? null,
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
    // 钉住的行不进组：edit 的 diff 与 todo 清单都是核心产物，不折进黑盒
    const pinned = (s: TimelineItem): boolean =>
      s.kind === 'tool' && (s.edits !== null || s.name === 'todo');
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
