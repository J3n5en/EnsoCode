import { basename } from 'node:path';
import { commandListText, escapeHtml } from '@shared/secretary/commands';
import {
  bindCodeUsable,
  bindDeepLink,
  botTokenHint,
  CONTACT_BIND_CODE_TTL_MS,
  CONTACT_BIND_MAX_FAILURES,
  type ContactLang,
  createBindCode,
  formatTestMessage,
  formatWelcomeMessage,
  isBoundChat,
  normalizeBotToken,
  startCommandCode,
} from '@shared/secretary/contact';
import {
  htmlToPlain,
  markdownToTelegramChunks,
  packTelegramHtml,
} from '@shared/secretary/telegramHtml';
import type {
  SecretaryAuditEntry,
  SecretaryContactChannelStatus,
  SecretaryContactTelegram,
} from '@shared/types/secretary';
import type {
  ChannelCaps,
  ChannelErrorCode,
  ChannelFile,
  ChannelImage,
  ChannelInbound,
  ChannelMessage,
  ChannelResult,
  ChannelSend,
  ChannelSettle,
  ContactChannel,
} from './channel';
import {
  createTelegramApi,
  type TelegramApi,
  TelegramApiError,
  type TelegramInlineButton,
  type TelegramInlineKeyboard,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUpload,
} from './client';
import { ContactPoller } from './poller';
import {
  type ContactFile,
  type ContactStore,
  TELEGRAM_CHANNEL_ID,
  telegramGroupAllowed,
  withTelegramGroupTitle,
} from './store';

export const TELEGRAM_CAPS: ChannelCaps = {
  buttons: true,
  urlButtons: true,
  edit: true,
  typing: true,
  format: 'html',
  maxChars: 4096,
  commandMenu: true,
  images: true,
  files: true,
};

/** sendPhoto / sendDocument 的 caption 上限（按字符计） */
const TELEGRAM_CAPTION_MAX = 1024;

export interface TelegramChannelPorts {
  audit(entry: SecretaryAuditEntry): void;
  publish(): void;
  now(): number;
  random(): number;
  lang(): ContactLang;
  onError?(code: ChannelErrorCode, detail?: string): void;
  /** 绑定的 chat 发来的话与按钮：交给核心 */
  inbound(message: ChannelInbound): Promise<void>;
  /** 命令菜单要不要带 /memory、欢迎语里的命令清单 */
  menuCommands(): { command: string; description: string }[];
  /** 绑定完成：核心据此刷新命令菜单与推送目标 */
  onBound?(): void;
  /** 测试注入假 API；生产按 token 现建 */
  api?(token: string): TelegramApi;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function telegramErrorCode(error: unknown): ChannelErrorCode {
  if (error instanceof TelegramApiError) {
    if (error.kind === 'network') return 'network';
    if (error.kind === 'unauthorized') return 'unauthorized';
  }
  return 'api';
}

/** 轮询以外的请求结果交给轮询器判断连通性；getUpdates 由轮询器自己管 */
function tracked(api: TelegramApi, poller: ContactPoller): TelegramApi {
  return new Proxy(api, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (key === 'getUpdates' || typeof value !== 'function') return value;
      return (...args: unknown[]) => poller.track(() => value.apply(target, args));
    },
  });
}

function keyboard(rows: ChannelMessage['buttons']): TelegramInlineKeyboard | undefined {
  if (!rows || rows.length === 0) return undefined;
  return {
    inline_keyboard: rows.map((row) =>
      row.map(
        (button): TelegramInlineButton =>
          'url' in button
            ? { text: button.text, url: button.url }
            : { text: button.text, callback_data: button.data }
      )
    ),
  };
}

function chatTypeOf(type: string | undefined): 'private' | 'group' | undefined {
  if (type === 'private') return 'private';
  if (type === 'group' || type === 'supergroup') return 'group';
  return undefined;
}

