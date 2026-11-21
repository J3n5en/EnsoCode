import { basename } from 'node:path';
import { commandListText, escapeHtml } from '@shared/secretary/commands';
import {
  bindCodeUsable,
  bindCommandCode,
  bindDeepLink,
  bindGroupLink,
  bindTopicCommand,
  botTokenHint,
  CONTACT_BIND_CODE_TTL_MS,
  CONTACT_BIND_MAX_FAILURES,
  type ContactLang,
  type ContactRouteClaim,
  createBindCode,
  formatTestMessage,
  formatWelcomeMessage,
  isBoundChat,
  normalizeBotToken,
  routeTarget,
  startCommandCode,
} from '@shared/secretary/contact';
import {
  htmlToPlain,
  markdownToTelegramChunks,
  packTelegramHtml,
} from '@shared/secretary/telegramHtml';
import type {
  SecretaryAuditEntry,
  SecretaryContactBindRejection,
  SecretaryContactBotUser,
  SecretaryContactChannelStatus,
  SecretaryContactGroupBinding,
  SecretaryContactTelegram,
  SecretaryContactTopic,
  SecretaryContactTopicsResult,
} from '@shared/types/secretary';
import type {
  ChannelCaps,
  ChannelErrorCode,
  ChannelFile,
  ChannelImage,
  ChannelInbound,
  ChannelInboundImage,
  ChannelMessage,
  ChannelResult,
  ChannelSend,
  ChannelSettle,
  ContactChannel,
} from './channel';
import {
  type TelegramApi,
  TelegramApiError,
  type TelegramInlineButton,
  type TelegramInlineKeyboard,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUpload,
} from './client';
import { TelegramHub, type TelegramSubscriber, telegramRouteTopicOf, telegramTopicOf } from './hub';
import {
  type ContactFile,
  type ContactStore,
  contactClaims,
  contactOwnerId,
  hasContactRoutes,
  parseTelegramGroupId,
  TELEGRAM_CHANNEL_ID,
  TELEGRAM_GENERAL_TOPIC_ID,
  telegramGroupAllowed,
  telegramGroupBindings,
  telegramGroupKnown,
  telegramTopicCatalog,
  withTelegramGroupTitle,
  withTelegramTopicTitle,
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

/** 别的秘书的联系方式：共用 bot 时看它认领了什么、主人是谁 */
export interface TelegramSibling {
  secretaryId: string;
  name: string;
  /** 总开关与 Telegram 渠道都开着 */
  enabled: boolean;
  file: ContactFile;
}

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
  /** 全局连接中心：同一个 token 只轮询一次；缺省时自建一个只给自己用的 */
  hub?: TelegramHub;
  /** 这个渠道属于哪个秘书；单秘书与单测缺省为 default */
  secretaryId?: string;
  /**
   * 同一个 bot 上别的秘书已经认领了这条路由（bot + chat + 话题）时返回它的名字；
   * 缺省表示只有这一个秘书。
   */
  routeConflict?(claim: ContactRouteClaim): string | null;
  /** 绑定成功时在群或话题里回一句「已绑定到秘书 X」 */
  secretaryName?(): string;
  /** 别的秘书的联系方式（不限 bot）；缺省表示只有这一个秘书 */
  siblings?(): TelegramSibling[];
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

const topicOf = telegramTopicOf;

/** 与 image_view 同一上限 */
const INBOUND_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** 带了附件的消息：图片要落盘，别的附件也要回一句收不下 */
function carriesMedia(message: TelegramMessage): boolean {
  return Boolean(
    message.photo?.length ||
      message.document ||
      message.video ||
      message.voice ||
      message.audio ||
      message.animation ||
      message.video_note ||
      message.sticker
  );
}

/** 发往话题的 thread id：General 不带 thread id 发，带了 1 反而发不进去 */
function threadIdOf(topicId: string | undefined): number | undefined {
  if (!topicId || topicId === TELEGRAM_GENERAL_TOPIC_ID) return undefined;
  const thread = Number(topicId);
  return Number.isInteger(thread) ? thread : undefined;
}

function threadOf(topicId: string | undefined): { messageThreadId?: number } {
  const thread = threadIdOf(topicId);
  return thread !== undefined ? { messageThreadId: thread } : {};
}

type AdmitVerdict =
  | 'ok'
  | 'foreign-chat'
  | 'group-not-allowed'
  | 'topic-not-allowed'
  | 'foreign-sender';

/**
 * 只认绑定的那个人：私聊就是绑定的 chat（私聊 chat id 等于用户 id）；
 * 群要整群在白名单或路由表里、或这个话题单独绑过（话题优先），且只放行他本人发的。
 * 别人的一律静默丢掉。topic 是路由用的话题：论坛的 General 记为 1。
 */
function admitChat(
  file: ContactFile,
  chat: { id: number; type?: string },
  fromId: number | undefined,
  topic: string | undefined
): AdmitVerdict {
  if (isBoundChat(file.chat?.id, chat.id)) return 'ok';
  if (chatTypeOf(chat.type) !== 'group') return 'foreign-chat';
  const chatId = String(chat.id);
  const routes = file.telegramRoutes.filter((route) => route.chatId === chatId);
  if (!telegramGroupAllowed(file, chat.id) && routes.length === 0) return 'group-not-allowed';
  const claims: ContactRouteClaim[] = [
    ...(telegramGroupAllowed(file, chat.id) ? [{ secretaryId: 'self', botId: 0, chatId }] : []),
    ...routes.map((route) => ({
      secretaryId: 'self',
      botId: 0,
      chatId,
      ...(route.topicId ? { topicId: route.topicId } : {}),
    })),
  ];
  if (!routeTarget(claims, 0, chatId, topic)) return 'topic-not-allowed';
  return isBoundChat(contactOwnerId(file), fromId ?? Number.NaN) ? 'ok' : 'foreign-sender';
}

/**
 * 内置 Telegram 渠道：绑定向导、长轮询、HTML 切条与降级、按钮、改消息、命令菜单。
 * 只认绑定的那个人（私聊，或他本人在白名单群里发的）；秘书语义（提问、确认卡、关注）全在核心里。
 */
export class TelegramChannel implements ContactChannel, TelegramSubscriber {
  readonly id = TELEGRAM_CHANNEL_ID;
  readonly secretaryId: string;
  private readonly hub: TelegramHub;
  /** 已经在 hub 上订阅：start 之后才收更新 */
  private attached = false;

  constructor(
    private readonly store: ContactStore,
    private readonly ports: TelegramChannelPorts
  ) {
    this.secretaryId = ports.secretaryId ?? 'default';
    this.hub =
      ports.hub ??
      new TelegramHub({
        ...(ports.api ? { api: ports.api } : {}),
        sleep,
        onError: (error) => this.reportError(error),
      });
  }

  caps(): ChannelCaps {
    return TELEGRAM_CAPS;
  }

  /** 绑定的私聊：测试消息发给它 */
  peerId(): string | null {
    const chat = this.store.file().chat;
    return chat ? String(chat.id) : null;
  }

  /** 主动推送的目标：私聊加上用绑定码绑的群与话题；群白名单只收不推 */
  pushPeers(): { peerId: string; topicId?: string }[] {
    const file = this.store.file();
    const peers: { peerId: string; topicId?: string }[] = [];
    if (file.chat) peers.push({ peerId: String(file.chat.id) });
    if (file.ownerId !== undefined || file.chat) {
      for (const route of file.telegramRoutes) {
        peers.push({ peerId: route.chatId, ...(route.topicId ? { topicId: route.topicId } : {}) });
      }
    }
    return peers;
  }

  // ---------- hub 订阅 ----------

  token(): string {
    return this.store.token();
  }

  claims(): ContactRouteClaim[] {
    return contactClaims(this.secretaryId, this.store.file());
  }

  /** 过期的码也交回来：由秘书自己判定过期并记失败，界面才能提示重新生成 */
  bindCode(): string | null {
    return this.store.file().bind?.code ?? null;
  }

  /** 主人：私聊绑定的 chat 或绑群时记下的发码人 */
  ownerId(): number | undefined {
    return contactOwnerId(this.store.file());
  }

  wantsPolling(): boolean {
    if (!this.attached) return false;
    const file = this.store.file();
    return Boolean(this.store.token()) && (hasContactRoutes(file) || file.bind !== undefined);
  }

  pollOffset(): number {
    return this.store.file().pollOffset;
  }

  savePollOffset(offset: number): void {
    const file = this.store.file();
    if (file.pollOffset === offset) return;
    this.store.save({ ...file, pollOffset: offset });
  }

  bindFailure(code: string): void {
    const file = this.store.file();
    if (!file.bind) return;
    if (code === file.bind.code) return;
    const failures = file.bind.failures + 1;
    if (failures >= CONTACT_BIND_MAX_FAILURES) {
      // 猜太多次：这个码作废，要求重新生成
      const rest = { ...file };
      delete rest.bind;
      this.store.save(rest);
      this.audit('contact_bind_rejected', false, 'too-many-attempts');
      this.ports.publish();
      this.hub.sync(this);
      return;
    }
    this.store.save({ ...file, bind: { ...file.bind, failures } });
    this.audit('contact_bind_rejected', false, 'code-mismatch');
  }

  /** 等码时收到的提示（例如私聊里只发了不带码的 /start）：记下来给界面看 */
  bindNotice(reason: SecretaryContactBindRejection['reason']): void {
    if (!this.store.file().bind) return;
    this.rejectBind({ reason }, reason);
  }

  /** 码没绑上：留在绑定中间态里，界面给出原因与下一步；码本身不作废 */
  private rejectBind(rejected: SecretaryContactBindRejection, detail: string): void {
    const file = this.store.file();
    if (!file.bind) return;
    this.store.save({ ...file, bind: { ...file.bind, rejected } });
    this.audit('contact_bind_rejected', false, detail);
    this.ports.publish();
  }

  /** 同一个 bot 上的别的秘书 */
  private botSiblings(): TelegramSibling[] {
    const botId = this.store.file().bot?.id;
    if (botId === undefined) return [];
    return (this.ports.siblings?.() ?? []).filter((sibling) => sibling.file.bot?.id === botId);
  }

  /**
   * 这个 bot 的主人：私聊只能归一个秘书，后来的秘书只能认领群和话题，
   * 主人沿用同一个 bot 上别的秘书已经验证过的那个人；不唯一时不猜。
   */
  withSharedOwner(file: ContactFile): ContactFile {
    if (contactOwnerId(file) !== undefined) return file;
    const owners = new Set(
      this.botSiblings()
        .map((sibling) => contactOwnerId(sibling.file))
        .filter((owner): owner is number => owner !== undefined)
    );
    if (owners.size !== 1) return file;
    const [ownerId] = owners;
    return { ...file, ownerId };
  }

  /** 共用这个 bot 的秘书（自己排第一）；只有自己时为 undefined */
  private sharedView(): SecretaryContactBotUser[] | undefined {
    const siblings = this.botSiblings();
    if (siblings.length === 0) return undefined;
    // 话题名是 bot 见过的，谁记下的都算：一个秘书没见过的名字用别的秘书记下的补上
    const titles: Record<string, string> = {};
    for (const file of [...siblings.map((sibling) => sibling.file), this.store.file()]) {
      for (const [key, title] of Object.entries(file.telegramTopicTitles)) {
        if (title) titles[key] = title;
      }
    }
    const named = (groups: SecretaryContactGroupBinding[]) =>
      groups.map((group) => ({
        ...group,
        topics: group.topics.map((topic) => {
          const title = topic.title ?? titles[`${group.id}:${topic.id}`];
          return title ? { ...topic, title } : topic;
        }),
      }));
    const userOf = (
      secretaryId: string,
      name: string,
      self: boolean,
      enabled: boolean,
      file: ContactFile
    ): SecretaryContactBotUser => ({
      secretaryId,
      name,
      self,
      enabled,
      ...(file.chat ? { privateChat: file.chat } : {}),
      groups: contactOwnerId(file) !== undefined ? named(telegramGroupBindings(file)) : [],
    });
    return [
      userOf(
        this.secretaryId,
        this.ports.secretaryName?.() ?? this.secretaryId,
        true,
        this.attached,
        this.store.file()
      ),
      ...siblings.map((sibling) =>
        userOf(sibling.secretaryId, sibling.name, false, sibling.enabled, sibling.file)
      ),
    ];
  }

  /** 哪个秘书都没绑这里：不响应，只记审计；主人在群里说话时记下群名，界面认群用 */
  rejectUnrouted(update: TelegramUpdate): void {
    const file = this.store.file();
    const message = update.message ?? update.callback_query?.message;
    if (!message) return;
    const fromId = update.message?.from?.id ?? update.callback_query?.from?.id;
    if (
      chatTypeOf(message.chat.type) === 'group' &&
      message.chat.title &&
      isBoundChat(contactOwnerId(file), fromId ?? Number.NaN)
    ) {
      const titled = withTelegramGroupTitle(file, String(message.chat.id), message.chat.title);
      if (titled) this.store.save(titled);
    }
    if (file.bind && !hasContactRoutes(file)) {
      this.audit('contact_inbound_rejected', false, 'awaiting-start');
      return;
    }
    const topic = telegramRouteTopicOf(message);
    const verdict = admitChat(file, message.chat, fromId, topic);
    this.reject(
      verdict === 'ok' || verdict === 'foreign-sender' ? 'foreign-chat' : verdict,
      message.chat.id,
      topic
    );
  }

  /**
   * 记下论坛话题给设置页勾选：建话题、改名的服务消息带名字，话题里的普通消息回复的是建话题那条。
   * 只记本秘书绑过或认识的群、或主人发的，陌生人拉的群不落盘。
   */
  observe(message: TelegramMessage): void {
    const topic = topicOf(message);
    if (!topic || chatTypeOf(message.chat.type) !== 'group') return;
    const file = this.store.file();
    const chatId = String(message.chat.id);
    if (
      !telegramGroupKnown(file, chatId) &&
      !isBoundChat(contactOwnerId(file), message.from?.id ?? Number.NaN)
    ) {
      return;
    }
    const name =
      message.forum_topic_created?.name ??
      message.forum_topic_edited?.name ??
      message.reply_to_message?.forum_topic_created?.name ??
      '';
    const next = withTelegramTopicTitle(file, chatId, topic, name.trim());
    if (next) this.store.save(next);
  }

  /**
   * 拉一个群的话题给设置页勾选。Bot API 没有列话题的方法：先 getChat 确认 bot 在群里、
   * 群开了话题，再给出 General 与 bot 见过的话题（建话题、改名或话题里有人说话时记下）。
   */
  async topics(rawChatId: unknown): Promise<SecretaryContactTopicsResult> {
    const chatId = parseTelegramGroupId(rawChatId);
    if (!chatId) return { ok: false, error: 'invalid-chat-id' };
    const token = this.store.token();
    if (!token) return { ok: false, error: 'token-required' };
    let chat: { type?: string; title?: string; is_forum?: boolean };
    try {
      chat = await this.apiFor(token).getChat(Number(chatId));
    } catch (error) {
      const code = telegramErrorCode(error);
      this.audit('contact_topics', false, code);
      // 只回 Telegram 自己的说明（如 chat not found）；网络错误的原文可能带请求地址
      const detail = code === 'api' && error instanceof Error ? error.message.slice(0, 200) : '';
      return { ok: false, error: code, ...(detail ? { detail } : {}) };
    }
    if (chatTypeOf(chat.type) !== 'group') return { ok: false, error: 'not-group' };
    const titled = chat.title
      ? withTelegramGroupTitle(this.store.file(), chatId, chat.title)
      : null;
    const file = titled ? this.store.save(titled) : this.store.file();
    this.audit('contact_topics', true, `chat=${chatId}`);
    const title = chat.title ? { title: chat.title } : {};
    if (!chat.is_forum) return { ok: true, forum: false, ...title, topics: [] };
    // 同一个 bot 见过的话题是共用的：别的秘书记下的也列出来，并标出已经单独归了谁
    const topics = new Map<string, SecretaryContactTopic>();
    for (const topic of telegramTopicCatalog(file, chatId)) topics.set(topic.id, topic);
    for (const sibling of this.botSiblings()) {
      const claimed = new Set(
        contactClaims(sibling.secretaryId, sibling.file).flatMap((claim) =>
          claim.chatId === chatId && claim.topicId ? [claim.topicId] : []
        )
      );
      for (const topic of telegramTopicCatalog(sibling.file, chatId)) {
        const known = topics.get(topic.id);
        const name = known?.title ?? topic.title;
        topics.set(topic.id, {
          id: topic.id,
          ...(name ? { title: name } : {}),
          ...(known?.owner ? { owner: known.owner } : {}),
          ...(claimed.has(topic.id) ? { owner: sibling.name } : {}),
        });
      }
    }
    const general = topics.get(TELEGRAM_GENERAL_TOPIC_ID);
    topics.delete(TELEGRAM_GENERAL_TOPIC_ID);
    // 别的秘书记下的话题名也记到自己这里：勾完之后自己的群列表同样认得出
    let own = file;
    let learned = false;
    for (const topic of topics.values()) {
      if (!topic.title || own.telegramTopicTitles[`${chatId}:${topic.id}`]) continue;
      const next = withTelegramTopicTitle(own, chatId, topic.id, topic.title);
      if (next) {
        own = next;
        learned = true;
      }
    }
    if (learned) this.store.save(own);
    return {
      ok: true,
      forum: true,
      ...title,
      topics: [
        general?.owner ? general : { id: TELEGRAM_GENERAL_TOPIC_ID },
        ...[...topics.values()].sort((a, b) => Number(a.id) - Number(b.id)),
      ],
    };
  }

  onPollStatus(): void {
    this.ports.publish();
  }

  status(): { status: SecretaryContactChannelStatus; detail?: string } {
    const file = this.store.file();
    const poll = this.hub.status(this.store.token());
    const bound = hasContactRoutes(file);
    if (bound && poll.state === 'error') {
      return { status: 'error', ...(poll.lastError ? { detail: poll.lastError } : {}) };
    }
    if (bound) return { status: 'connected' };
    if (file.bind) return { status: 'pending' };
    return { status: 'unconfigured' };
  }

  view(): Omit<SecretaryContactTelegram, 'following'> {
    const file = this.store.file();
    const token = this.store.token();
    const bind = file.bind;
    const status = hasContactRoutes(file) ? 'bound' : bind ? 'awaiting-start' : 'unbound';
    const shared = this.sharedView();
    return {
      status,
      ...(file.bot ? { bot: file.bot } : {}),
      ...(file.chat ? { chat: file.chat } : {}),
      ...(file.boundAt !== undefined ? { boundAt: file.boundAt } : {}),
      ...(bind && file.bot
        ? {
            bind: {
              code: bind.code,
              expiresAt: bind.expiresAt,
              link: bindDeepLink(file.bot.username, bind.code),
              groupLink: bindGroupLink(file.bot.username, bind.code),
              topicCommand: bindTopicCommand(file.bot.username, bind.code),
              ...(bind.rejected ? { rejected: bind.rejected } : {}),
            },
          }
        : {}),
      ...(token ? { tokenHint: botTokenHint(token) } : {}),
      allowCardConfirm: file.allowCardConfirm,
      allowMemory: file.allowMemory,
      syncMirror: file.syncMirror,
      groups: telegramGroupBindings(file),
      routes: file.telegramRoutes.map((route) => ({
        chatId: route.chatId,
        ...(route.topicId ? { topicId: route.topicId } : {}),
        ...(route.title ? { title: route.title } : {}),
      })),
      ...(shared ? { shared } : {}),
      poll: this.hub.status(this.store.token()),
      secure: this.store.isSecure(),
    };
  }

  /** 启动或重新打开开关：上次已经绑过、token 还在才轮询 */
  async start(): Promise<void> {
    await this.store.ready();
    this.attached = true;
    this.hub.sync(this);
    if (hasContactRoutes(this.store.file()) && this.store.token()) {
      void this.setCommands(this.peerId() ?? '', this.ports.menuCommands());
    }
  }

  async stop(): Promise<void> {
    this.attached = false;
    await this.hub.detach(this);
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
    this.attached = true;
    this.hub.sync(this);
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
    this.hub.sync(this);
    this.ports.publish();
  }

  /** 解绑：清 chat 与绑定码，停止轮询；bot 与 token 留着 */
  async unbind(): Promise<void> {
    const chatId = this.store.file().chat?.id;
    this.store.saveUnbound();
    this.hub.sync(this);
    await this.clearCommands(chatId);
  }

  /** 解绑一条群或话题路由：别的秘书才能绑过去 */
  removeRoute(chatId: string, topicId: string | undefined): boolean {
    const file = this.store.file();
    const routes = file.telegramRoutes.filter(
      (route) => !(route.chatId === chatId && (route.topicId ?? '') === (topicId ?? ''))
    );
    if (routes.length === file.telegramRoutes.length) return false;
    this.store.save({ ...file, telegramRoutes: routes });
    this.audit(
      'contact_route_removed',
      true,
      `chat=${chatId}${topicId ? ` topic=${topicId}` : ''}`
    );
    this.hub.sync(this);
    return true;
  }

  /** 更换 bot：token、bot 身份、chat 一起清 */
  async forgetBot(): Promise<void> {
    const chatId = this.store.file().chat?.id;
    // token 还在时才能调 API：先清菜单，再忘掉 bot
    await this.clearCommands(chatId);
    await this.hub.detach(this);
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
    // 解绑后立刻停：没有任何路由就不再发
    if (!token || !hasContactRoutes(this.store.file()))
      return { ok: false, error: 'token-required' };
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

  sendImage(peerId: string, image: ChannelImage, topicId?: string): Promise<ChannelSend> {
    return this.upload(peerId, 'photo', image, topicId);
  }

  sendFile(peerId: string, file: ChannelFile, topicId?: string): Promise<ChannelSend> {
    return this.upload(peerId, 'document', file, topicId);
  }

  /**
   * 图片走 sendPhoto，文件走 sendDocument，都带回原话题的 message_thread_id。
   * caption 超过 1024 就不放在媒体上，媒体发完再另发一条文字。
   * sendPhoto 被拒（尺寸、比例不合要求）时退成 sendDocument 原样发出。
   */
  private async upload(
    peerId: string,
    kind: 'photo' | 'document',
    media: ChannelImage,
    topicId?: string
  ): Promise<ChannelSend> {
    const token = this.store.token();
    if (!token || !hasContactRoutes(this.store.file()))
      return { ok: false, error: 'token-required' };
    const data = media.buffer;
    if (!data) return { ok: false, error: 'api' };
    const caption = media.caption?.trim() ?? '';
    const inline = caption.length <= TELEGRAM_CAPTION_MAX;
    const threadId = threadIdOf(topicId);
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
      const rest = await this.send(peerId, { text: caption }, topicId);
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
    // 命令菜单的默认与中文两份是整个 bot 的：同一个 bot 上别的秘书还在用就留着
    const shared = this.botSiblings().some((sibling) => hasContactRoutes(sibling.file));
    await this.runMenuCalls([
      ...(chatId
        ? [
            {
              detail: 'delete:chat',
              run: () => api.deleteMyCommands({ scope: { type: 'chat', chat_id: chatId } }),
            },
          ]
        : []),
      ...(shared
        ? []
        : [
            { detail: 'delete:zh', run: () => api.deleteMyCommands({ languageCode: 'zh' }) },
            { detail: 'delete:default', run: () => api.deleteMyCommands() },
            { detail: 'menu:default', run: () => api.setChatMenuButton({ type: 'default' }) },
          ]),
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
    return this.hub.apiFor(token);
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

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const file = this.store.file();
    if (update.callback_query) {
      const query = update.callback_query;
      const chat = query.message?.chat;
      // 群里的按钮：群或这个话题绑过，且只认绑定的那个人点
      if (file.chat && chat && query.message) {
        const topic = telegramRouteTopicOf(query.message);
        const verdict = admitChat(file, chat, query.from?.id, topic);
        if (verdict !== 'ok') {
          this.reject(verdict, chat.id, topic);
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
    if (!message) return;
    const text = (message.text ?? message.caption ?? '').trim();
    const hasMedia = carriesMedia(message);
    if (!text && !hasMedia) return;

    // 绑定向导：私聊里的 /start <code> 绑私聊，群或话题里的 /bind <code> 绑群或话题；
    // 对不上就忽略，绝不绑到陌生人身上。已经有路由时，别的话照常收。
    const bindCode = bindCommandCode(text) ?? startCommandCode(text);
    if (file.bind && (bindCode || !hasContactRoutes(file))) {
      const code = bindCode;
      if (!code) {
        this.audit('contact_inbound_rejected', false, 'awaiting-start');
        return;
      }
      const chatKind = chatTypeOf(message.chat.type);
      if (message.chat.type && chatKind === undefined) {
        this.audit('contact_bind_rejected', false, 'not-private');
        return;
      }
      if (!bindCodeUsable(file.bind, code, this.ports.now())) {
        if (code === file.bind.code) {
          // 码是对的、只是过期了：不算猜错，界面提示重新生成
          this.rejectBind({ reason: 'expired' }, 'expired');
          return;
        }
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
      if (chatKind === 'group') await this.completeGroupBind(message);
      else await this.completeBind(message);
      return;
    }

    const chatType = chatTypeOf(message.chat.type);
    const routeTopic = telegramRouteTopicOf(message);
    const verdict = admitChat(file, message.chat, message.from?.id, routeTopic);
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
      this.reject(
        verdict === 'foreign-sender' ? 'foreign-chat' : verdict,
        message.chat.id,
        routeTopic
      );
      return;
    }
    const topicId = topicOf(message);
    const name = message.from?.username ?? message.from?.first_name;
    const images = hasMedia ? await this.downloadImages(message) : [];
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
      ...(images.length ? { images } : {}),
    });
  }

  /** 只在放行之后下载：照片取不超过 10MB 的最大尺寸，文件只收 image/*，其余附件标明收不下 */
  private async downloadImages(message: TelegramMessage): Promise<ChannelInboundImage[]> {
    const token = this.store.token();
    const fetchImage = async (fileId: string): Promise<ChannelInboundImage> => {
      if (!token) return { rejected: 'unavailable' };
      try {
        const data = await this.apiFor(token).downloadFile(fileId, INBOUND_IMAGE_MAX_BYTES);
        return data === 'too-large' ? { rejected: 'too-large' } : { data };
      } catch (error) {
        this.audit('contact_inbound_media', false, telegramErrorCode(error));
        return { rejected: 'unavailable' };
      }
    };
    if (message.photo?.length) {
      const fitting = message.photo.filter(
        (size) => size.file_size === undefined || size.file_size <= INBOUND_IMAGE_MAX_BYTES
      );
      const best = fitting.at(-1);
      return [best ? await fetchImage(best.file_id) : { rejected: 'too-large' }];
    }
    const document = message.document;
    if (document) {
      if (!document.mime_type?.startsWith('image/')) return [{ rejected: 'not-image' }];
      if ((document.file_size ?? 0) > INBOUND_IMAGE_MAX_BYTES) return [{ rejected: 'too-large' }];
      return [await fetchImage(document.file_id)];
    }
    return [{ rejected: 'not-image' }];
  }

  /** 静默丢掉：不回话，只记审计；名单外的群和话题带上 id，方便用户查到要加哪个 */
  private reject(reason: Exclude<AdmitVerdict, 'ok'>, chatId: number, topic?: string): void {
    const detail =
      reason === 'group-not-allowed'
        ? `${reason} chat=${chatId}`
        : reason === 'topic-not-allowed'
          ? `${reason} chat=${chatId} topic=${topic ?? ''}`
          : reason;
    this.audit('contact_inbound_rejected', false, detail);
  }

  private async completeBind(message: TelegramMessage): Promise<void> {
    const file = this.store.file();
    const bot = file.bot;
    if (!bot) return;
    // 私聊也是绑了谁归谁：同一个 bot 的这个私聊已经属于别的秘书就拒绝
    const conflict = this.ports.routeConflict?.({
      secretaryId: this.secretaryId,
      botId: bot.id,
      chatId: String(message.chat.id),
    });
    if (conflict) {
      // 同一个人和同一个 bot 只有一个私聊：码留着，告诉他改去群或话题里发
      this.rejectBind({ reason: 'private-owned', owner: conflict }, 'route-conflict');
      const code = file.bind?.code ?? '';
      const me = escapeHtml(this.ports.secretaryName?.() ?? bot.name);
      const owner = escapeHtml(conflict);
      const command = escapeHtml(bindTopicCommand(bot.username, code));
      const text =
        this.ports.lang() === 'zh'
          ? `这个私聊已经归秘书「${owner}」，不能再绑给「${me}」。\n要让「${me}」也用这个 bot，请在群里或论坛话题里发送：\n<code>${command}</code>\n或者给「${me}」换一个 bot。`
          : `This private chat already belongs to secretary "${owner}", so it cannot be bound to "${me}" too.\nTo use this bot with "${me}", send this in a group or forum topic:\n<code>${command}</code>\nor give "${me}" a different bot.`;
      const sent = await this.send(String(message.chat.id), { text, format: 'html' });
      if (sent.ok) this.audit('contact_outbound', true, 'bind-hint');
      return;
    }
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

  /**
   * 在群或话题里完成绑定：已经有主人就只认主人，没有就把发码的人记为主人。
   * 冲突（同一 bot + chat + 话题已属于别的秘书）时拒绝，只记审计，不在群里回话。
   */
  private async completeGroupBind(message: TelegramMessage): Promise<void> {
    const file = this.store.file();
    const bot = file.bot;
    const fromId = message.from?.id;
    if (!bot) return;
    if (fromId === undefined) {
      this.audit('contact_bind_rejected', false, 'no-sender');
      return;
    }
    const owner = contactOwnerId(file);
    if (owner !== undefined && owner !== fromId) {
      this.audit('contact_bind_rejected', false, 'foreign-sender');
      return;
    }
    const chatId = String(message.chat.id);
    const topicId = topicOf(message);
    const conflict = this.ports.routeConflict?.({
      secretaryId: this.secretaryId,
      botId: bot.id,
      chatId,
      ...(topicId ? { topicId } : {}),
    });
    if (conflict) {
      // 群里不回话（别人也看得到），原因留给界面
      this.rejectBind({ reason: 'route-conflict', owner: conflict }, 'route-conflict');
      return;
    }
    const rest = { ...file };
    delete rest.bind;
    const routes = file.telegramRoutes.filter(
      (route) => !(route.chatId === chatId && (route.topicId ?? '') === (topicId ?? ''))
    );
    this.store.save({
      ...rest,
      ...(owner === undefined ? { ownerId: fromId } : {}),
      telegramRoutes: [
        ...routes,
        {
          chatId,
          ...(topicId ? { topicId } : {}),
          ...(message.chat.title ? { title: message.chat.title } : {}),
          boundAt: this.ports.now(),
        },
      ],
    });
    this.audit('contact_bound', true, `chat=${chatId}${topicId ? ` topic=${topicId}` : ''}`);
    this.hub.sync(this);
    this.ports.publish();
    this.ports.onBound?.();
    const name = escapeHtml(this.ports.secretaryName?.() ?? bot.name);
    const text =
      this.ports.lang() === 'zh'
        ? `已绑定到秘书「${name}」：这里的消息由它接收，它的提醒也会发到这里。`
        : `Bound to secretary "${name}": it reads messages here and posts its updates here.`;
    const sent = await this.send(chatId, { text, format: 'html' }, topicId);
    if (sent.ok) this.audit('contact_outbound', true, 'bound');
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
