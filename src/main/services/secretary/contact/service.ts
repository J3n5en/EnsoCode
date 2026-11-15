import { createHash } from 'node:crypto';
import {
  botCommands,
  type ContactCommandName,
  commandListText,
  escapeHtml,
  parseContactCommand,
  unknownCommandText,
} from '@shared/secretary/commands';
import {
  askCallbackData,
  askCallbackToast,
  bindCodeUsable,
  bindDeepLink,
  botTokenHint,
  CONTACT_BIND_CODE_TTL_MS,
  CONTACT_BIND_MAX_FAILURES,
  CONTACT_OUTBOUND_MAX_CHARS,
  type ContactLang,
  cardCallbackData,
  cardCallbackToast,
  createBindCode,
  feedCallbackData,
  formatAskMessage,
  formatCardWaitingMessage,
  formatInboundMessage,
  formatMilestoneMessage,
  formatTestMessage,
  formatWelcomeMessage,
  isBoundChat,
  normalizeBotToken,
  parseAskCallbackData,
  parseCardCallbackData,
  parseFeedCallback,
  shouldForwardMilestone,
  startCommandCode,
} from '@shared/secretary/contact';
import type { FeedCursor } from '@shared/secretary/feed';
import type { AskRequestInfo } from '@shared/types/agent';
import type {
  SecretaryAuditEntry,
  SecretaryContactState,
  SecretaryProfile,
  SecretaryResultKind,
} from '@shared/types/secretary';
import {
  createTelegramApi,
  type TelegramApi,
  TelegramApiError,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
} from './client';
import type { ContactCommands } from './commands';
import { ContactPoller } from './poller';
import type { ContactStore } from './store';

/** 界面按码翻译成自己的文案；这里只回稳定的错误码 */
export type ContactError =
  | 'token-invalid'
  | 'token-required'
  | 'network'
  | 'unauthorized'
  | 'api'
  | 'not-bound'
  | 'no-secretary'
  | 'deliver-failed';

export type ContactResult = { ok: true } | { ok: false; error: ContactError };

export interface ContactMilestoneInput {
  kind: SecretaryResultKind;
  /** 项目 · 会话标题 */
  title: string;
  lastText?: string;
  conversationId: string;
}

export interface ContactCardWaitingInput {
  count: number;
  title?: string;
  /** 待确认的卡片：只有派发类卡片可能在手机上确认 */
  cards?: readonly { id: string; kind: string }[];
}

export interface ContactRelayAskInput {
  conversationId: string;
  question: string;
  options?: readonly string[];
  /** 会话的一句话标签 */
  label: string;
}

/** 回传宿主转发给手机的那几件事；TelegramContactService 就是它的实现 */
export interface SecretaryContactPort {
  onMilestone(input: ContactMilestoneInput): void;
  onRelayAsk(input: ContactRelayAskInput): void;
  onAskRequest(conversationId: string, ask: AskRequestInfo): void;
  onAskResolved(conversationId: string, requestId: string): void;
  onTurnReply(conversationId: string, text: string): void;
  onCardWaiting(input: ContactCardWaitingInput): void;
}

/** 联系方式服务用到的 Main 侧能力；全部注入，单测里换成假的 */
export interface ContactServicePorts {
  audit(entry: SecretaryAuditEntry): void;
  publish(): void;
  now(): number;
  random(): number;
  lang(): ContactLang;
  /** 出站是否发送由档案的 notify 决定 */
  notifyMode(): SecretaryProfile['notify'] | null;
  /** 手机发来的话投给哪个秘书会话；没有可用会话时返回 null */
  secretaryConversationId(): string | null;
  deliver(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }>;
  answerAsk(
    conversationId: string,
    requestId: string,
    answer: string
  ): { ok: boolean; error?: string };
  /** 只有「允许从 Telegram 确认派发类卡片」打开时才用；审批永远不走这里 */
  resolveProposal(
    proposalId: string,
    action: 'confirm' | 'reject'
  ): Promise<{ ok: boolean; error?: string }>;
  /** 出站失败只提示，不打断秘书 */
  onError?(code: ContactError, detail?: string): void;
  /** 只读命令：由 Main 查面板同一份数据，不进秘书会话 */
  commands?: ContactCommands;
  /** 测试注入假 API；生产按 token 现建 */
  api?(token: string): TelegramApi;
}