/** 只认论坛话题：普通超级群的回复串也带 message_thread_id，但发不进去 */
function topicOf(message: TelegramMessage): string | undefined {
  const thread = message.message_thread_id;
  if (thread === undefined || !Number.isInteger(thread)) return undefined;
  return message.is_topic_message || message.chat.is_forum ? String(thread) : undefined;
}

function threadOf(topicId: string | undefined): { messageThreadId?: number } {
  const thread = topicId ? Number(topicId) : Number.NaN;
  return Number.isInteger(thread) ? { messageThreadId: thread } : {};
}

/**
 * 只认绑定的那个人：私聊就是绑定的 chat（私聊 chat id 等于用户 id）；
 * 群要在白名单里（空名单不收任何群），且只放行他本人发的。别人的一律静默丢掉。
 */
function admitChat(
  file: ContactFile,
  chat: { id: number; type?: string },
  fromId: number | undefined
): 'ok' | 'foreign-chat' | 'group-not-allowed' | 'foreign-sender' {
  if (isBoundChat(file.chat?.id, chat.id)) return 'ok';
  if (chatTypeOf(chat.type) !== 'group') return 'foreign-chat';
  if (!telegramGroupAllowed(file, chat.id)) return 'group-not-allowed';
  return isBoundChat(file.chat?.id, fromId ?? Number.NaN) ? 'ok' : 'foreign-sender';
}

/**
 * 内置 Telegram 渠道：绑定向导、长轮询、HTML 切条与降级、按钮、改消息、命令菜单。
 * 只认绑定的那个人（私聊，或他本人在白名单群里发的）；秘书语义（提问、确认卡、关注）全在核心里。
 */
export class TelegramChannel implements ContactChannel {
  readonly id = TELEGRAM_CHANNEL_ID;
  private readonly poller: ContactPoller;
  private readonly apis = new Map<string, TelegramApi>();
  /** chat → 最近一条入站消息所在的话题：发图片和文件时回到原话题 */
  private readonly threads = new Map<string, number>();

  constructor(
    private readonly store: ContactStore,
    private readonly ports: TelegramChannelPorts
  ) {
    this.poller = new ContactPoller({
      api: () => {
        const token = this.store.token();
        return token ? this.apiFor(token) : null;
      },
      offset: () => this.store.file().pollOffset,
      setOffset: (offset) => {
        const file = this.store.file();
        this.store.save({ ...file, pollOffset: offset });
      },
      onUpdate: (update) => this.handleUpdate(update),
      onStatus: () => this.ports.publish(),
      onError: (error) => this.reportError(error),
      sleep,
    });
  }

  caps(): ChannelCaps {
    return TELEGRAM_CAPS;
  }

  /** 绑定的 chat：主动推送就发给它 */
  peerId(): string | null {
    const chat = this.store.file().chat;
    return chat ? String(chat.id) : null;
  }

  status(): { status: SecretaryContactChannelStatus; detail?: string } {
    const file = this.store.file();
    const poll = this.poller.status();
    if (file.chat && poll.state === 'error') {
      return { status: 'error', ...(poll.lastError ? { detail: poll.lastError } : {}) };
    }
    if (file.chat) return { status: 'connected' };
    if (file.bind) return { status: 'pending' };
    return { status: 'unconfigured' };
  }

  view(): Omit<SecretaryContactTelegram, 'following'> {
    const file = this.store.file();
    const token = this.store.token();
    const bind = file.bind;
    const status = file.chat ? 'bound' : bind ? 'awaiting-start' : 'unbound';
    return {
      status,
      ...(file.bot ? { bot: file.bot } : {}),
      ...(file.chat ? { chat: file.chat } : {}),
      ...(file.boundAt !== undefined ? { boundAt: file.boundAt } : {}),
      ...(bind && file.bot && status !== 'bound'
        ? {
            bind: {
              code: bind.code,
              expiresAt: bind.expiresAt,
              link: bindDeepLink(file.bot.username, bind.code),
            },
          }
        : {}),
      ...(token ? { tokenHint: botTokenHint(token) } : {}),
      allowCardConfirm: file.allowCardConfirm,
      allowMemory: file.allowMemory,
      syncMirror: file.syncMirror,
      groups: file.telegramGroups.map((id) => {
        const title = file.telegramGroupTitles[id];
        return title ? { id, title } : { id };
      }),
      poll: this.poller.status(),
      secure: this.store.isSecure(),
    };
  }

