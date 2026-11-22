import type { ProjectedMessage } from '../types/agent';

/** 单条正文上限：秘书只需要判断"最后说了什么"，细节让用户自己打开会话看 */
export const READABLE_MESSAGE_MAX_CHARS = 2000;

/** session_read 的 index 模式单页上限：截断的消息按这个粒度分页读全文 */
export const MESSAGE_CHUNK_MAX = 30_000;

export interface ReadableMessage {
  /** 会话内绝对消息下标，翻页时原样作为 before 传回 */
  index: number;
  /** 稳定标识（jsonl entry id）：回退后下标可能指向别的消息，读全文按它取 */
  entryId?: string;
  role: 'user' | 'assistant';
  text: string;
  truncated?: boolean;
}

const END_TAG = '</untrusted-content';

/**
 * 不可信内容包裹。正文里出现的结束标签先转义，否则内容可以提前闭合包裹，
 * 让后半段文本落回"可信"位置。
 */
export function wrapUntrusted(source: string, text: string): string {
  const escaped = text.split(END_TAG).join('<\\/untrusted-content');
  return `<untrusted-content source="${source}">${escaped}</untrusted-content>`;
}

/** 一条消息的可见正文：只取 text 段，工具调用参数、工具输出、思考一律丢弃 */
export function readableText(message: ProjectedMessage): string {
  return message.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim();
}

export interface MessageChunk {
  text: string;
  offset: number;
  totalChars: number;
  /** 还有下一段时的起始偏移 */
  nextOffset?: number;
}

/** 全文分段：offset 越界时返回空段，调用方据此判断已读完 */
export function chunkMessageText(text: string, offset = 0): MessageChunk {
  const totalChars = text.length;
  const start = Number.isFinite(offset) ? Math.min(Math.max(0, Math.floor(offset)), totalChars) : 0;
  const end = Math.min(start + MESSAGE_CHUNK_MAX, totalChars);
  return {
    text: text.slice(start, end),
    offset: start,
    totalChars,
    ...(end < totalChars ? { nextOffset: end } : {}),
  };
}

/**
 * 只保留 user 与 assistant 的文本段：工具调用参数、工具输出、思考一律丢弃，
 * 工具输出里的网页与命令结果是注入链路的主要来源。
 */
export function projectReadableMessages(
  messages: readonly ProjectedMessage[],
  options: { limit: number; baseIndex?: number; maxChars?: number }
): { messages: ReadableMessage[]; hasMore: boolean } {
  const baseIndex = options.baseIndex ?? 0;
  const maxChars = options.maxChars ?? READABLE_MESSAGE_MAX_CHARS;
  const readable: ReadableMessage[] = [];
  messages.forEach((message, offset) => {
    if (message.role !== 'user' && message.role !== 'assistant') return;
    const text = readableText(message);
    if (!text) return;
    const truncated = text.length > maxChars;
    const entryId = message.messageId ?? message.entryId;
    readable.push({
      index: baseIndex + offset,
      ...(entryId ? { entryId } : {}),
      role: message.role,
      text: truncated ? `${text.slice(0, maxChars)}…` : text,
      ...(truncated ? { truncated: true } : {}),
    });
  });
  const kept = readable.slice(-Math.max(0, options.limit));
  const firstIndex = kept[0]?.index ?? baseIndex;
  return { messages: kept, hasMore: firstIndex > 0 };
}