/** 审计里只留长度与 hash：正文、用户名、token 都不落盘 */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function describe(text: string): string {
  return `len=${text.length} hash=${digest(text)}`;
}

interface PendingAsk {
  slot: number;
  conversationId: string;
  requestId: string;
  options: string[];
  at: number;
}

const MAX_PENDING_ASKS = 8;

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

function errorCode(error: unknown): ContactError {
  if (error instanceof TelegramApiError) {
    if (error.kind === 'network') return 'network';
    if (error.kind === 'unauthorized') return 'unauthorized';
    return 'api';
  }
  return 'api';
}

/**
 * Telegram 联系方式：绑定向导、长轮询、出站里程碑、入站消息与提问按钮。
 * 只认绑定的那个 chat；确认卡与审批一律不在手机上处理。
 */
export class TelegramContactService implements SecretaryContactPort {
  private readonly poller: ContactPoller;
  private readonly apis = new Map<string, TelegramApi>();
  private readonly asks: PendingAsk[] = [];
  private readonly cards = new Map<number, { proposalId: string; at: number }>();
  private slot = 1;
  /** 从手机发来消息后，等这一轮的正文再回发手机 */
  private readonly awaitingReply = new Set<string>();
  /** /feed 的翻页游标：按钮上只带短编号，重启后按钮失效即可 */
  private readonly feedCursors = new Map<string, FeedCursor>();
  private feedSeq = 1;

