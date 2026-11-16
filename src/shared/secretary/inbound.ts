import type { ContactLang } from './contact';
import { wrapUntrusted } from './transcript';

/**
 * 所有入站渠道只从这里包一次：手机发来的话进秘书会话前统一成
 *   [来自 <渠道名> @名字 · 14:32]
 *   <untrusted-content source="<渠道 id>:@名字">正文</untrusted-content>
 * 界面按同一格式解析成卡片，所以格式改动只动这一个文件。
 */
export interface InboundChannel {
  /** 渠道 id：telegram 或插件渠道 `<pluginId>:<id>` */
  id: string;
  /** 渠道名，原样放进头一行 */
  title: string;
}

export const TELEGRAM_INBOUND: InboundChannel = { id: 'telegram', title: 'Telegram' };

export interface InboundInput {
  username?: string;
  /** 手机上发消息的时间 */
  at?: number;
  text: string;
}

export interface InboundMessage {
  /** 渠道 id */
  channel: string;
  /** 渠道名 */
  title: string;
  username?: string;
  /** 手机上发消息的时间，HH:MM */
  time?: string;
  body: string;
}

const MAX_TITLE = 40;
const MAX_NAME = 32;

/** 头一行与属性里不能出现会打断格式的字符 */
function clean(value: string, max: number): string {
  return value
    .replace(/[[\]"<>@·\r\n\t]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

function sourceId(id: string): string {
  const safe = id.toLowerCase().replace(/[^a-z0-9._:-]/gu, '');
  return safe || 'contact';
}

function clock(at: number | undefined): string {
  if (!at) return '';
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function nameOf(input: InboundInput): string {
  return input.username ? clean(input.username.replace(/^@/u, ''), MAX_NAME) : '';
}

function head(channel: InboundChannel, lang: ContactLang, input: InboundInput): string {
  const title = clean(channel.title, MAX_TITLE) || sourceId(channel.id);
  const name = nameOf(input);
  const time = clock(input.at);
  return `[${lang === 'zh' ? '来自' : 'From'} ${title}${name ? ` @${name}` : ''}${time ? ` · ${time}` : ''}]`;
}

function source(channel: InboundChannel, input: InboundInput): string {
  const name = nameOf(input);
  return name ? `${sourceId(channel.id)}:@${name}` : sourceId(channel.id);
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
  return `${head(channel, lang, input)}\n${wrapUntrusted(source(channel, input), body)}`;
}

const INBOUND =
  /^\[(?:来自|From) ([^\]\n@·]{1,40}?)(?: @([^\]\n@·]{1,32}?))?(?: · (\d{2}):(\d{2}))?\]\n<untrusted-content source="([a-z0-9._:-]+?)(?::@[^"\n]{1,32})?">([\s\S]*)<\/untrusted-content>$/u;

/** 界面用：把入站消息拆回渠道、发送者、时间与正文 */
export function parseInboundMessage(text: string): InboundMessage | null {
  const match = INBOUND.exec(text);
  if (!match) return null;
  const [, title = '', username, hours, minutes, channel = '', body = ''] = match;
  return {
    channel,
    title,
    ...(username ? { username } : {}),
    ...(hours && minutes ? { time: `${hours}:${minutes}` } : {}),
    // 包裹时把闭合标签转义过，展示时还原成用户真正打的字
    body: body.split('<\\/untrusted-content').join('</untrusted-content'),
  };
}
