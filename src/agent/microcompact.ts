import type { InlineExtension } from '@earendil-works/pi-coding-agent';

/**
 * 微压缩（借鉴 qwen-code microcompaction）：不调 LLM，把旧的可重取工具结果正文换成占位。
 * - 体量触发：可清结果总字符超阈值时从最旧清到低水位，低水位避免每轮重触发打碎 prompt cache；
 * - 空闲触发：上一条回复距今超过阈值时缓存已冷，清掉除最近几条外的全部可清结果，不再白付整段前缀。
 * 请求前在 context 钩子替换，回合结束写成持久 context_edit，投影、压缩与用量估算随之一致。
 */
export const MICROCOMPACT_PLACEHOLDER =
  '[Old tool result content cleared to save context. Re-run the tool if you need it again.]';
export const MICROCOMPACT_TOTAL_CHARS = 500_000;
export const MICROCOMPACT_LOW_WATERMARK = 250_000;
export const MICROCOMPACT_KEEP_RECENT = 5;
export const MICROCOMPACT_IDLE_MS = 60 * 60_000;

/** 结果可凭同一调用重新取得的工具；子代理报告、审批、用户回答等不可重取，不清 */
const COMPACTABLE_TOOLS = new Set([
  'read',
  'bash',
  'grep',
  'find',
  'ls',
  'web_fetch',
  'web_search',
  'task_output',
  'edit',
  'write',
  'apply_patch',
]);

interface Message {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
}

interface ProjectedEntry {
  sourceEntry: { id: string; type: string };
  messages: Message[];
}

const PLACEHOLDER_CONTENT = [{ type: 'text' as const, text: MICROCOMPACT_PLACEHOLDER }];

function textChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') chars += part.text.length;
  }
  return chars;
}

function isCleared(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length === 1 &&
    content[0]?.type === 'text' &&
    content[0].text === MICROCOMPACT_PLACEHOLDER
  );
}

export function selectMicrocompactTargets(
  messages: readonly Message[],
  now: number,
  selected: ReadonlySet<string>
): string[] {
  const candidates: Array<{ id: string; chars: number }> = [];
  let lastReplyAt: number | undefined;
  for (const message of messages) {
    if (message.role === 'assistant' && typeof message.timestamp === 'number')
      lastReplyAt = message.timestamp;
    if (
      message.role !== 'toolResult' ||
      !message.toolCallId ||
      message.isError === true ||
      !COMPACTABLE_TOOLS.has(message.toolName ?? '') ||
      selected.has(message.toolCallId) ||
      isCleared(message.content)
    )
      continue;
    const chars = textChars(message.content);
    if (chars > 0) candidates.push({ id: message.toolCallId, chars });
  }
  const clearable = candidates.slice(0, Math.max(0, candidates.length - MICROCOMPACT_KEEP_RECENT));
  if (clearable.length === 0) return [];
  if (lastReplyAt !== undefined && now - lastReplyAt >= MICROCOMPACT_IDLE_MS)
    return clearable.map((c) => c.id);
  let total = candidates.reduce((sum, c) => sum + c.chars, 0);
  if (total <= MICROCOMPACT_TOTAL_CHARS) return [];
  const targets: string[] = [];
  for (const candidate of clearable) {
    if (total <= MICROCOMPACT_LOW_WATERMARK) break;
    targets.push(candidate.id);
    total -= candidate.chars;
  }
  return targets;
}

/** 替换选中结果的正文；没有命中时返回原数组，保住请求前缀 */
export function applyMicrocompact<T extends Message>(
  messages: T[],
  selected: ReadonlySet<string>
): T[] {
  if (selected.size === 0) return messages;
  let changed = false;
  const out = messages.map((message) => {
    if (
      message.role !== 'toolResult' ||
      !message.toolCallId ||
      !selected.has(message.toolCallId) ||
      isCleared(message.content)
    )
      return message;
    changed = true;
    return { ...message, content: PLACEHOLDER_CONTENT };
  });
  return changed ? out : messages;
}

/** 选中且投影尚未替换的结果 → context_edit；投影里已是占位的 → settled（已落盘，可从内存集合移除） */
export function microcompactContextEdits(
  entries: readonly ProjectedEntry[],
  selected: ReadonlySet<string>
): {
  edits: Array<{
    type: 'context_edit';
    targetId: string;
    replacement: { content: typeof PLACEHOLDER_CONTENT };
  }>;
  settled: string[];
} {
  const edits = [];
  const settled: string[] = [];
  for (const entry of entries) {
    const [message] = entry.messages;
    if (
      entry.sourceEntry.type !== 'message' ||
      entry.messages.length !== 1 ||
      message.role !== 'toolResult' ||
      !message.toolCallId ||
      !selected.has(message.toolCallId)
    )
      continue;
    if (isCleared(message.content)) settled.push(message.toolCallId);
    else
      edits.push({
        type: 'context_edit' as const,
        targetId: entry.sourceEntry.id,
        replacement: { content: PLACEHOLDER_CONTENT },
      });
  }
  return { edits, settled };
}

export function microcompactExtension(now: () => number = Date.now): InlineExtension {
  return {
    name: 'microcompact',
    hidden: true,
    factory: (pi) => {
      const selected = new Set<string>();
      pi.on('context', (event) => {
        const messages = event.messages as unknown as Message[];
        for (const id of selectMicrocompactTargets(messages, now(), selected)) selected.add(id);
        return {
          messages: applyMicrocompact(messages, selected) as unknown as typeof event.messages,
        };
      });
      pi.on('turn_end', (event) => {
        if (selected.size === 0) return;
        const { edits, settled } = microcompactContextEdits(
          event.context.contextEntries as unknown as ProjectedEntry[],
          selected
        );
        for (const id of settled) selected.delete(id);
        if (edits.length === 0) return;
        return { entries: [...event.entries, ...edits] };
      });
    },
  };
}
