import type { ContactLang } from './contact';
import { wrapUntrusted } from './transcript';

/**
 * 所有入站渠道只从这里包一次：手机发来的话进秘书会话前统一成
 *   [来自 Telegram @x · 14:32]
 *   <untrusted-content source="telegram:@x">正文</untrusted-content>
 * 界面按同一格式解析成卡片，所以格式改动只动这一个文件。
 */
export type InboundChannel = 'telegram';

export interface InboundInput {
  username?: string;
  /** 手机上发消息的时间 */
  at?: number;
  text: string;
}

export interface InboundMessage {
  channel: InboundChannel;
  username?: string;
  /** 手机上发消息的时间，HH:MM */
  time?: string;
  body: string;
}

const CHANNEL_LABEL: Record<InboundChannel, { zh: string; en: string; source: string }> = {
  telegram: { zh: '来自 Telegram', en: 'From Telegram', source: 'telegram' },
};

function clock(at: number | undefined): string {
  if (!at) return '';
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function head(channel: InboundChannel, lang: ContactLang, input: InboundInput): string {
  const label = CHANNEL_LABEL[channel];
  const who = input.username ? ` @${input.username.replace(/^@/u, '')}` : '';
  const time = clock(input.at);
  return `[${lang === 'zh' ? label.zh : label.en}${who}${time ? ` · ${time}` : ''}]`;
}

function source(channel: InboundChannel, username: string | undefined): string {
  const base = CHANNEL_LABEL[channel].source;
  return username ? `${base}:@${username.replace(/^@/u, '')}` : base;
}

const HEAD_PREFIX =
  /^\[(?:来自|From) Telegram[^\]\n]*\]\n<untrusted-content source="telegram[^"]*">/u;

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
  return `${head(channel, lang, input)}\n${wrapUntrusted(source(channel, input.username), body)}`;
}

const INBOUND =
  /^\[(?:来自|From) Telegram(?: @([A-Za-z0-9_]{1,64}))?(?: · (\d{2}):(\d{2}))?\]\n<untrusted-content source="telegram(?::@[A-Za-z0-9_]{1,64})?">([\s\S]*)<\/untrusted-content>$/u;

/** 界面用：把入站消息拆回发送者、时间与正文 */
export function parseInboundMessage(text: string): InboundMessage | null {
  const match = INBOUND.exec(text);
  if (!match) return null;
  const [, username, hours, minutes, body = ''] = match;
  return {
    channel: 'telegram',
    ...(username ? { username } : {}),
    ...(hours && minutes ? { time: `${hours}:${minutes}` } : {}),
    // 包裹时把闭合标签转义过，展示时还原成用户真正打的字
    body: body.split('<\\/untrusted-content').join('</untrusted-content'),
  };
}
