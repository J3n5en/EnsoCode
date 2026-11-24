import type { PluginInjectOrigin, PluginInjectSender } from '../extensionPlugins/protocol';
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
const OPEN_TAG = '<untrusted-content';

/**
 * 不可信内容包裹。正文里的结束标签先转义，否则内容可以提前闭合包裹，让后半段落回"可信"位置；
 * 开始标签也转义，否则内容能伪造出另一层来源。转义幂等，包过的正文再包不会越转越多。
 */
export function wrapUntrusted(source: string, text: string): string {
  const escaped = text
    .split(END_TAG)
    .join('<\\/untrusted-content')
    .split(OPEN_TAG)
    .join('<\\untrusted-content');
  return `<untrusted-content source="${source}">${escaped}</untrusted-content>`;
}

/** wrapUntrusted 转义的逆操作：界面上还原成原本打的字 */
export function unescapeUntrusted(text: string): string {
  return text
    .split('<\\/untrusted-content')
    .join(END_TAG)
    .split('<\\untrusted-content')
    .join(OPEN_TAG);
}

/** 插件投递送给模型前的包裹。旧版插件自己包好的同来源完整一层原样保留，不叠第二层 */
function attrValue(value: string): string {
  return value.replace(/["<>\r\n]/g, '');
}

function senderOpenTag(
  source: string,
  sender: PluginInjectSender,
  role: PluginInjectOrigin
): string {
  const attrs = [
    `source="${source}"`,
    `channel="${attrValue(sender.channel)}"`,
    sender.userId ? `sender-id="${attrValue(sender.userId)}"` : '',
    sender.chatId ? `chat-id="${attrValue(sender.chatId)}"` : '',
    sender.displayName ? `sender="${attrValue(sender.displayName)}"` : '',
    `role="${role}"`,
  ].filter(Boolean);
  return `<untrusted-content ${attrs.join(' ')}>`;
}

export function wrapPluginDelivery(
  pluginId: string,
  text: string,
  meta?: { sender?: PluginInjectSender; role?: PluginInjectOrigin }
): string {
  const source = `plugin:${pluginId}`;
  const head = `<untrusted-content source="${source}">`;
  const tail = '</untrusted-content>';
  const role = meta?.role;
  const open = meta?.sender
    ? senderOpenTag(source, meta.sender, role ?? 'external')
    : role
      ? `<untrusted-content source="${source}" role="${role}">`
      : head;
  // 只认旧插件的裸包裹头，或与宿主这次判定完全相同的头；自带别的 role/sender 一律当正文转义
  const own = [head, open].find((tag) => text.startsWith(tag) && text.endsWith(tail));
  const inner = own ? text.slice(own.length, text.length - tail.length) : null;
  const body = inner !== null && !inner.includes(END_TAG) ? inner : text;
  if (open === head) return wrapUntrusted(source, body);
  const escaped = body
    .split(END_TAG)
    .join('<\\/untrusted-content')
    .split(OPEN_TAG)
    .join('<\\untrusted-content');
  return `${open}${escaped}</untrusted-content>`;
}

const HOST_WRAP = /^<untrusted-content(?:\s[^<>\n]*)?>([\s\S]*)<\/untrusted-content>$/u;
const PLUGIN_OPEN = /<\\?untrusted-content source="plugin:[^"<>\n]*"[^<>\n]*>/u;
const TRAILING_CLOSE = /<\\?\/untrusted-content>\s*$/u;

/**
 * 显示用：剥掉包裹，来源由卡片标题表达。只给界面用，送给模型的仍是原文。
 * 宿主包裹里的标签都转义过，唯一的字面结束标签就是它自己的；旧版插件自己包的一层
 * 是第一个插件来源的开始标签加正文末尾的结束标签。其余标签是第三方打的字，还原转义后照显示。
 */
export function unwrapUntrustedForDisplay(text: string): string {
  const host = HOST_WRAP.exec(text.trim());
  const hosted = Boolean(host && !host[1].includes(END_TAG));
  let out = hosted && host ? host[1] : text;
  const open = PLUGIN_OPEN.exec(out);
  const close = TRAILING_CLOSE.exec(out);
  if (open && close && close.index >= open.index + open[0].length)
    out = out.slice(0, open.index) + out.slice(open.index + open[0].length, close.index);
  if (hosted) out = unescapeUntrusted(out);
  return out === text ? text : out.trim();
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
