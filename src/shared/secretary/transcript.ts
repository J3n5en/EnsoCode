import type { ProjectedMessage } from '../types/agent';

/** 单条正文上限：秘书只需要判断"最后说了什么"，细节让用户自己打开会话看 */
export const READABLE_MESSAGE_MAX_CHARS = 2000;

export interface ReadableMessage {
  /** 会话内绝对消息下标，翻页时原样作为 before 传回 */
  index: number;
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
    const text = message.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n')
      .trim();
    if (!text) return;
    const truncated = text.length > maxChars;
    readable.push({
      index: baseIndex + offset,
      role: message.role,
      text: truncated ? `${text.slice(0, maxChars)}…` : text,
      ...(truncated ? { truncated: true } : {}),
    });
  });
  const kept = readable.slice(-Math.max(0, options.limit));
  const firstIndex = kept[0]?.index ?? baseIndex;
  return { messages: kept, hasMore: firstIndex > 0 };
}
