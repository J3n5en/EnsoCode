import type { ContactLang } from './contact';
import {
  appendInboundImageLines,
  INBOUND_IMAGE_LINE,
  type InboundImageEntry,
  type InboundImageLine,
  parseInboundImageEntries,
  parseInboundImagePaths,
} from './inboundImages';
import { wrapUntrusted } from './transcript';

/**
 * 所有入站渠道只从这里包一次：手机发来的话进秘书会话前统一成
 *   [来自 <渠道名> 群「群名」 chatId=… topicId=… senderId=… @名字 · 14:32]
 *   <untrusted-content source="<渠道 id> chatId=… topicId=… senderId=…">正文</untrusted-content>
 * 没有 senderId 时写「发送者未知」与 sender=unknown，不拿名字凑。
 * 界面按同一格式解析成卡片，所以格式改动只动这一个文件。
 */
export interface InboundChannel {
  /** 渠道 id：telegram 或插件渠道 `<pluginId>:<id>` */
  id: string;
  /** 渠道名，原样放进头一行 */
  title: string;
}

export const TELEGRAM_INBOUND: InboundChannel = { id: 'telegram', title: 'Telegram' };

export type InboundChatType = 'private' | 'group';

export interface InboundInput {
  /** 私聊或群的稳定 id，也是回复目标 */
  chatId?: string;
  /** 渠道没给类型就不填 */
  chatType?: InboundChatType;
  chatTitle?: string;
  /** 论坛话题 */
  topicId?: string;
  /** 发送者的稳定 id */
  senderId?: string;
  senderName?: string;
  /** 手机上发消息的时间 */
  at?: number;
  text: string;
  /** 已落盘的图片路径与收不下的图片：写在不可信内容之外，是宿主自己生成的 */
  images?: readonly InboundImageLine[];
}

export interface InboundMessage {
  /** 渠道 id */
  channel: string;
  /** 渠道名 */
  title: string;
  chatId?: string;
  chatType?: InboundChatType;
  chatTitle?: string;
  topicId?: string;
  senderId?: string;
  /** 头一行明写了「发送者未知」 */
  senderUnknown?: true;
  username?: string;
  /** 手机上发消息的时间，HH:MM */
  time?: string;
  body: string;
  /** 随消息落盘的图片路径 */
  images?: string[];
  /** 路径行按固定格式解析的结果，界面据此显示图片标签与未收下提示 */
  imageLines?: InboundImageEntry[];
}

const MAX_TITLE = 40;
const MAX_CHAT_TITLE = 64;
const MAX_NAME = 32;
const MAX_ID = 256;