  /** 启动或重新打开开关：上次已经绑过、token 还在才轮询 */
  async start(): Promise<void> {
    await this.store.ready();
    if (this.store.file().chat && this.store.token()) {
      this.poller.start();
      void this.setCommands(this.peerId() ?? '', this.ports.menuCommands());
    }
  }

  async stop(): Promise<void> {
    await this.poller.stop();
  }

  /** 第 2、3 步：校验 token（getMe）并生成一次性绑定码；只带码时用已存 token 重新生成 */
  async bind(
    rawToken?: unknown
  ): Promise<{ ok: true } | { ok: false; error: ChannelErrorCode | 'token-invalid' }> {
    await this.store.ready();
    const file = this.store.file();
    const provided =
      rawToken === undefined || rawToken === null || rawToken === '' ? null : rawToken;
    let token = this.store.token();
    let bot = file.bot;

    if (provided !== null) {
      const normalized = normalizeBotToken(provided);
      if (!normalized) {
        this.audit('contact_bind_start', false, 'token-invalid');
        return { ok: false, error: 'token-invalid' };
      }
      try {
        const me = await this.apiFor(normalized).getMe();
        const username = me.username?.trim();
        if (!username) {
          this.audit('contact_bind_start', false, 'no-username');
          return { ok: false, error: 'api' };
        }
        bot = { id: me.id, username, name: me.first_name?.trim() || username };
        token = normalized;
      } catch (error) {
        const code = telegramErrorCode(error);
        this.audit('contact_bind_start', false, code);
        return { ok: false, error: code };
      }
      await this.store.saveToken(token);
    }

    if (!token || !bot) return { ok: false, error: 'token-required' };

    const code = createBindCode(this.ports.random);
    this.store.save({
      ...this.store.file(),
      bot,
      bind: { code, expiresAt: this.ports.now() + CONTACT_BIND_CODE_TTL_MS, failures: 0 },
    });
    this.audit('contact_bind_start', true, `bot=${bot.id}`);
    this.poller.start();
    this.ports.publish();
    return { ok: true };
  }

  /** 退出向导：清掉中间态，已绑定的不受影响 */
  async cancelBind(): Promise<void> {
    const file = this.store.file();
    if (file.bind) {
      const rest = { ...file };
      delete rest.bind;
      this.store.save(rest);
    }
    if (!file.chat) await this.poller.stop();
    this.ports.publish();
  }

  /** 解绑：清 chat 与绑定码，停止轮询；bot 与 token 留着 */
  async unbind(): Promise<void> {
    const chatId = this.store.file().chat?.id;
    await this.poller.stop();
    this.threads.clear();
    this.store.saveUnbound();
    await this.clearCommands(chatId);
  }

  /** 更换 bot：token、bot 身份、chat 一起清 */
  async forgetBot(): Promise<void> {
    const chatId = this.store.file().chat?.id;
    await this.poller.stop();
    // token 还在时才能调 API：先清菜单，再忘掉 bot
    await this.clearCommands(chatId);
    await this.store.saveForgotten();
  }

  testText(): string {
    return formatTestMessage(this.ports.lang(), this.store.file().bot?.name ?? 'Secretary');
  }

  sendText(peerId: string, message: ChannelMessage, topicId?: string): Promise<ChannelSend> {
    return this.send(peerId, message, topicId);
  }

  ask(peerId: string, message: ChannelMessage, topicId?: string): Promise<ChannelSend> {
    return this.send(peerId, message, topicId);
  }