  constructor(
    private readonly store: ContactStore,
    private readonly ports: ContactServicePorts
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

  state(): SecretaryContactState {
    const file = this.store.file();
    const token = this.store.token();
    const bind = file.bind;
    const status = file.chat ? 'bound' : bind ? 'awaiting-start' : 'unbound';
    return {
      telegram: {
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
        allowDispatchConfirm: file.allowDispatchConfirm,
        allowMemory: file.allowMemory,
        poll: this.poller.status(),
        secure: this.store.isSecure(),
      },
    };
  }

  /** 启动时接着轮询：上次已经绑过、token 还在 */
  async start(): Promise<void> {
    await this.store.ready();
    if (this.store.file().chat && this.store.token()) {
      this.poller.start();
      this.syncCommands();
    }
  }

  async stop(): Promise<void> {
    await this.poller.stop();
  }

  /** 第 2、3 步：校验 token（getMe）并生成一次性绑定码；只带码时用已存 token 重新生成 */
  async bind(rawToken?: unknown): Promise<ContactResult> {
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
        const code = errorCode(error);
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
    this.syncCommands();
    this.ports.publish();
    return { ok: true };
  }

  /** 第 3 步的「重新生成」：码过期或对不上时用同一个 bot 再发一个新码 */
  async regenerate(): Promise<ContactResult> {
    return this.bind();
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

  /** 解绑：清 chat 与绑定码，停止轮询；bot 与 token 留着，重新绑定不必再贴一次 */
  async unbind(): Promise<ContactResult> {
    await this.poller.stop();
    this.store.saveUnbound();
    this.asks.length = 0;
    this.awaitingReply.clear();
    this.audit('contact_unbind', true);
    this.ports.publish();
    return { ok: true };
  }

  /** 更换 bot：token、bot 身份、chat 一起清，向导回到第 1 步 */
  async forgetBot(): Promise<ContactResult> {
    await this.poller.stop();
    await this.store.saveForgotten();
    this.asks.length = 0;
    this.awaitingReply.clear();
    this.audit('contact_forget_bot', true);
    this.ports.publish();
    return { ok: true };
  }

  async sendTest(): Promise<ContactResult> {
    const file = this.store.file();
    if (!file.chat) return { ok: false, error: 'not-bound' };
    const text = formatTestMessage(this.ports.lang(), file.bot?.name ?? 'Secretary');
    const sent = await this.send(file.chat.id, text);
    this.audit('contact_test', sent.ok, sent.ok ? undefined : sent.error);
    return sent.ok ? { ok: true } : { ok: false, error: sent.error };
  }

  setAllowDispatchConfirm(value: boolean): void {
    this.store.save({ ...this.store.file(), allowDispatchConfirm: value === true });
    this.audit('contact_settings', true, `allowDispatchConfirm=${value === true}`);
    this.ports.publish();
  }

  /** 记忆标题的开关：关掉时命令菜单里也不出现 /memory */
  setAllowMemory(value: boolean): void {
    this.store.save({ ...this.store.file(), allowMemory: value === true });
    this.audit('contact_settings', true, `allowMemory=${value === true}`);
    this.syncCommands();
    this.ports.publish();
  }

  /** 秘书对 J 哥说的里程碑：与系统通知同一批结果，按 notify 决定发不发 */
  onMilestone(input: ContactMilestoneInput): void {
    const mode = this.ports.notifyMode();
    if (!mode || !shouldForwardMilestone(mode, input.kind)) return;
    const file = this.store.file();
    if (!file.chat) return;
    const text = formatMilestoneMessage(this.ports.lang(), {
      kind: input.kind,
      title: input.title,
      ...(input.lastText ? { lastText: input.lastText } : {}),
      link: `enso://secretary?conversation=${encodeURIComponent(input.conversationId)}`,
    });
    void this.send(file.chat.id, text).then((sent) => {
      this.audit('contact_milestone', sent.ok, sent.ok ? input.kind : sent.error);
    });
  }

  /** 派出会话转给秘书的提问：手机只提示，J 哥回话即进秘书会话 */
  onRelayAsk(input: ContactRelayAskInput): void {
    const file = this.store.file();
    if (!file.chat) return;
    const text = formatAskMessage(this.ports.lang(), {
      question: input.question,
      ...(input.options ? { options: input.options } : {}),
      title: input.label,
    });
    void this.send(file.chat.id, text).then((sent) => {
      this.audit('contact_relay_ask', sent.ok, sent.ok ? undefined : sent.error);
    });
  }

  /** 秘书自己用 ask_user 问 J 哥：带选项按钮，两边谁先答算谁的 */
  onAskRequest(conversationId: string, ask: AskRequestInfo): void {
    const file = this.store.file();
    if (!file.chat) return;
    const options = (ask.options ?? []).filter((option) => typeof option === 'string');
    const slot = this.slot++;
    const pending: PendingAsk = {
      slot,
      conversationId,
      requestId: ask.requestId,
      options,
      at: this.ports.now(),
    };
    this.asks.push(pending);
    while (this.asks.length > MAX_PENDING_ASKS) this.asks.shift();
    const text = formatAskMessage(this.ports.lang(), {
      question: ask.question,
      ...(options.length > 0 ? { options } : {}),
    });
    const replyMarkup =
      options.length > 0
        ? {
            inline_keyboard: options
              .slice(0, 8)
              .map((option, index) => [
                { text: option.slice(0, 40), callback_data: askCallbackData(slot, index) },
              ]),
          }
        : undefined;
    void this.send(file.chat.id, text, replyMarkup).then((sent) => {
      this.audit('contact_ask_forward', sent.ok, sent.ok ? undefined : sent.error);
    });
  }

  /** 提问收尾（应用里先答了、超时、取消）：手机上的按钮随之失效 */
  onAskResolved(conversationId: string, requestId: string): void {
    const index = this.asks.findIndex(
      (ask) => ask.conversationId === conversationId && ask.requestId === requestId
    );
    if (index >= 0) this.asks.splice(index, 1);
  }

  /** 秘书这一轮的正文：只在用户刚从手机发来消息时回发，避免把每轮都推一遍 */
  onTurnReply(conversationId: string, text: string): void {
    if (!this.awaitingReply.delete(conversationId)) return;
    const file = this.store.file();
    const body = text.trim();
    if (!file.chat || !body) return;
    void this.send(file.chat.id, body).then((sent) => {
      this.audit('contact_reply', sent.ok, sent.ok ? undefined : sent.error);
    });
  }

  /**
   * 有卡在等用户：默认只提示回应用确认。
   * 打开「允许从 Telegram 确认派发类卡片」后，只有派发卡片带确认按钮；
   * 设置、技能、工具、接管卡片与审批永远只提示。
   */
  onCardWaiting(input: ContactCardWaitingInput): void {
    const file = this.store.file();
    if (!file.chat || input.count <= 0) return;
    const dispatchCards = file.allowDispatchConfirm
      ? (input.cards ?? []).filter((card) => card.kind === 'dispatch').slice(0, 3)
      : [];
    const confirmable = dispatchCards.length > 0;
    const text = formatCardWaitingMessage(this.ports.lang(), {
      count: input.count,
      ...(input.title ? { title: input.title } : {}),
      ...(confirmable ? { confirmable } : {}),
    });
    const replyMarkup = confirmable
      ? {
          inline_keyboard: dispatchCards.map((card) => {
            const slot = this.slot++;
            this.cards.set(slot, { proposalId: card.id, at: this.ports.now() });
            return [
              {
                text: this.ports.lang() === 'zh' ? '确认派发' : 'Confirm',
                callback_data: cardCallbackData(slot, 'confirm'),
              },
              {
                text: this.ports.lang() === 'zh' ? '拒绝' : 'Reject',
                callback_data: cardCallbackData(slot, 'reject'),
              },
            ];
          }),
        }
      : undefined;
    void this.send(file.chat.id, text, replyMarkup).then((sent) => {
      this.audit('contact_card_waiting', sent.ok, sent.ok ? undefined : sent.error);
    });
  }

  /** 只读命令：查面板数据、格式化、回一条；审计只记命令名 */
  private async runCommand(name: ContactCommandName, arg: string): Promise<void> {
    const chatId = this.store.file().chat?.id;
    const commands = this.ports.commands;
    if (!chatId || !commands) return;
    const reply = await commands.run(name, arg);
    const sent = await this.send(chatId, reply.text, this.feedKeyboard(reply.next), 'HTML');
    this.audit('contact_command', sent.ok, name);
  }

  /** 写错的命令：给一份清单，不进秘书会话 */
  private async runUnknownCommand(): Promise<void> {
    const chatId = this.store.file().chat?.id;
    if (!chatId) return;
    const text = unknownCommandText(this.ports.lang(), this.store.file().allowMemory);
    const sent = await this.send(chatId, text, undefined, 'HTML');
    this.audit('contact_command', sent.ok, 'unknown');
  }

  /** 「更早」：原地换掉这一条，翻页不刷屏 */
  private async handleFeedCallback(query: TelegramCallbackQuery, token: string): Promise<void> {
    const cursor = this.feedCursors.get(token);
    const chatId = this.store.file().chat?.id;
    const messageId = query.message?.message_id;
    const commands = this.ports.commands;
    if (!cursor || !chatId || messageId === undefined || !commands) {
      await this.answerCallback(
        query.id,
        this.ports.lang() === 'zh'
          ? '这一页已经失效了，发 /feed 重新看'
          : 'Expired, send /feed again'
      );
      return;
    }
    const reply = await commands.feedPage(cursor);
    const keyboard = this.feedKeyboard(reply.next);
    const tokenValue = this.store.token();
    if (!tokenValue) return;
    try {
      await this.apiFor(tokenValue).editMessageText({
        chatId,
        messageId,
        text: reply.text,
        ...(keyboard ? { replyMarkup: keyboard } : {}),
        parseMode: 'HTML',
      });
      this.audit('contact_command', true, 'feed');
    } catch (error) {
      this.audit('contact_command', false, 'feed');
      this.reportError(error);
    }
    await this.answerCallback(query.id, undefined);
  }

  /** 翻页按钮：有下一页才给，游标留在内存里 */
  private feedKeyboard(
    next?: FeedCursor
  ): { inline_keyboard: { text: string; callback_data: string }[][] } | undefined {
    if (!next) return undefined;
    const token = `f${this.feedSeq++}`;
    this.feedCursors.set(token, next);
    while (this.feedCursors.size > 20) {
      const oldest = this.feedCursors.keys().next().value;
      if (oldest === undefined) break;
      this.feedCursors.delete(oldest);
    }
    return {
      inline_keyboard: [
        [
          {
            text: this.ports.lang() === 'zh' ? '更早' : 'Older',
            callback_data: feedCallbackData(token),
          },
        ],
      ],
    };
  }

  /** 命令菜单：只登记当前真的能用的命令（记忆默认不出现） */
  private syncCommands(): void {
    const token = this.store.token();
    if (!token) return;
    const allowMemory = this.store.file().allowMemory;
    const commands = botCommands().filter((entry) => entry.command !== 'memory' || allowMemory);
    void this.apiFor(token)
      .setMyCommands(commands)
      .catch((error) => this.reportError(error));
  }

  private apiFor(token: string): TelegramApi {
    const injected = this.ports.api?.(token);
    if (injected) return injected;
    const cached = this.apis.get(token);
    if (cached) return cached;
    const api = createTelegramApi(token);
    this.apis.set(token, api);
    return api;
  }

  private async send(
    chatId: number,
    text: string,
    replyMarkup?: { inline_keyboard: { text: string; callback_data: string }[][] },
    parseMode?: 'HTML'
  ): Promise<{ ok: true } | { ok: false; error: ContactError }> {
    const token = this.store.token();
    if (!token) return { ok: false, error: 'token-required' };
    // Telegram 单条 4096 上限：长回复截断，别让整条发不出去
    const body =
      text.length > CONTACT_OUTBOUND_MAX_CHARS
        ? `${text.slice(0, CONTACT_OUTBOUND_MAX_CHARS)}…`
        : text;
    try {
      await this.apiFor(token).sendMessage({
        chatId,
        text: body,
        ...(replyMarkup ? { replyMarkup } : {}),
        ...(parseMode ? { parseMode } : {}),
      });
      this.audit('contact_outbound', true, describe(body));
      return { ok: true };
    } catch (error) {
      const code = errorCode(error);
      this.audit('contact_outbound', false, code);
      this.ports.onError?.(code);
      return { ok: false, error: code };
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    const text = message?.text?.trim();
    if (!message || !text) return;
    const file = this.store.file();

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

    if (!isBoundChat(file.chat?.id, message.chat.id)) {
      this.audit('contact_inbound_rejected', false, 'foreign-chat');
      return;
    }

    // 只读命令：Main 直接查面板数据回一条，不进秘书会话、不唤醒模型
    const command = parseContactCommand(text);
    if (command) {
      await this.runCommand(command.name, command.arg);
      return;
    }
    // 光秃秃的 /xxx 当成写错的命令，别让它落进秘书会话
    if (/^\/[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(text)) {
      await this.runUnknownCommand();
      return;
    }

    // 挂着提问时，这句话就是回答：与应用里先答的那一边一致
    const pending = this.newestAsk();
    if (pending) {
      this.answerPendingAsk(pending, text);
      return;
    }

    const conversationId = this.ports.secretaryConversationId();
    if (!conversationId) {
      this.audit('contact_inbound', false, 'no-secretary');
      return;
    }
    const body = formatInboundMessage(this.ports.lang(), {
      ...(message.from?.username ? { username: message.from.username } : {}),
      text,
    });
    this.awaitingReply.add(conversationId);
    const delivered = await this.ports.deliver(conversationId, body);
    this.audit(
      'contact_inbound',
      delivered.ok,
      delivered.ok ? describe(text) : (delivered.error ?? 'deliver-failed'),
      conversationId
    );
    if (!delivered.ok) this.awaitingReply.delete(conversationId);
  }

  private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const feedToken = query.data ? parseFeedCallback(query.data) : null;
    if (feedToken !== null) {
      await this.handleFeedCallback(query, feedToken);
      return;
    }
    const card = query.data ? parseCardCallbackData(query.data) : null;
    if (card) {
      await this.handleCardCallback(query, card.slot, card.action);
      return;
    }
    const parsed = query.data ? parseAskCallbackData(query.data) : null;
    const pending = parsed ? this.asks.find((ask) => ask.slot === parsed.slot) : undefined;
    if (!parsed || !pending) {
      await this.answerCallback(
        query.id,
        this.ports.lang() === 'zh' ? '这条提问已经结束了' : 'Already answered'
      );
      return;
    }
    const option = pending.options[parsed.index];
    if (option === undefined) {
      await this.answerCallback(
        query.id,
        this.ports.lang() === 'zh' ? '选项不存在' : 'Unknown option'
      );
      return;
    }
    const answered = this.ports.answerAsk(pending.conversationId, pending.requestId, option);
    if (answered.ok) {
      this.asks.splice(this.asks.indexOf(pending), 1);
      this.audit('contact_ask_answer', true, `ask=${pending.slot}`);
      await this.answerCallback(query.id, askCallbackToast(this.ports.lang(), option));
      return;
    }
    // 应用里先答了：手机这边自动失效
    this.asks.splice(this.asks.indexOf(pending), 1);
    this.audit('contact_ask_answer', false, 'already-answered');
    await this.answerCallback(
      query.id,
      this.ports.lang() === 'zh' ? '已在应用里回答过了' : 'Already answered in the app'
    );
  }

  /** 派发卡片的确认/拒绝：卡片已经不在待确认里就只提示 */
  private async handleCardCallback(
    query: TelegramCallbackQuery,
    slot: number,
    action: 'confirm' | 'reject'
  ): Promise<void> {
    const card = this.cards.get(slot);
    if (!card) {
      await this.answerCallback(
        query.id,
        this.ports.lang() === 'zh' ? '这张卡已经处理过了' : 'That card is gone'
      );
      return;
    }
    this.cards.delete(slot);
    const result = await this.ports.resolveProposal(card.proposalId, action);
    this.audit('contact_card_resolve', result.ok, result.ok ? action : (result.error ?? 'failed'));
    await this.answerCallback(
      query.id,
      result.ok
        ? cardCallbackToast(this.ports.lang(), action)
        : this.ports.lang() === 'zh'
          ? '这张卡已经处理过了'
          : 'That card is gone'
    );
  }

  private answerPendingAsk(pending: PendingAsk, text: string): void {
    const answered = this.ports.answerAsk(pending.conversationId, pending.requestId, text);
    this.asks.splice(this.asks.indexOf(pending), 1);
    this.audit(
      'contact_ask_answer',
      answered.ok,
      answered.ok ? describe(text) : (answered.error ?? 'already-answered')
    );
    const file = this.store.file();
    if (!file.chat) return;
    const ack = answered.ok
      ? this.ports.lang() === 'zh'
        ? '✅ 已把你的回答交给秘书'
        : '✅ Sent your answer'
      : this.ports.lang() === 'zh'
        ? '这条提问已经结束了'
        : 'That question is already closed';
    void this.send(file.chat.id, ack).then(() => undefined);
  }

  private newestAsk(): PendingAsk | undefined {
    return this.asks.at(-1);
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
    this.syncCommands();
    const welcome = formatWelcomeMessage(this.ports.lang(), escapeHtml(bot.name));
    const commands = commandListText(this.ports.lang(), this.store.file().allowMemory);
    await this.send(chat.id, `${welcome}\n\n${commands}`, undefined, 'HTML');
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
    const code = errorCode(error);
    this.audit('contact_error', false, code);
    this.ports.onError?.(code, error instanceof Error ? error.message : undefined);
  }

  private audit(op: string, ok: boolean, detail?: string, conversationId?: string): void {
    this.ports.audit({
      at: this.ports.now(),
      secretaryConversationId: conversationId ?? null,
      op,
      ok,
      ...(detail ? { detail } : {}),
    });
  }
}