/** 头一行与属性里不能出现会打断格式的字符 */
function clean(value: string, max: number): string {
  return value
    .replace(/[[\]"<>@·「」\r\n\t]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

function sourceId(id: string): string {
  const safe = id.toLowerCase().replace(/[^a-z0-9._:-]/gu, '');
  return safe || 'contact';
}

const encoder = new TextEncoder();

/** id 原样保留；会打断头一行或属性的字符按 UTF-8 百分号转义，解析时还原 */
function idText(value: string | undefined): string {
  const raw = value?.trim().slice(0, MAX_ID) ?? '';
  return raw.replace(/[^A-Za-z0-9._@:+/=-]/gu, (char) =>
    [...encoder.encode(char)]
      .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
      .join('')
  );
}

function idValue(text: string | undefined): string | undefined {
  if (!text) return undefined;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function clock(at: number | undefined): string {
  if (!at) return '';
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function nameOf(input: InboundInput): string {
  return input.senderName ? clean(input.senderName.replace(/^@/u, ''), MAX_NAME) : '';
}

/** chatId / topicId / senderId：头一行与 source 共用，缺 senderId 时放 unknown */
function idParts(input: InboundInput, unknown: string): string[] {
  const chatId = idText(input.chatId);
  const topicId = idText(input.topicId);
  const senderId = idText(input.senderId);
  return [
    ...(chatId ? [`chatId=${chatId}`] : []),
    ...(topicId ? [`topicId=${topicId}`] : []),
    senderId ? `senderId=${senderId}` : unknown,
  ];
}

function chatLabel(lang: ContactLang, input: InboundInput): string {
  if (input.chatType === 'private') return lang === 'zh' ? '私聊' : 'private';
  if (input.chatType !== 'group') return '';
  const title = input.chatTitle ? clean(input.chatTitle, MAX_CHAT_TITLE) : '';
  return `${lang === 'zh' ? '群' : 'group'}${title ? `「${title}」` : ''}`;
}

function head(channel: InboundChannel, lang: ContactLang, input: InboundInput): string {
  const name = nameOf(input);
  const time = clock(input.at);
  const parts = [
    lang === 'zh' ? '来自' : 'From',
    clean(channel.title, MAX_TITLE) || sourceId(channel.id),
    chatLabel(lang, input),
    ...idParts(input, lang === 'zh' ? '发送者未知' : 'sender unknown'),
    name ? `@${name}` : '',
  ].filter(Boolean);
  return `[${parts.join(' ')}${time ? ` · ${time}` : ''}]`;
}

function source(channel: InboundChannel, input: InboundInput): string {
  return [sourceId(channel.id), ...idParts(input, 'sender=unknown')].join(' ');
}

const HEAD_PREFIX = /^\[(?:来自|From) [^\]\n]+\]\n<untrusted-content source="[^"\n]*">/u;

/**
 * 用户把上一条渲染结果整段粘回来（还可能在后面补几句）时，先剥掉旧包裹，
 * 免得秘书会话里出现两层头、两层标签。
 */
function unwrapOnce(text: string): string {
  const parsed = parseInboundMessage(text);
  if (parsed) return parsed.body;
  const match = HEAD_PREFIX.exec(text);
  if (!match) return text;
  let body = text.slice(match[0].length);
  // 包裹自己的闭合标签（正文里用户打的那些已被转义，不会误伤）
  const close = body.indexOf('</untrusted-content>');
  if (close !== -1) {
    body = `${body.slice(0, close)}${body.slice(close + '</untrusted-content>'.length)}`;
  }
  return body.split('<\\/untrusted-content').join('</untrusted-content');
}

export function wrapInboundMessage(
  channel: InboundChannel,
  lang: ContactLang,
  input: InboundInput
): string {
  const body = unwrapOnce(input.text);
  const wrapped = `${head(channel, lang, input)}\n${wrapUntrusted(source(channel, input), body)}`;
  return input.images?.length
    ? `${wrapped}\n${appendInboundImageLines('', input.images)}`
    : wrapped;
}

const ID = '([A-Za-z0-9._@:+/=%-]+)';

/** 旧格式（只有 @名字）与新格式（带 id）都认 */
const INBOUND = new RegExp(
  String.raw`^\[(?:来自|From) ([^\]\n@·「」]{1,40}?)` +
    String.raw`(?: (私聊|private|群|group)(?:「([^」\]\n]{1,64})」)?)?` +
    `(?: chatId=${ID})?(?: topicId=${ID})?(?: senderId=${ID}| (发送者未知|sender unknown))?` +
    String.raw`(?: @([^\]\n@·]{1,32}?))?(?: · (\d{2}):(\d{2}))?\]\n` +
    String.raw`<untrusted-content source="([a-z0-9._:-]+?)(?::@[^"\n]{1,32})?(?: [^"\n]*)?">` +
    String.raw`([\s\S]*)<\/untrusted-content>((?:\n${INBOUND_IMAGE_LINE})*)$`,
  'u'
);

/** 界面用：把入站消息拆回渠道、会话、发送者、时间与正文 */
export function parseInboundMessage(text: string): InboundMessage | null {
  const match = INBOUND.exec(text);
  if (!match) return null;
  const [
    ,
    title = '',
    kind,
    chatTitle,
    chatId,
    topicId,
    senderId,
    unknown,
    username,
    hours,
    minutes,
    channel = '',
    body = '',
    imageLines = '',
  ] = match;
  const chatType: InboundChatType | undefined =
    kind === '私聊' || kind === 'private' ? 'private' : kind ? 'group' : undefined;
  const ids = { chat: idValue(chatId), topic: idValue(topicId), sender: idValue(senderId) };
  const images = parseInboundImagePaths(imageLines);
  const entries = imageLines ? parseInboundImageEntries(imageLines.slice(1)) : null;
  return {
    channel,
    title,
    ...(ids.chat ? { chatId: ids.chat } : {}),
    ...(chatType ? { chatType } : {}),
    ...(chatType === 'group' && chatTitle ? { chatTitle } : {}),
    ...(ids.topic ? { topicId: ids.topic } : {}),
    ...(ids.sender ? { senderId: ids.sender } : {}),
    ...(unknown ? { senderUnknown: true as const } : {}),
    ...(username ? { username } : {}),
    ...(hours && minutes ? { time: `${hours}:${minutes}` } : {}),
    // 包裹时把闭合标签转义过，展示时还原成用户真正打的字
    body: body.split('<\\/untrusted-content').join('</untrusted-content'),
    ...(images.length ? { images } : {}),
    ...(entries?.length ? { imageLines: entries } : {}),
  };
}