  confirmCards(peerId: string, message: ChannelMessage, topicId?: string): Promise<ChannelSend> {
    return this.send(peerId, message, topicId);
  }

  approvalNotice(peerId: string, message: ChannelMessage, topicId?: string): Promise<ChannelSend> {
    return this.send(peerId, message, topicId);
  }

  /** 整条换成 text、清按钮；正文改不动至少把按钮清掉，手机上不能再点第二次 */
  async settle(peerId: string, messageId: string, text: string): Promise<ChannelSettle> {
    const token = this.store.token();
    if (!token) return { ok: false, error: 'token-required' };
    const api = this.apiFor(token);
    const chatId = Number(peerId);
    const id = Number(messageId);
    const replyMarkup = { inline_keyboard: [] };
    try {
      // 整条替换：正文里可能有 markdown 字符，这里只转义不解析
      await api.editMessageText({
        chatId,
        messageId: id,
        text: escapeHtml(text),
        replyMarkup,
        parseMode: 'HTML',
      });
      return { ok: true };
    } catch (error) {
      const code = telegramErrorCode(error);
      try {
        await api.editMessageReplyMarkup({ chatId, messageId: id, replyMarkup });
        return { ok: true, markupOnly: true, error: code };
      } catch {
        return { ok: false, error: code };
      }
    }
  }

  async edit(peerId: string, messageId: string, message: ChannelMessage): Promise<ChannelResult> {
    const token = this.store.token();
    if (!token) return { ok: false, error: 'token-required' };
    try {
      await this.apiFor(token).editMessageText({
        chatId: Number(peerId),
        messageId: Number(messageId),
        text: message.text,
        replyMarkup: keyboard(message.buttons) ?? { inline_keyboard: [] },
        parseMode: 'HTML',
      });
      return { ok: true };
    } catch (error) {
      this.reportError(error);
      return { ok: false, error: telegramErrorCode(error) };
    }
  }

