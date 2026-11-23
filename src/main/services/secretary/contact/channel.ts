import type { InboundImageRejection } from '@shared/secretary/inboundImages';
import type { SecretaryContactCaps, SecretaryContactChannelStatus } from '@shared/types/secretary';

/** 渠道能力：核心按它决定画按钮、改旧消息还是降级成编号文本 */
export type ChannelCaps = SecretaryContactCaps;

export type ChannelInboundImage = { data: Buffer } | { rejected: InboundImageRejection };

/** 一个联系人：渠道 id 加渠道内的会话 id（私聊或群，一律字符串）；群里的论坛话题另算一个 */
export interface Peer {
  channelId: string;
  peerId: string;
  /** 论坛话题：回复要回到同一个话题 */
  topicId?: string;
}

export function peerKey(peer: Peer): string {
  return `${peer.channelId}\u0000${peer.peerId}\u0000${peer.topicId ?? ''}`;
}

export function samePeer(left: Peer, right: Peer): boolean {
  return (
    left.channelId === right.channelId &&
    left.peerId === right.peerId &&
    (left.topicId ?? '') === (right.topicId ?? '')
  );
}

/** 回调按钮带 data，链接按钮带 url；渠道不支持就由核心降级成文本 */
export type ChannelButton = { text: string; data: string } | { text: string; url: string };

export interface ChannelMessage {
  text: string;
  /** 缺省 markdown；html 只给自带 HTML 的只读命令回复 */
  format?: 'markdown' | 'html';
  buttons?: ChannelButton[][];
  /** 回复原消息；多条分片只挂在第一条 */
  replyToMessageId?: string;
}

/** channel-paused：宿主因连续失败暂停了这个渠道的推送，没有真的发 */
export type ChannelErrorCode =
  | 'token-required'
  | 'network'
  | 'unauthorized'
  | 'api'
  | 'channel-paused';

/** 发送失败：detail 是渠道给的原因（已脱敏截断），插件渠道还可能带插件 code 与给用户看的提示 */
export interface ChannelFailure {
  ok: false;
  error: ChannelErrorCode;
  detail?: string;
  pluginCode?: string;
  userMessage?: string;
}

export type ChannelSend = { ok: true; messageId?: string } | ChannelFailure;

export type ChannelResult = { ok: true } | { ok: false; error: ChannelErrorCode };

/** 收尾结果：正文改不动时退到只清按钮（markupOnly），连按钮都清不掉就是 ok:false */
export type ChannelSettle =
  | { ok: true; markupOnly?: false }
  | { ok: true; markupOnly: true; error: ChannelErrorCode }
  | { ok: false; error: ChannelErrorCode };

/**
 * 出站媒体。核心已校验过路径并读出字节：buffer 是权威内容，path 只用来取文件名，
 * 渠道不应再按 path 重新读盘。
 */
export interface ChannelImage {
  path?: string;
  buffer?: Buffer;
  fileName?: string;
  mimeType?: string;
  caption?: string;
}

export interface ChannelFile {
  path: string;
  buffer?: Buffer;
  fileName?: string;
  mimeType?: string;
  caption?: string;
}

/**
 * 语义接口：核心只说「发一条提问」「这张卡收尾了」，怎么画由渠道决定。
 * 能力缺失时核心不会调用对应方法（edit=false 不调 settle/edit，typing=false 不调 typing，
 * images/files=false 不调 sendImage/sendFile）。
 * topicId 只有论坛话题才带；不认识话题的渠道忽略它。
 */
