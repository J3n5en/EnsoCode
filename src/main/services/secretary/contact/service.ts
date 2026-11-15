import { createHash } from 'node:crypto';
import {
  botCommands,
  type ContactReadCommandName,
  commandListText,
  escapeHtml,
  followingEmptyText,
  followingUsageText,
  followKindLabel,
  formatFollowingMessage,
  formatSyncMessage,
  parseContactCommand,
  parseFollowingArg,
  parseSyncArg,
  syncUsageText,
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
  type ContactLang,
  cardCallbackData,
  cardCallbackToast,
  cardConfirmButtonText,
  cardKindLabel,
  cardLabel,
  cardOpenButtonText,
  cardSettledText,
  conversationDeepLink,
  createBindCode,
  feedCallbackData,
  followCallbackData,
  formatAskMessage,
  formatCardWaitingMessage,
  formatFollowedScheduleMessage,
  formatMilestoneMessage,
  formatSilentTurnLine,
  formatTestMessage,
  formatWelcomeMessage,
  isBoundChat,
  normalizeBotToken,
  parseAskCallbackData,
  parseCardCallbackData,
  parseFeedCallback,
  parseFollowCallback,
  proposalDeepLink,
  type SecretaryCardKind,
  shouldForwardMilestone,
  startCommandCode,
  telegramUrlButtonSupported,
} from '@shared/secretary/contact';
import type { FeedCursor } from '@shared/secretary/feed';
import { wrapInboundMessage } from '@shared/secretary/inbound';
import {
  buildRecapTurns,
  formatRecapMessage,
  parseRecapRounds,
  type RecapMessage,
  recapEmptyText,
  recapUsageText,
} from '@shared/secretary/recap';
import {
  htmlToPlain,
  markdownToTelegramChunks,
  packTelegramHtml,
} from '@shared/secretary/telegramHtml';
import type { AskRequestInfo } from '@shared/types/agent';
import type {
  SecretaryAuditEntry,
  SecretaryContactState,
  SecretaryProfile,
  SecretaryResultKind,
} from '@shared/types/secretary';
import { type FollowedTask, type FollowingPort, followingViews } from '../following';
import {
  createTelegramApi,
  type TelegramApi,
  TelegramApiError,
  type TelegramCallbackQuery,
  type TelegramInlineButton,
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
  | 'not-found'
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

/** 一张待确认的卡：类型决定按钮文案，标题让用户认出是哪一张 */
export interface ContactCardRef {
  id: string;
  kind: SecretaryCardKind;
  title?: string;
  /** 卡片属于哪个秘书会话：深链与「在应用里打开」都回到这里 */
  conversationId?: string;
}

export interface ContactCardWaitingInput {
  count: number;
  /** 审批：永远不能在手机上确认，只给一条回应用的入口 */
  approval?: boolean;
  conversationId?: string;
}

export interface ContactRelayAskInput {
  conversationId: string;
  question: string;
  options?: readonly string[];
  /** 会话的一句话标签 */
  label: string;
}

/** 手机关注里的定时到点了：推一次就结束关注 */
export interface ContactScheduleFiredInput {
  scheduleId: string;
  /** 定时自己的名字与内容，推文里补一句 */
  text: string;
}

/** 回传宿主转发给手机的那几件事；TelegramContactService 就是它的实现 */
export interface SecretaryContactPort {
  onMilestone(input: ContactMilestoneInput): void;
  /** 手机关注里的定时触发：与里程碑同一个出口，推一次就结束关注 */
  onScheduleFired(input: ContactScheduleFiredInput): void;
  onRelayAsk(input: ContactRelayAskInput): void;
  onAskRequest(conversationId: string, ask: AskRequestInfo): void;
  onAskResolved(conversationId: string, requestId: string): void;
  /** 审批在应用里收尾：那条提示的按钮跟着失效 */
  onApprovalResolved(conversationId: string): void;
  /** 回合开始：这一轮的回复会发到手机时点亮「正在输入…」 */
  onTurnStart(conversationId: string): void;
  /** 回合收尾（完成 / 出错 / 被停）：立刻停掉续发 */
  onTurnEnd(conversationId: string): void;
  onTurnReply(conversationId: string, text: string): void;
  /** 静默回合：/sync 打开时只发一行摘要，正文不发 */
  onTurnSilent(conversationId: string, updates: number): void;
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
  /** 秘书昵称：/last 的回复用它开头 */
  secretaryName(): string;
  /** 手机发来的话投给哪个秘书会话；没有可用会话时返回 null */
  secretaryConversationId(): string | null;
  /** /last：秘书会话最近的消息，Main 读 jsonl 后交回来；缺省表示读不到 */
  recentTurns?(rounds: number): Promise<readonly RecapMessage[]>;
  deliver(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }>;
  answerAsk(
    conversationId: string,
    requestId: string,
    answer: string
  ): { ok: boolean; error?: string };
  /** 只有「允许从 Telegram 确认卡片」打开时才用；审批永远不走这里 */
  resolveProposal(
    proposalId: string,
    action: 'confirm' | 'reject'
  ): Promise<{ ok: boolean; error?: string }>;
  /** 手机上点「在应用里打开」：聚焦窗口并定位到这张卡（或这个会话） */
  openInApp(target: { conversationId?: string; proposalId?: string }): void;
  /** 出站失败只提示，不打断秘书 */
  onError?(code: ContactError, detail?: string): void;
  /** 只读命令：由 Main 查面板同一份数据，不进秘书会话 */
  commands?: ContactCommands;
  /** 手机关注的任务：派发与定时写、这里读与取消 */
  following?: FollowingPort;
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

/** 一条提示消息里最多几张卡：再多手机上也没法点 */
const MAX_CARD_BUTTONS = 4;

/** Telegram 的「正在输入…」只亮约 5 秒：4 秒续一次，留出网络抖动 */
const TYPING_REFRESH_MS = 4_000;

/** 推过一次就结束关注的里程碑：完成与失败；「需要你」这类还在等，继续跟 */
const FOLLOW_END_KINDS: ReadonlySet<SecretaryResultKind> = new Set(['goal-complete', 'failed']);

/** 已经发到手机上的确认卡：处理掉之后要把那条消息的按钮清掉 */
interface TrackedCard extends ContactCardRef {
  chatId: number;
  messageId: number | null;
  /** 这条消息发出去没有：清按钮要等它拿到 messageId */
  ready: Promise<void>;
  /** 「派发 修登录」：收尾时整条消息换成「✅ 已确认：…」 */
  label: string;
  /**
   * 手机上点的是哪个动作。界面同步可能先一步把这条消息收尾，
   * 收尾文案要按这个动作写，不能一律写成「已处理」。
   */
  pendingAction?: 'confirm' | 'reject';
  settled: boolean;
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
 * 只认绑定的那个 chat；确认卡按开关决定能不能在手机上确认，审批一律不在手机上处理。
 */
export class TelegramContactService implements SecretaryContactPort {
  private readonly poller: ContactPoller;
  private readonly apis = new Map<string, TelegramApi>();
  private readonly asks: PendingAsk[] = [];
  /** 卡片 id → 已经发出去的那条消息：按钮回调只带 id，重启后照样认得出是哪张卡 */
  private readonly cardsById = new Map<string, TrackedCard>();
  /** 提案 id → 已经提示过的那条消息：同一张卡只推一次，处理掉再清按钮 */
  private readonly cardMessages = new Map<string, TrackedCard>();
  /** 会话 id → 审批提示：审批在应用里收尾后清按钮 */
  private readonly approvalCards = new Map<string, TrackedCard[]>();
  private slot = 1;
  /** 从手机发来消息后，等这一轮的正文再回发手机 */
  private readonly awaitingReply = new Set<string>();
  /**
   * 手机上正在确认卡片：确认出来的会话也算手机发起的任务，
   * 这一小段时间里派生的东西同样记进关注列表。
   */
  private readonly phoneOrigin = new Set<string>();
  /**
   * 正在续发「正在输入…」的那一轮。同一时间只跑一个循环：
   * 万一多个回合叠在一起，也不会对同一个 chat 重复发。
   */
  private typing: { conversationId: string; timer: ReturnType<typeof setTimeout> } | null = null;
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
        allowCardConfirm: file.allowCardConfirm,
        allowMemory: file.allowMemory,
        syncMirror: file.syncMirror,
        following: followingViews(this.followingList()),
        poll: this.poller.status(),
        secure: this.store.isSecure(),
      },
    };
  }

  /**
   * 手机发起的回合：等待回复的那一轮，或正在手机上确认卡片的那一会儿。
   * 返回发起它的 chat，派发与定时据此决定要不要记进关注列表。
   */
  phoneTurnChat(conversationId: string): number | null {
    const chat = this.store.file().chat;
    if (!chat) return null;
    if (this.awaitingReply.has(conversationId) || this.phoneOrigin.has(conversationId)) {
      return chat.id;
    }
    return null;
  }

  private followingList(): FollowedTask[] {
    return this.ports.following?.list() ?? [];
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
    this.stopTyping();
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
    const chatId = this.store.file().chat?.id;
    await this.poller.stop();
    this.store.saveUnbound();
    await this.clearCommands(chatId);
    this.asks.length = 0;
    this.cardsById.clear();
    this.cardMessages.clear();
    this.approvalCards.clear();
    this.awaitingReply.clear();
    this.phoneOrigin.clear();
    this.clearFollowing('contact_unbind');
    this.stopTyping();
    this.audit('contact_unbind', true);
    this.ports.publish();
    return { ok: true };
  }

  /** 更换 bot：token、bot 身份、chat 一起清，向导回到第 1 步 */
  async forgetBot(): Promise<ContactResult> {
    const chatId = this.store.file().chat?.id;
    await this.poller.stop();
    // token 还在时才能调 API：先清菜单，再忘掉 bot
    await this.clearCommands(chatId);
    await this.store.saveForgotten();
    this.asks.length = 0;
    this.cardsById.clear();
    this.cardMessages.clear();
    this.approvalCards.clear();
    this.awaitingReply.clear();
    this.phoneOrigin.clear();
    this.clearFollowing('contact_forget_bot');
    this.stopTyping();
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

  setAllowCardConfirm(value: boolean): void {
    this.store.save({ ...this.store.file(), allowCardConfirm: value === true });
    this.audit('contact_settings', true, `allowCardConfirm=${value === true}`);
    this.ports.publish();
  }

  /** 记忆标题的开关：关掉时命令菜单里也不出现 /memory */
  setAllowMemory(value: boolean): void {
    this.store.save({ ...this.store.file(), allowMemory: value === true });
    this.audit('contact_settings', true, `allowMemory=${value === true}`);
    this.syncCommands();
    this.ports.publish();
  }

  /** 设置页里的「取消关注」：按关注项 id 移除，推文不再跟这条任务 */
  unfollow(id: string): ContactResult {
    const removed = this.ports.following?.remove(id) ?? false;
    this.audit('contact_follow_cancel', removed, removed ? id : 'not-found');
    if (!removed) return { ok: false, error: 'not-found' };
    this.ports.publish();
    return { ok: true };
  }

  /** 设置页里的「全部清空」 */
  clearFollowed(): ContactResult {
    const count = this.ports.following?.clear() ?? 0;
    this.audit('contact_follow_clear', true, `cleared ${count} (settings)`);
    this.ports.publish();
    return { ok: true };
  }

  /**
   * 秘书对 J 哥说的里程碑：与系统通知同一批结果，按 notify 决定发不发。
   * 手机发起的任务带上原始需求摘要；完成或失败推过一次就结束关注。
   */
  onMilestone(input: ContactMilestoneInput): void {
    const mode = this.ports.notifyMode();
    if (!mode || !shouldForwardMilestone(mode, input.kind)) return;
    const file = this.store.file();
    if (!file.chat) return;
    const follow = this.ports.following?.find('session', input.conversationId);
    const link = conversationDeepLink(input.conversationId);
    // Telegram 只认 http(s)/tg 的 url 按钮；enso:// 只能当等宽文本发出去让人复制
    const asButton = telegramUrlButtonSupported(link);
    const text = formatMilestoneMessage(this.ports.lang(), {
      kind: input.kind,
      title: input.title,
      ...(input.lastText ? { lastText: input.lastText } : {}),
      ...(follow ? { summary: follow.summary } : {}),
      ...(asButton ? {} : { link }),
    });
    const replyMarkup = asButton
      ? {
          inline_keyboard: [[{ text: cardOpenButtonText(this.ports.lang()), url: link }]],
        }
      : undefined;
    void this.send(file.chat.id, text, replyMarkup ? { replyMarkup } : {}).then((sent) => {
      this.audit(
        follow ? 'contact_follow_push' : 'contact_milestone',
        sent.ok,
        sent.ok ? input.kind : sent.error
      );
      if (!sent.ok || !follow) return;
      // 推出去才算结束：发失败的关注留着，下一次结果还能再推
      if (!FOLLOW_END_KINDS.has(input.kind)) return;
      this.ports.following?.take('session', input.conversationId);
      this.audit('contact_follow_done', true, `${input.kind} ${follow.summary}`);
    });
  }

  /** 手机关注里的定时到点了：只推这一次，推完就结束关注 */
  onScheduleFired(input: ContactScheduleFiredInput): void {
    const file = this.store.file();
    const follow = this.ports.following?.find('schedule', input.scheduleId);
    if (!file.chat || !follow) return;
    const text = formatFollowedScheduleMessage(this.ports.lang(), {
      summary: follow.summary,
      text: input.text,
    });
    void this.send(file.chat.id, text).then((sent) => {
      this.audit('contact_follow_push', sent.ok, sent.ok ? 'schedule' : sent.error);
      if (!sent.ok) return;
      this.ports.following?.take('schedule', input.scheduleId);
      this.audit('contact_follow_done', true, `schedule ${follow.summary}`);
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
    void this.send(file.chat.id, text, { replyMarkup }).then((sent) => {
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

  /**
   * 回合开始：这一轮的回复会发到手机（手机发起，或 /sync 打开）就点亮「正在输入…」。
   * 判定与 onTurnReply 一致；已有循环在跑时不重复起。
   */
  onTurnStart(conversationId: string): void {
    if (this.typing) return;
    const file = this.store.file();
    if (!file.chat) return;
    if (!this.awaitingReply.has(conversationId) && !file.syncMirror) return;
    const timer = setTimeout(() => this.refreshTyping(), TYPING_REFRESH_MS);
    this.typing = { conversationId, timer };
    void this.sendTyping();
  }

  /** 回合收尾：完成、出错、被停都走这里，回复发出后不再续发 */
  onTurnEnd(conversationId: string): void {
    if (this.typing?.conversationId !== conversationId) return;
    this.stopTyping();
  }

  /**
   * 秘书这一轮的正文。用户刚从手机发来的那一轮本来就回发，只发一次；
   * 其余回合只有 /sync 打开时才镜像，关闭时只发里程碑。
   */
  onTurnReply(conversationId: string, text: string): void {
    this.onTurnEnd(conversationId);
    const fromPhone = this.awaitingReply.delete(conversationId);
    const file = this.store.file();
    const body = text.trim();
    if (!file.chat || !body) return;
    if (!fromPhone && !file.syncMirror) return;
    void this.send(file.chat.id, body).then((sent) => {
      this.audit(
        fromPhone ? 'contact_reply' : 'contact_mirror',
        sent.ok,
        sent.ok ? undefined : sent.error
      );
    });
  }

  /** 静默回合：正文是空的，/sync 打开时补一行摘要，让手机知道秘书看过 */
  onTurnSilent(conversationId: string, updates: number): void {
    // 静默就是不打扰：先收掉「正在输入…」，摘要发完也不再续
    this.onTurnEnd(conversationId);
    // 手机发起的回合一定会回话，静默只可能来自系统回传
    if (this.awaitingReply.delete(conversationId)) return;
    const file = this.store.file();
    if (!file.chat || !file.syncMirror) return;
    void this.send(file.chat.id, formatSilentTurnLine(this.ports.lang(), updates)).then((sent) => {
      this.audit('contact_mirror', sent.ok, sent.ok ? 'silent' : sent.error);
    });
  }

  /**
   * 审批：永远不能在手机上确认，只给一条回应用的入口。
   * 确认卡走 syncPendingCards，与界面状态同步。
   */
  onCardWaiting(input: ContactCardWaitingInput): void {
    const file = this.store.file();
    if (!file.chat || input.count <= 0) return;
    const lang = this.ports.lang();
    const link = input.conversationId ? conversationDeepLink(input.conversationId) : undefined;
    const asButton = link !== undefined && telegramUrlButtonSupported(link);
    const text = formatCardWaitingMessage(lang, {
      count: input.count,
      ...(input.approval ? { approval: true } : {}),
      // 做成 url 按钮的深链不再在正文里重复一遍
      ...(link && !asButton ? { link } : {}),
    });
    const slot = this.slot++;
    const entry: TrackedCard = {
      id: `approval:${slot}`,
      kind: 'dispatch',
      chatId: file.chat.id,
      messageId: null,
      ready: Promise.resolve(),
      label: lang === 'zh' ? '审批' : 'approval',
      settled: false,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    };
    this.cardsById.set(entry.id, entry);
    if (input.conversationId) {
      const list = this.approvalCards.get(input.conversationId) ?? [];
      list.push(entry);
      this.approvalCards.set(input.conversationId, list);
    }
    // 审批永远只有一个回应用的入口：手机上不给确认按钮
    const replyMarkup = { inline_keyboard: [[this.openButton(lang, entry, link)]] };
    entry.ready = this.send(file.chat.id, text, { replyMarkup }).then((sent) => {
      this.audit('contact_card_waiting', sent.ok, sent.ok ? 'approval' : sent.error);
      if (sent.ok) entry.messageId = sent.messageId ?? null;
    });
  }

  /** 审批在应用里答完了：那条提示的按钮一起清掉 */
  onApprovalResolved(conversationId: string): void {
    const list = this.approvalCards.get(conversationId);
    if (!list) return;
    this.approvalCards.delete(conversationId);
    for (const entry of list) void this.settleCard(entry);
  }

  /**
   * 待确认的卡与界面状态同步：新卡发一条带按钮的提示，处理掉的卡把按钮清掉。
   * 开关关着时按钮照样在，但点了只提醒回应用处理。
   */
  syncPendingCards(cards: readonly ContactCardRef[]): void {
    const file = this.store.file();
    if (!file.chat) return;
    const pending = new Set(cards.map((card) => card.id));
    for (const tracked of this.cardMessages.values()) {
      if (!pending.has(tracked.id)) void this.settleCard(tracked);
    }
    const fresh = cards.filter((card) => !this.cardMessages.has(card.id));
    if (fresh.length === 0) return;
    this.announceCards(file.chat.id, fresh, cards.length);
  }

  /**
   * 「在应用里打开」：http(s)/tg 深链做成 url 按钮（Telegram 自己打开），
   * enso:// 这类自定义 scheme 只能走回调，由 Main 聚焦窗口并定位到这张卡。
   */
  private openButton(lang: ContactLang, card: TrackedCard, link?: string): TelegramInlineButton {
    return link && telegramUrlButtonSupported(link)
      ? { text: cardOpenButtonText(lang), url: link }
      : { text: cardOpenButtonText(lang), callback_data: cardCallbackData(card.id, 'open') };
  }

  /** 一条提示里每张卡一个「确认<类型>：<标题>」按钮，再加一个回应用的入口 */
  private announceCards(chatId: number, cards: readonly ContactCardRef[], total: number): void {
    const lang = this.ports.lang();
    const confirmable = this.store.file().allowCardConfirm;
    const shown = cards.slice(0, MAX_CARD_BUTTONS);
    const first = shown[0];
    const link = first?.conversationId
      ? proposalDeepLink(first.conversationId, first.id)
      : undefined;
    const asButton = link !== undefined && telegramUrlButtonSupported(link);
    const text = formatCardWaitingMessage(lang, {
      count: total,
      ...(first?.title ? { title: first.title } : {}),
      ...(confirmable ? { confirmable: true } : {}),
      // 做成 url 按钮的深链不再在正文里重复一遍
      ...(link && !asButton ? { link } : {}),
    });
    const tracked: TrackedCard[] = [];
    const rows: TelegramInlineButton[][] = [];
    for (const card of shown) {
      const entry: TrackedCard = {
        ...card,
        chatId,
        messageId: null,
        ready: Promise.resolve(),
        label: cardLabel(lang, card.kind, card.title),
        settled: false,
      };
      tracked.push(entry);
      this.cardsById.set(card.id, entry);
      this.cardMessages.set(card.id, entry);
      rows.push([
        {
          text: cardConfirmButtonText(lang, card.kind, card.title),
          callback_data: cardCallbackData(card.id, 'confirm'),
        },
      ]);
    }
    // 确认前想先看全文：一张卡时并排，多张卡时单独一行
    if (tracked[0]) {
      const open = this.openButton(lang, tracked[0], link);
      if (shown.length === 1) rows[0]?.push(open);
      else rows.push([open]);
    }
    const sending = this.send(chatId, text, {
      replyMarkup: { inline_keyboard: rows },
    }).then((sent) => {
      this.audit(
        'contact_card_waiting',
        sent.ok,
        sent.ok
          ? `${shown.map((card) => cardKindLabel(lang, card.kind)).join(',')}${confirmable ? '' : ' readonly'}`
          : sent.error
      );
      if (!sent.ok) return;
      for (const entry of tracked) entry.messageId = sent.messageId ?? null;
    });
    for (const entry of tracked) entry.ready = sending;
  }

  /**
   * 卡片被处理掉（哪边处理都一样）：整条消息换成「✅ 已确认：…」并清掉按钮。
   * 不再往原文后面拼半截后缀——那正是手机上看到的「· 已处理」残渣。
   */
  private async settleCard(
    tracked: TrackedCard,
    action: 'confirm' | 'reject' | 'handled' = tracked.pendingAction ?? 'handled'
  ): Promise<void> {
    if (tracked.settled) return;
    await tracked.ready;
    const token = this.store.token();
    if (!token || tracked.messageId === null) {
      // 消息本来就没发出去：没有按钮可清，不用再试
      tracked.settled = true;
      return;
    }
    const lang = this.ports.lang();
    const api = this.apiFor(token);
    const replyMarkup = { inline_keyboard: [] };
    try {
      await api.editMessageText({
        chatId: tracked.chatId,
        messageId: tracked.messageId,
        // 整条替换：标题里可能有 markdown 字符，这里只转义不解析
        text: escapeHtml(cardSettledText(lang, action, tracked.label)),
        replyMarkup,
        parseMode: 'HTML',
      });
      tracked.settled = true;
      this.audit('contact_card_settled', true, cardKindLabel(lang, tracked.kind));
    } catch (error) {
      this.audit('contact_card_settled', false, errorCode(error));
      this.reportError(error);
      // 正文改不动至少把按钮清掉：手机上不能再点第二次
      try {
        await api.editMessageReplyMarkup({
          chatId: tracked.chatId,
          messageId: tracked.messageId,
          replyMarkup,
        });
        tracked.settled = true;
        this.audit('contact_card_settled', true, 'markup-only');
      } catch {
        // 下一次状态同步还会再试
      }
    }
  }

  /** 只读命令：查面板数据、格式化、回一条；审计只记命令名 */
  private async runCommand(name: ContactReadCommandName, arg: string): Promise<void> {
    const chatId = this.store.file().chat?.id;
    const commands = this.ports.commands;
    if (!chatId || !commands) return;
    const reply = await commands.run(name, arg);
    const sent = await this.send(chatId, reply.text, {
      ...(this.feedKeyboard(reply.next) ? { replyMarkup: this.feedKeyboard(reply.next) } : {}),
      format: 'html',
    });
    this.audit('contact_command', sent.ok, name);
  }

  /**
   * /last：把秘书会话最近几轮读出来发过去。只读，不进会话、不唤醒模型，
   * 也不记成用户消息；正文交给现有出站路径切条与转义。
   */
  private async runLast(arg: string): Promise<void> {
    const chatId = this.store.file().chat?.id;
    if (!chatId) return;
    const lang = this.ports.lang();
    const rounds = parseRecapRounds(arg);
    if (rounds === null) {
      const sent = await this.send(chatId, recapUsageText(lang));
      this.audit('contact_command', sent.ok, 'last');
      return;
    }
    const messages = (await this.ports.recentTurns?.(rounds)) ?? [];
    const turns = buildRecapTurns(messages, rounds);
    const text =
      turns.length === 0
        ? recapEmptyText(lang)
        : formatRecapMessage(lang, { turns, name: this.ports.secretaryName() });
    const sent = await this.send(chatId, text);
    this.audit('contact_command', sent.ok, sent.ok ? `last ${rounds}` : 'last');
  }

  /** /sync：不带参数查状态，on/off 开关；开关动作单独记一条审计 */
  private async runSync(arg: string): Promise<void> {
    const chatId = this.store.file().chat?.id;
    if (!chatId) return;
    const lang = this.ports.lang();
    const action = parseSyncArg(arg);
    if (action === null) {
      const sent = await this.send(chatId, syncUsageText(lang));
      this.audit('contact_command', sent.ok, 'sync');
      return;
    }
    const current = this.store.file().syncMirror;
    if (action !== 'status') {
      const on = action === 'on';
      this.store.save({ ...this.store.file(), syncMirror: on });
      // 关掉同步后这一轮不再镜像，也就没必要继续亮「正在输入…」
      if (!on) this.stopTyping();
      this.audit('contact_sync', true, on ? 'on' : 'off');
      this.ports.publish();
    }
    const on = action === 'status' ? current : action === 'on';
    const sent = await this.send(chatId, formatSyncMessage(lang, on));
    this.audit('contact_command', sent.ok, 'sync');
  }

  /** 写错的命令：给一份清单，不进秘书会话 */
  private async runUnknownCommand(): Promise<void> {
    const chatId = this.store.file().chat?.id;
    if (!chatId) return;
    const text = unknownCommandText(this.ports.lang(), this.store.file().allowMemory);
    const sent = await this.send(chatId, text, { format: 'html' });
    this.audit('contact_command', sent.ok, 'unknown');
  }

  /** 解绑与换 bot：关注列表一起清掉，没人收推送了 */
  private clearFollowing(reason: string): void {
    const count = this.ports.following?.clear() ?? 0;
    if (count > 0) this.audit('contact_follow_clear', true, `cleared ${count} (${reason})`);
  }

  /**
   * /following：列出手机关注的任务，可以逐个取消或全清。
   * 与 /sync 一样由服务自己处理：列表要带按钮，取消要落盘。
   */
  private async runFollowing(arg: string): Promise<void> {
    const chatId = this.store.file().chat?.id;
    if (!chatId) return;
    const lang = this.ports.lang();
    const following = this.ports.following;
    const parsed = parseFollowingArg(arg);
    if (!parsed || !following) {
      const sent = await this.send(chatId, followingUsageText(lang));
      this.audit('contact_command', sent.ok, 'following');
      return;
    }
    if (parsed.action === 'clear') {
      const count = following.clear();
      if (count > 0) this.audit('contact_follow_clear', true, `cleared ${count}`);
      const sent = await this.send(
        chatId,
        count > 0
          ? lang === 'zh'
            ? `已清空 ${count} 个关注的任务。`
            : `Cleared ${count} followed task${count === 1 ? '' : 's'}.`
          : followingEmptyText(lang)
      );
      this.audit('contact_command', sent.ok, 'following');
      return;
    }
    if (parsed.action === 'cancel') {
      const item = following.list()[parsed.index - 1];
      if (!item) {
        const sent = await this.send(chatId, followingUsageText(lang));
        this.audit('contact_command', sent.ok, 'following');
        return;
      }
      following.remove(item.id);
      this.audit(
        'contact_follow_cancel',
        true,
        `${followKindLabel(lang, item.kind)} ${item.summary}`
      );
    }
    await this.sendFollowingList(chatId);
  }

  /** 关注列表与按钮：序号与 /following cancel <序号> 一致 */
  private async sendFollowingList(chatId: number): Promise<void> {
    const lang = this.ports.lang();
    const items = this.followingList();
    const text = formatFollowingMessage(lang, {
      items: followingViews(items),
      now: this.ports.now(),
    });
    const keyboard = this.followingKeyboard(items);
    const sent = await this.send(chatId, text, {
      format: 'html',
      ...(keyboard ? { replyMarkup: keyboard } : {}),
    });
    this.audit('contact_command', sent.ok, 'following');
  }

  /** 每项一个「取消 N」按钮，最后一行是全清；没有关注项就不给按钮 */
  private followingKeyboard(
    items: readonly FollowedTask[]
  ): { inline_keyboard: { text: string; callback_data: string }[][] } | undefined {
    if (items.length === 0) return undefined;
    const lang = this.ports.lang();
    const rows = items.slice(0, MAX_CARD_BUTTONS).map((_item, index) => [
      {
        text: lang === 'zh' ? `取消 ${index + 1}` : `Drop ${index + 1}`,
        callback_data: followCallbackData('cancel', index + 1),
      },
    ]);
    rows.push([
      {
        text: lang === 'zh' ? '全清' : 'Drop all',
        callback_data: followCallbackData('clear'),
      },
    ]);
    return { inline_keyboard: rows };
  }

  /** 取消一项或全清：原地换掉这条消息，按钮跟着列表一起变 */
  private async handleFollowCallback(
    query: TelegramCallbackQuery,
    action: { action: 'cancel' | 'clear'; index?: number }
  ): Promise<void> {
    const lang = this.ports.lang();
    const following = this.ports.following;
    if (!following) {
      await this.answerCallback(query.id, followingEmptyText(lang));
      return;
    }
    if (action.action === 'clear') {
      const count = following.clear();
      if (count > 0) this.audit('contact_follow_clear', true, `cleared ${count}`);
      await this.answerCallback(
        query.id,
        lang === 'zh' ? `已清空 ${count} 个` : `Cleared ${count}`
      );
      await this.refreshFollowingMessage(query);
      return;
    }
    const item = following.list()[(action.index ?? 0) - 1];
    if (!item) {
      await this.answerCallback(query.id, lang === 'zh' ? '这条关注已经结束了' : 'Already gone');
      await this.refreshFollowingMessage(query);
      return;
    }
    following.remove(item.id);
    this.audit(
      'contact_follow_cancel',
      true,
      `${followKindLabel(lang, item.kind)} ${item.summary}`
    );
    await this.answerCallback(query.id, lang === 'zh' ? '已取消关注' : 'Dropped');
    await this.refreshFollowingMessage(query);
  }

  /** 原地重画关注列表；消息太旧改不动就再发一条新的 */
  private async refreshFollowingMessage(query: TelegramCallbackQuery): Promise<void> {
    const chatId = this.store.file().chat?.id;
    const messageId = query.message?.message_id;
    const token = this.store.token();
    if (!chatId || messageId === undefined || !token) return;
    const lang = this.ports.lang();
    const items = this.followingList();
    try {
      await this.apiFor(token).editMessageText({
        chatId,
        messageId,
        text: formatFollowingMessage(lang, { items: followingViews(items), now: this.ports.now() }),
        replyMarkup: this.followingKeyboard(items) ?? { inline_keyboard: [] },
        parseMode: 'HTML',
      });
    } catch (error) {
      this.audit('contact_command', false, 'following');
      this.reportError(error);
    }
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

  /**
   * 命令菜单：绑定的 chat 单独注册一份（打 / 立刻能看到），默认 scope 再放中文与兜底两份，
   * 并把左下角菜单按钮设成 commands。失败只记审计，不影响收发消息。
   */
  private syncCommands(): void {
    const token = this.store.token();
    const chatId = this.store.file().chat?.id;
    if (!token || !chatId) return;
    const commands = this.menuCommands();
    const api = this.apiFor(token);
    void this.runMenuCalls([
      {
        detail: 'set:chat',
        run: () => api.setMyCommands(commands, { scope: { type: 'chat', chat_id: chatId } }),
      },
      { detail: 'set:zh', run: () => api.setMyCommands(commands, { languageCode: 'zh' }) },
      { detail: 'set:default', run: () => api.setMyCommands(commands) },
      { detail: 'menu:commands', run: () => api.setChatMenuButton({ type: 'commands' }) },
    ]);
  }

  /** 解绑或换 bot：把菜单清掉，别让旧命令留在手机上 */
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
        this.ports.onError?.(errorCode(error), error instanceof Error ? error.message : undefined);
      }
    }
  }

  /** 记忆默认不出现；关着时菜单里也没有 /memory */
  private menuCommands(): { command: string; description: string }[] {
    const allowMemory = this.store.file().allowMemory;
    return botCommands().filter((entry) => entry.command !== 'memory' || allowMemory);
  }

  /** 续发一次，再排下一次；循环只由 stopTyping 结束 */
  private refreshTyping(): void {
    const typing = this.typing;
    if (!typing) return;
    void this.sendTyping();
    typing.timer = setTimeout(() => this.refreshTyping(), TYPING_REFRESH_MS);
  }

  /**
   * 发一次 sendChatAction。只是提示：失败只记审计、不抛错也不重试，
   * 顺手停掉循环，免得每一轮都撞同一堵墙。
   */
  private async sendTyping(): Promise<void> {
    const token = this.store.token();
    const chat = this.store.file().chat;
    // 解绑后立刻停：没有 chat 就不再发
    if (!token || !chat) {
      this.stopTyping();
      return;
    }
    try {
      await this.apiFor(token).sendChatAction({ chatId: chat.id, action: 'typing' });
    } catch (error) {
      this.audit('contact_typing', false, errorCode(error));
      this.stopTyping();
    }
  }

  private stopTyping(): void {
    const typing = this.typing;
    if (!typing) return;
    this.typing = null;
    clearTimeout(typing.timer);
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

  /**
   * 出站统一入口：markdown 转 Telegram HTML、超长切条、解析失败降级纯文本。
   * 键盘只挂在最后一条上，翻页/选项不会散在几条消息里。
   */
  private async send(
    chatId: number,
    text: string,
    options?: {
      replyMarkup?: { inline_keyboard: TelegramInlineButton[][] };
      format?: 'markdown' | 'html';
    }
  ): Promise<{ ok: true; messageId?: number } | { ok: false; error: ContactError }> {
    const token = this.store.token();
    if (!token) return { ok: false, error: 'token-required' };
    const chunks =
      options?.format === 'html'
        ? packTelegramHtml(text).map((html) => ({ html, plain: htmlToPlain(html) }))
        : markdownToTelegramChunks(text);
    // 最后一条的 messageId：确认卡留着它，处理掉之后回来清按钮
    let messageId: number | undefined;
    for (const [index, chunk] of chunks.entries()) {
      const keyboard = index === chunks.length - 1 ? options?.replyMarkup : undefined;
      const sent = await this.sendChunk(chatId, token, chunk, keyboard);
      if (!sent.ok) return sent;
      messageId = sent.messageId;
    }
    this.audit('contact_outbound', true, describe(text));
    return { ok: true, ...(messageId === undefined ? {} : { messageId }) };
  }

  /** 单条：HTML 发不出去（Telegram 报解析错误）就原样纯文本再发一次 */
  private async sendChunk(
    chatId: number,
    token: string,
    chunk: { html: string; plain: string },
    replyMarkup?: { inline_keyboard: TelegramInlineButton[][] }
  ): Promise<{ ok: true; messageId: number } | { ok: false; error: ContactError }> {
    const api = this.apiFor(token);
    try {
      const messageId = await api.sendMessage({
        chatId,
        text: chunk.html,
        parseMode: 'HTML',
        ...(replyMarkup ? { replyMarkup } : {}),
      });
      return { ok: true, messageId };
    } catch (error) {
      if (!(error instanceof TelegramApiError) || error.kind !== 'api') {
        return this.failSend(error);
      }
      this.audit('contact_format', false, 'html-rejected');
      try {
        const messageId = await api.sendMessage({
          chatId,
          text: chunk.plain,
          ...(replyMarkup ? { replyMarkup } : {}),
        });
        this.audit('contact_format', true, 'plain-fallback');
        return { ok: true, messageId };
      } catch (retryError) {
        return this.failSend(retryError);
      }
    }
  }

  private failSend(error: unknown): { ok: false; error: ContactError } {
    const code = errorCode(error);
    this.audit('contact_outbound', false, code);
    this.ports.onError?.(code);
    return { ok: false, error: code };
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
      if (command.name === 'last') {
        await this.runLast(command.arg);
        return;
      }
      if (command.name === 'sync') {
        await this.runSync(command.arg);
        return;
      }
      if (command.name === 'following') {
        await this.runFollowing(command.arg);
        return;
      }
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
    // 入站只在这里包一次：所有渠道都走 wrapInboundMessage
    const body = wrapInboundMessage('telegram', this.ports.lang(), {
      ...(message.from?.username ? { username: message.from.username } : {}),
      ...(message.date ? { at: message.date * 1000 } : {}),
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
    const follow = query.data ? parseFollowCallback(query.data) : null;
    if (follow) {
      await this.handleFollowCallback(query, follow);
      return;
    }
    const card = query.data ? parseCardCallbackData(query.data) : null;
    if (card) {
      await this.handleCardCallback(query, card.id, card.action);
      return;
    }
    // 老版本的卡片按钮（card:<槽位>:c）已经失效：别落到提问分支上答错话
    if (query.data?.startsWith('card:')) {
      await this.answerCallback(
        query.id,
        this.ports.lang() === 'zh' ? '这张卡已经处理过了' : 'That card is gone'
      );
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

  /**
   * 确认卡的按钮：确认直接执行，打开只回到应用。
   * 开关关着时按钮还在，但点了只提醒回应用处理；审批根本没有确认按钮。
   * 卡片已经处理过（哪边处理的都算）就只提示，并把这条消息的按钮清掉。
   */
  private async handleCardCallback(
    query: TelegramCallbackQuery,
    id: string,
    action: 'confirm' | 'reject' | 'open'
  ): Promise<void> {
    const lang = this.ports.lang();
    // 重启后内存里没有这条记录：确认照样交给 Main 校验，只是改不动那条消息
    const card = this.cardsById.get(id);
    if (action === 'open') {
      this.ports.openInApp({
        ...(card?.conversationId ? { conversationId: card.conversationId } : {}),
        ...(card?.settled ? {} : { proposalId: id }),
      });
      this.audit('contact_card_open', true, card ? cardKindLabel(lang, card.kind) : 'unknown');
      await this.answerCallback(query.id, cardCallbackToast(lang, 'open'));
      return;
    }
    if (card?.settled) {
      await this.answerCallback(
        query.id,
        lang === 'zh' ? '这张卡已经处理过了' : 'That card is gone'
      );
      return;
    }
    if (!this.store.file().allowCardConfirm) {
      // 开关关着：按钮还在，但点了只提醒回应用处理，绝不执行
      const op = action === 'confirm' ? 'contact_card_confirm' : 'contact_card_reject';
      this.audit(op, false, 'disabled');
      await this.answerCallback(
        query.id,
        lang === 'zh'
          ? '已在设置里关闭手机确认，请回应用处理'
          : 'Phone confirm is off in settings; handle it in the app'
      );
      await this.replyOpenOnly(lang, id, card);
      return;
    }
    // 手机上确认出来的会话也算手机发起的任务：确认期间派生的东西记进关注列表
    if (card?.conversationId) this.phoneOrigin.add(card.conversationId);
    // 先记下点的是哪个动作：界面同步可能抢在收尾之前把这条消息改掉
    if (card) card.pendingAction = action;
    let result: { ok: boolean; error?: string };
    try {
      result = await this.ports.resolveProposal(id, action);
    } finally {
      if (card?.conversationId) this.phoneOrigin.delete(card.conversationId);
    }
    this.audit(
      action === 'confirm' ? 'contact_card_confirm' : 'contact_card_reject',
      result.ok,
      result.ok
        ? card
          ? `${cardKindLabel(lang, card.kind)} ${id}`
          : id
        : (result.error ?? 'failed')
    );
    if (result.ok) {
      await this.answerCallback(
        query.id,
        cardCallbackToast(
          lang,
          action,
          card ? { kind: card.kind, ...(card.title ? { title: card.title } : {}) } : undefined
        )
      );
      // 回一条结果，再把原消息整条换成「✅ 已确认：…」并清掉按钮
      await this.replySettled(lang, action, card?.label ?? this.fallbackLabel(lang));
    } else {
      await this.answerCallback(
        query.id,
        lang === 'zh' ? '这张卡已经处理过了' : 'That card is gone'
      );
    }
    if (card) await this.settleCard(card, action);
  }

  /** 重启后内存里没有卡片记录：收尾文案只能给一句泛的 */
  private fallbackLabel(lang: ContactLang): string {
    return lang === 'zh' ? '这张卡' : 'the card';
  }

  /** 确认/拒绝成功后的回执：手机上再发一条结果，不用回原消息确认 */
  private async replySettled(
    lang: ContactLang,
    action: 'confirm' | 'reject',
    label: string
  ): Promise<void> {
    const chatId = this.store.file().chat?.id;
    if (!chatId) return;
    const sent = await this.send(chatId, cardSettledText(lang, action, label));
    this.audit('contact_card_result', sent.ok, sent.ok ? action : sent.error);
  }

  /** 开关关着时点「确认」：只回一条说明，附「在应用里打开」，不执行任何动作 */
  private async replyOpenOnly(
    lang: ContactLang,
    id: string,
    card: TrackedCard | undefined
  ): Promise<void> {
    const chatId = this.store.file().chat?.id;
    if (!chatId) return;
    const link = card?.conversationId ? proposalDeepLink(card.conversationId, id) : undefined;
    const text =
      lang === 'zh'
        ? '已在设置里关闭手机确认，请回应用处理。'
        : 'Phone confirm is off in settings; handle it in the app.';
    const open =
      link && telegramUrlButtonSupported(link)
        ? { text: cardOpenButtonText(lang), url: link }
        : { text: cardOpenButtonText(lang), callback_data: cardCallbackData(id, 'open') };
    const sent = await this.send(chatId, text, {
      replyMarkup: { inline_keyboard: [[open]] },
    });
    this.audit('contact_card_readonly', sent.ok, sent.ok ? 'disabled' : sent.error);
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
    await this.send(chat.id, `${welcome}\n\n${commands}`, { format: 'html' });
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