  async typing(peerId: string, topicId?: string): Promise<ChannelResult> {
    const token = this.store.token();
    // 解绑后立刻停：没有 chat 就不再发
    if (!token || !this.store.file().chat) return { ok: false, error: 'token-required' };
    try {
      await this.apiFor(token).sendChatAction({
        chatId: Number(peerId),
        action: 'typing',
        ...threadOf(topicId),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: telegramErrorCode(error) };
    }
  }

  sendImage(peerId: string, image: ChannelImage): Promise<ChannelSend> {
    return this.upload(peerId, 'photo', image);
  }

  sendFile(peerId: string, file: ChannelFile): Promise<ChannelSend> {
    return this.upload(peerId, 'document', file);
  }

  /**
   * 图片走 sendPhoto，文件走 sendDocument，都带回原话题的 message_thread_id。
   * caption 超过 1024 就不放在媒体上，媒体发完再另发一条文字。
   * sendPhoto 被拒（尺寸、比例不合要求）时退成 sendDocument 原样发出。
   */
  private async upload(
    peerId: string,
    kind: 'photo' | 'document',
    media: ChannelImage
  ): Promise<ChannelSend> {
    const token = this.store.token();
    if (!token || !this.store.file().chat) return { ok: false, error: 'token-required' };
    const data = media.buffer;
    if (!data) return { ok: false, error: 'api' };
    const caption = media.caption?.trim() ?? '';
    const inline = caption.length <= TELEGRAM_CAPTION_MAX;
    const threadId = this.threads.get(peerId);
    const params: TelegramUpload = {
      chatId: Number(peerId),
      ...(threadId !== undefined ? { threadId } : {}),
      data,
      fileName: media.fileName || basename(media.path ?? '') || 'file',
      ...(media.mimeType ? { mimeType: media.mimeType } : {}),
      ...(caption && inline ? { caption } : {}),
    };
    const api = this.apiFor(token);
    let messageId: number;
    try {
      messageId = kind === 'photo' ? await api.sendPhoto(params) : await api.sendDocument(params);
    } catch (error) {
      if (kind !== 'photo' || telegramErrorCode(error) !== 'api') {
        this.reportError(error);
        return { ok: false, error: telegramErrorCode(error) };
      }
      this.audit('contact_media', false, 'photo-rejected');
      try {
        messageId = await api.sendDocument(params);
      } catch (retryError) {
        this.reportError(retryError);
        return { ok: false, error: telegramErrorCode(retryError) };
      }
    }
    if (caption && !inline) {
      const rest = await this.send(peerId, { text: caption });
      if (!rest.ok) return rest;
    }
    return { ok: true, messageId: String(messageId) };
  }

  /**
   * 命令菜单：绑定的 chat 单独注册一份（打 / 立刻能看到），默认 scope 再放中文与兜底两份，
   * 并把左下角菜单按钮设成 commands。null 表示清掉。失败只记审计。
   */
  async setCommands(
    peerId: string,
    commands: readonly { command: string; description: string }[] | null
  ): Promise<void> {
    if (commands === null) {
      await this.clearCommands(peerId ? Number(peerId) : undefined);
      return;
    }
    const token = this.store.token();
    const chatId = this.store.file().chat?.id;
    if (!token || !chatId) return;
    const list = [...commands];
    const api = this.apiFor(token);
    await this.runMenuCalls([
      {
        detail: 'set:chat',
        run: () => api.setMyCommands(list, { scope: { type: 'chat', chat_id: chatId } }),
      },
      { detail: 'set:zh', run: () => api.setMyCommands(list, { languageCode: 'zh' }) },
      { detail: 'set:default', run: () => api.setMyCommands(list) },
      { detail: 'menu:commands', run: () => api.setChatMenuButton({ type: 'commands' }) },
    ]);
  }

  private async clearCommands(chatId: number | undefined): Promise<void> {
    const token = this.store.token();
    if (!token) return;
    const api = this.apiFor(token);
    await this.runMenuCalls([
      ...(chatId
        ? [
            {
              detail: 'delete:chat',
              run: () => api.deleteMyCommands({ scope: { type: 'chat', chat_id: chatId } }),
            },
          ]
        : []),
      { detail: 'delete:zh', run: () => api.deleteMyCommands({ languageCode: 'zh' }) },
      { detail: 'delete:default', run: () => api.deleteMyCommands() },
      { detail: 'menu:default', run: () => api.setChatMenuButton({ type: 'default' }) },
    ]);
  }

  /** 一条失败不影响后面的，也不往上抛 */
  private async runMenuCalls(
    calls: { detail: string; run: () => Promise<unknown> }[]
  ): Promise<void> {
    for (const call of calls) {
      try {
        await call.run();
        this.audit('contact_commands', true, call.detail);
      } catch (error) {
        this.audit('contact_commands', false, call.detail);
        this.ports.onError?.(
          telegramErrorCode(error),
          error instanceof Error ? error.message : undefined
        );
      }
    }
  }

  private apiFor(token: string): TelegramApi {
    const injected = this.ports.api?.(token);
    if (injected) return tracked(injected, this.poller);
    const cached = this.apis.get(token);
    if (cached) return cached;
    const api = tracked(createTelegramApi(token), this.poller);
    this.apis.set(token, api);
    return api;
  }

  /**
   * 出站：markdown 转 Telegram HTML、超长切条、解析失败降级纯文本。
   * 键盘只挂在最后一条上，翻页/选项不会散在几条消息里。
   */
  private async send(
    peerId: string,
    message: ChannelMessage,
    topicId?: string
  ): Promise<ChannelSend> {
    const token = this.store.token();
    if (!token) return { ok: false, error: 'token-required' };
    const chunks =
      message.format === 'html'
        ? packTelegramHtml(message.text).map((html) => ({ html, plain: htmlToPlain(html) }))
        : markdownToTelegramChunks(message.text);
    const replyMarkup = keyboard(message.buttons);
    let messageId: number | undefined;
    for (const [index, chunk] of chunks.entries()) {
      const markup = index === chunks.length - 1 ? replyMarkup : undefined;
      const sent = await this.sendChunk(Number(peerId), token, chunk, markup, topicId);
      if (!sent.ok) return sent;
      messageId = sent.messageId;
    }
    return { ok: true, ...(messageId === undefined ? {} : { messageId: String(messageId) }) };
  }

  /** 单条：HTML 发不出去（Telegram 报解析错误）就原样纯文本再发一次 */
  private async sendChunk(
    chatId: number,
    token: string,
    chunk: { html: string; plain: string },
    replyMarkup?: TelegramInlineKeyboard,
    topicId?: string
  ): Promise<{ ok: true; messageId: number } | { ok: false; error: ChannelErrorCode }> {
    const api = this.apiFor(token);
    try {
      const messageId = await api.sendMessage({
        chatId,
        text: chunk.html,
        parseMode: 'HTML',
        ...(replyMarkup ? { replyMarkup } : {}),
        ...threadOf(topicId),
      });
      return { ok: true, messageId };
    } catch (error) {
      if (!(error instanceof TelegramApiError) || error.kind !== 'api') {
        return { ok: false, error: telegramErrorCode(error) };
      }
      this.audit('contact_format', false, 'html-rejected');
      try {
        const messageId = await api.sendMessage({
          chatId,
          text: chunk.plain,
          ...(replyMarkup ? { replyMarkup } : {}),
          ...threadOf(topicId),
        });
        this.audit('contact_format', true, 'plain-fallback');
        return { ok: true, messageId };
      } catch (retryError) {
        return { ok: false, error: telegramErrorCode(retryError) };
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const file = this.store.file();
    if (update.callback_query) {
      const query = update.callback_query;
      const chat = query.message?.chat;
      // 群里的按钮：群在白名单里，且只认绑定的那个人点
      if (file.chat && chat) {
        const verdict = admitChat(file, chat, query.from?.id);
        if (verdict !== 'ok') {
          this.reject(verdict, chat.id);
          return;
        }
      }
      const peerId = String(chat?.id ?? file.chat?.id ?? query.from?.id ?? '');
      const topicId = query.message ? topicOf(query.message) : undefined;
      await this.ports.inbound({
        kind: 'action',
        peer: { channelId: this.id, peerId, ...(topicId ? { topicId } : {}) },
        data: query.data ?? '',
        ...(query.message ? { messageId: String(query.message.message_id) } : {}),
        ack: (text) => this.answerCallback(query.id, text),
      });
      return;
    }
    const message = update.message;
    const text = message?.text?.trim();
    if (!message || !text) return;

    // 绑定向导：只认私聊里的 /start <code>，对不上就忽略，绝不绑到陌生人身上
    if (file.bind) {
      const code = startCommandCode(text);
      if (!code) {
        this.audit('contact_inbound_rejected', false, 'awaiting-start');
        return;
      }
      if (message.chat.type && message.chat.type !== 'private') {
        this.audit('contact_bind_rejected', false, 'not-private');
        return;
      }
      if (!bindCodeUsable(file.bind, code, this.ports.now())) {
        const failures = file.bind.failures + 1;
        if (failures >= CONTACT_BIND_MAX_FAILURES) {
          // 猜太多次：这个码作废，要求重新生成
          const rest = { ...file };
          delete rest.bind;
          this.store.save(rest);
          this.audit('contact_bind_rejected', false, 'too-many-attempts');
          this.ports.publish();
          return;
        }
        this.store.save({ ...file, bind: { ...file.bind, failures } });
        this.audit('contact_bind_rejected', false, 'code-mismatch');
        return;
      }
      await this.completeBind(message);
      return;
    }

    const chatType = chatTypeOf(message.chat.type);
    const verdict = admitChat(file, message.chat, message.from?.id);
    // 认群用的标题：只记绑定的人或名单里的群发来的，陌生人拉的群不落盘
    if (
      chatType === 'group' &&
      message.chat.title &&
      (verdict !== 'group-not-allowed' ||
        isBoundChat(file.chat?.id, message.from?.id ?? Number.NaN))
    ) {
      const titled = withTelegramGroupTitle(file, String(message.chat.id), message.chat.title);
      if (titled) this.store.save(titled);
    }
    if (verdict !== 'ok') {
      this.reject(verdict === 'foreign-sender' ? 'foreign-chat' : verdict, message.chat.id);
      return;
    }
    this.rememberThread(message);
    const topicId = topicOf(message);
    const name = message.from?.username ?? message.from?.first_name;
    await this.ports.inbound({
      kind: 'text',
      peer: {
        channelId: this.id,
        peerId: String(message.chat.id),
        ...(topicId ? { topicId } : {}),
      },
      text,
      ...(chatType ? { chatType } : {}),
      ...(chatType === 'group' && message.chat.title ? { chatTitle: message.chat.title } : {}),
      ...(message.from ? { senderId: String(message.from.id) } : {}),
      ...(name ? { name } : {}),
      ...(message.date ? { at: message.date * 1000 } : {}),
    });
  }

  /** 静默丢掉：不回话，只记审计；名单外的群带上 chatId，方便用户查到要加哪个 */
  private reject(
    reason: 'foreign-chat' | 'group-not-allowed' | 'foreign-sender',
    chatId: number
  ): void {
    this.audit(
      'contact_inbound_rejected',
      false,
      reason === 'group-not-allowed' ? `${reason} chat=${chatId}` : reason
    );
  }

  private async completeBind(message: TelegramMessage): Promise<void> {
    const file = this.store.file();
    const bot = file.bot;
    if (!bot) return;
    const rest = { ...file };
    delete rest.bind;
    const chat = {
      id: message.chat.id,
      ...((message.from?.username ?? message.chat.username)
        ? { username: message.from?.username ?? message.chat.username }
        : {}),
      ...((message.from?.first_name ?? message.chat.title)
        ? { name: message.from?.first_name ?? message.chat.title }
        : {}),
    };
    this.store.save({ ...rest, chat, boundAt: this.ports.now() });
    this.audit('contact_bound', true, `chat=${chat.id}`);
    this.ports.publish();
    this.ports.onBound?.();
    void this.setCommands(String(chat.id), this.ports.menuCommands());
    const welcome = formatWelcomeMessage(this.ports.lang(), escapeHtml(bot.name));
    const commands = commandListText(this.ports.lang(), this.store.file().allowMemory);
    const sent = await this.send(String(chat.id), {
      text: `${welcome}\n\n${commands}`,
      format: 'html',
    });
    if (sent.ok) this.audit('contact_outbound', true, 'welcome');
  }

  /** 话题消息记下话题；在 General 里说话就清掉，之后回到 General */
  private rememberThread(message: TelegramMessage): void {
    const chatId = String(message.chat.id);
    if (message.is_topic_message && message.message_thread_id !== undefined) {
      this.threads.set(chatId, message.message_thread_id);
    } else {
      this.threads.delete(chatId);
    }
  }

  private async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    const token = this.store.token();
    if (!token) return;
    try {
      await this.apiFor(token).answerCallbackQuery({ callbackQueryId, text });
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    const code = telegramErrorCode(error);
    this.audit('contact_error', false, code);
    this.ports.onError?.(code, error instanceof Error ? error.message : undefined);
  }

  private audit(op: string, ok: boolean, detail?: string): void {
    this.ports.audit({
      at: this.ports.now(),
      secretaryConversationId: null,
      op,
      ok,
      ...(detail ? { detail } : {}),
    });
  }
}