export interface ContactChannel {
  readonly id: string;
  caps(): ChannelCaps;
  sendText(peerId: string, message: ChannelMessage, topicId?: string): Promise<ChannelSend>;
  ask(peerId: string, message: ChannelMessage, topicId?: string): Promise<ChannelSend>;
  confirmCards(peerId: string, message: ChannelMessage, topicId?: string): Promise<ChannelSend>;
  approvalNotice(peerId: string, message: ChannelMessage, topicId?: string): Promise<ChannelSend>;
  /** 收尾：整条换成 text 并清掉按钮；只在 caps.edit 时调用 */
  settle(peerId: string, messageId: string, text: string): Promise<ChannelSettle>;
  /** 原地重画（翻页、关注列表）；只在 caps.edit 时调用 */
  edit?(peerId: string, messageId: string, message: ChannelMessage): Promise<ChannelResult>;
  /** 「正在输入…」；只在 caps.typing 时调用 */
  typing(peerId: string, topicId?: string): Promise<ChannelResult>;
  /** 发图片；只在 caps.images 时调用 */
  sendImage?(peerId: string, image: ChannelImage, topicId?: string): Promise<ChannelSend>;
  /** 发文件；只在 caps.files 时调用 */
  sendFile?(peerId: string, file: ChannelFile, topicId?: string): Promise<ChannelSend>;
  /** 命令菜单；null 表示清掉 */
  setCommands?(
    peerId: string,
    commands: readonly { command: string; description: string }[] | null
  ): Promise<void>;
}

/**
 * 渠道回调：一句话，或点了按钮（提问选项、确认卡、翻页、关注）。
 * 一句话的会话 id 是 peer.peerId、话题是 peer.topicId；发送者 id 渠道有就必须带。
 */
export type ChannelInbound =
  | {
      kind: 'text';
      peer: Peer;
      text: string;
      /** 渠道没给类型就不填，不猜成群 */
      chatType?: 'private' | 'group';
      chatTitle?: string;
      senderId?: string;
      /** 发送者名字 */
      name?: string;
      at?: number;
      /** 随消息来的图片：字节交给宿主落盘；渠道侧就判定收不下的带原因 */
      images?: readonly ChannelInboundImage[];
    }
  | {
      kind: 'action';
      peer: Peer;
      data: string;
      messageId?: string;
      /** 点按钮后的轻提示；渠道没有就空操作 */
      ack(text?: string): Promise<void>;
    };

export interface ChannelMeta {
  id: string;
  title: string;
  icon?: string;
  builtin: boolean;
  pluginId?: string;
  /** 插件渠道的登录页（插件内相对路径） */
  settingsView?: string;
}

export interface ChannelEntry {
  meta: ChannelMeta;
  /** 插件还没 register 时没有实现：卡片照样显示「未配置」 */
  channel: ContactChannel | null;
  status: SecretaryContactChannelStatus;
  detail?: string;
  /** 主动推送发给谁：Telegram 是绑定的 chat，插件渠道由 setStatus 上报 */
  peers: string[];
}

/** 渠道表：Telegram 内置固定第一位，插件渠道按注册顺序 */
export class ContactChannelRegistry {
  private readonly entries = new Map<string, ChannelEntry>();

  upsert(meta: ChannelMeta, patch?: Partial<Omit<ChannelEntry, 'meta'>>): ChannelEntry {
    const current = this.entries.get(meta.id);
    const next: ChannelEntry = {
      meta,
      channel: current?.channel ?? null,
      status: current?.status ?? 'unconfigured',
      peers: current?.peers ?? [],
      ...(current?.detail ? { detail: current.detail } : {}),
      ...patch,
    };
    this.entries.set(meta.id, next);
    return next;
  }

  get(id: string): ChannelEntry | undefined {
    return this.entries.get(id);
  }

  remove(id: string): ChannelEntry | undefined {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    return entry;
  }

  list(): ChannelEntry[] {
    const all = [...this.entries.values()];
    return [...all.filter((entry) => entry.meta.builtin), ...all.filter((e) => !e.meta.builtin)];
  }
}

/** 没按钮的渠道：把按钮行降成编号文本，链接按钮直接写成链接 */
export function plainButtonsText(rows: readonly ChannelButton[][] | undefined): string {
  const lines: string[] = [];
  for (const row of rows ?? []) {
    for (const button of row) if ('url' in button) lines.push(`${button.text}: ${button.url}`);
  }
  return lines.join('\n');
}

/** 按 maxChars 切条：尽量在换行处断开 */
export function splitPlain(text: string, maxChars: number): string[] {
  if (maxChars <= 0 || text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const cut = rest.lastIndexOf('\n', maxChars);
    const at = cut > maxChars / 2 ? cut : maxChars;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).replace(/^\n/u, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}
