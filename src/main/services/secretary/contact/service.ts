import { createHash } from 'node:crypto';
import {
  botCommands,
  type ContactReadCommandName,
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
  type AskSettledOutcome,
  askCallbackData,
  askCallbackToast,
  askSettledLine,
  type ContactLang,
  cardCallbackData,
  cardCallbackToast,
  cardConfirmButtonText,
  cardKindLabel,
  cardLabel,
  cardOpenButtonText,
  cardSettledText,
  conversationDeepLink,
  deepLinkLine,
  feedCallbackData,
  followCallbackData,
  formatAskMessage,
  formatCardWaitingMessage,
  formatFollowedScheduleMessage,
  formatMilestoneMessage,
  formatNeedsAppConfirmLine,
  formatSilentTurnLine,
  parseAskCallbackData,
  parseCardCallbackData,
  parseFeedCallback,
  parseFollowCallback,
  proposalDeepLink,
  type SecretaryCardKind,
  shouldForwardMilestone,
  telegramUrlButtonSupported,
} from '@shared/secretary/contact';
import type { FeedCursor } from '@shared/secretary/feed';
import { TELEGRAM_INBOUND, wrapInboundMessage } from '@shared/secretary/inbound';
import {
  buildRecapTurns,
  formatRecapMessage,
  parseRecapRounds,
  type RecapMessage,
  recapEmptyText,
  recapUsageText,
} from '@shared/secretary/recap';
import { htmlToPlain } from '@shared/secretary/telegramHtml';
import type { AskAnswerBy, AskRequestInfo } from '@shared/types/agent';
import type {
  SecretaryAuditEntry,
  SecretaryContactChannelPrefs,
  SecretaryContactChannelStatus,
  SecretaryContactChannelView,
  SecretaryContactState,
  SecretaryProfile,
  SecretaryResultKind,
} from '@shared/types/secretary';
import { type FollowedTask, type FollowingPort, followingViews } from '../following';
import {
  type ChannelButton,
  type ChannelCaps,
  type ChannelEntry,
  type ChannelInbound,
  type ChannelMessage,
  type ChannelMeta,
  type ChannelSend,
  type ContactChannel,
  ContactChannelRegistry,
  type Peer,
  peerKey,
  plainButtonsText,
  samePeer,
  splitPlain,
} from './channel';
import type { TelegramApi } from './client';
import type { ContactCommands } from './commands';
import { type ContactStore, channelPrefs, TELEGRAM_CHANNEL_ID, withChannelPrefs } from './store';
import { TELEGRAM_CAPS, TelegramChannel } from './telegram';

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

/** 提问在应用侧怎么收的尾：谁答的、答了什么；缺省 by 表示取消/作废 */
export interface AskResolvedInfo {
  by?: AskAnswerBy;
  answer?: string;
}

/** 回传宿主转发给手机的那几件事；ContactService 就是它的实现 */
export interface SecretaryContactPort {
  onMilestone(input: ContactMilestoneInput): void;
  /** 手机关注里的定时触发：与里程碑同一个出口，推一次就结束关注 */
  onScheduleFired(input: ContactScheduleFiredInput): void;
  onRelayAsk(input: ContactRelayAskInput): void;
  onAskRequest(conversationId: string, ask: AskRequestInfo): void;
  /** 提问收尾（应用里答了、超时、作废）：手机那条消息跟着标成已回答或已过期 */
  onAskResolved(conversationId: string, requestId: string, resolution?: AskResolvedInfo): void;
  /** 审批在应用里收尾：那条提示的按钮跟着失效 */
  onApprovalResolved(conversationId: string): void;
  /** 回合开始：这一轮的回复会发到手机时点亮「正在输入…」 */
  onTurnStart(conversationId: string): void;
  /** 回合收尾（完成 / 出错 / 被停）：立刻停掉续发 */
  onTurnEnd(conversationId: string): void;
  /**
   * 秘书这一轮的正文。delivery 表示这一轮是系统回传注入的（派出会话的结果），
   * 不是用户亲手发的；turnId 用来保证同一轮只回推一次。
   */
  onTurnReply(
    conversationId: string,
    text: string,
    options?: { delivery?: boolean; turnId?: string }
  ): void;
  /** 手机关注中的任务：结果一定要回推，不受 notify 降噪影响 */
  follows?(conversationId: string): boolean;
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
  /** 只有渠道打开「手机确认卡」时才用；审批永远不走这里 */
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
  /** 测试注入假 Telegram API；生产按 token 现建 */
  api?(token: string): TelegramApi;
}

/** 插件渠道上报的状态 */
export interface ChannelStatusInput {
  status: SecretaryContactChannelStatus;
  detail?: string;
  /** 主动推送发给谁：插件只上报扫码/绑定的那个人 */
  peers?: readonly string[];
}

/** 审计里只留长度与 hash：正文、用户名、token 都不落盘 */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function describe(text: string): string {
  return `len=${text.length} hash=${digest(text)}`;
}

/** 一条发出去的消息：收尾时按渠道能力改掉或留着 */
interface Delivery {
  peer: Peer;
  messageId: string | null;
  /** 这条消息发出去没有：改消息要等它拿到 messageId */
  ready: Promise<void>;
  done?: boolean;
}

interface PendingAsk {
  slot: number;
  conversationId: string;
  requestId: string;
  options: string[];
  at: number;
  /** 原问题正文：收尾只往后追加一行，问题留着回看 */
  text: string;
  sends: Delivery[];
  settled: boolean;
}

/** 已经发到手机上的确认卡（或审批提示）：处理掉之后各渠道一起收尾 */
interface TrackedCard extends ContactCardRef {
  sends: Delivery[];
  /** 「派发 修登录」：收尾时整条消息换成「✅ 已确认：…」 */
  label: string;
  /**
   * 手机上点的是哪个动作。界面同步可能先一步把这条消息收尾，
   * 收尾文案要按这个动作写，不能一律写成「已处理」。
   */
  pendingAction?: 'confirm' | 'reject';
  settled: boolean;
}

type PostKind = 'sendText' | 'ask' | 'confirmCards' | 'approvalNotice';

const MAX_PENDING_ASKS = 8;

/** 一条提示消息里最多几张卡：再多手机上也没法点 */
const MAX_CARD_BUTTONS = 4;

/** 「正在输入…」大多只亮约 5 秒：4 秒续一次，留出网络抖动 */
const TYPING_REFRESH_MS = 4_000;

/** 推过一次就结束关注的里程碑：完成与失败；「需要你」这类还在等，继续跟 */
const FOLLOW_END_KINDS: ReadonlySet<SecretaryResultKind> = new Set(['goal-complete', 'failed']);

/** 没按钮的渠道确认卡片：回「确认 2」 */
const PLAIN_CARD_CONFIRM = /^(?:确认|confirm)\s*(\d{1,2})$/iu;

/** 应用侧收尾的来路：超时/作废算过期，真人答过算「已在应用里回答」 */
function askOutcomeFromResolution(resolution?: AskResolvedInfo): AskSettledOutcome {
  if (resolution?.by === 'timeout' || resolution?.by === undefined) return { kind: 'expired' };
  if (resolution.by === 'user') return { kind: 'app' };
  return resolution.answer ? { kind: 'answered', answer: resolution.answer } : { kind: 'app' };
}

function uniquePeers(peers: Iterable<Peer>): Peer[] {
  const seen = new Map<string, Peer>();
  for (const peer of peers) seen.set(peerKey(peer), peer);
  return [...seen.values()];
}

/**
 * 联系方式核心：秘书语义（里程碑、提问、确认卡、审批、关注、只读命令）在这里，
 * 渠道只负责收发。Telegram 是内置渠道，插件渠道经 ContactChannelRegistry 接进来。
 * 回复、正在输入、任务结果只回原来的联系人；主动推送发给所有打开推送且已连接的渠道，
 * 谁先答算谁的，其余渠道随后收尾。审批永远不能在手机上确认。
 */
export class ContactService implements SecretaryContactPort {
  readonly registry = new ContactChannelRegistry();
  private readonly telegram: TelegramChannel;
  private readonly asks: PendingAsk[] = [];
  /** 已经收尾的提问槽位：旧按钮再点一次只回「已经回答过了」 */
  private readonly settledAsks = new Map<number, AskSettledOutcome['kind']>();
  /** 卡片 id → 已经发出去的那条消息：按钮回调只带 id，重启后照样认得出是哪张卡 */
  private readonly cardsById = new Map<string, TrackedCard>();
  /** 提案 id → 已经提示过的那条消息：同一张卡只推一次，处理掉再收尾 */
  private readonly cardMessages = new Map<string, TrackedCard>();
  /** 会话 id → 审批提示：审批在应用里收尾后清按钮 */
  private readonly approvalCards = new Map<string, TrackedCard[]>();
  /** 没按钮的渠道：联系人 → 最近一条提示里的卡片编号 */
  private readonly plainCards = new Map<string, string[]>();
  private slot = 1;
  /** 从手机发来消息后，等这一轮的正文再回发给发消息的那个人 */
  private readonly awaitingReply = new Map<string, Map<string, Peer>>();
  /**
   * 手机发起的那条任务链：链上每一轮的正文都要回推发起它的联系人，
   * 包括派出会话的结果回传注入的那几轮。链上还有关注中的任务就一直留着。
   */
  private readonly phoneChain = new Map<string, Map<string, Peer>>();
  /** 会话 id → 最近一次回推的轮次：事件重放、镜像与回发撞车时只推一次 */
  private readonly relayed = new Map<string, { turnId?: string; text: string }>();
  /** 手机上正在确认卡片：确认出来的会话也算这个联系人发起的任务 */
  private readonly phoneOrigin = new Map<string, Peer>();
  /** 正在续发「正在输入…」的那一轮。同一时间只跑一个循环 */
  private typingLoop: {
    conversationId: string;
    peers: Peer[];
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** /feed 的翻页游标：按钮上只带短编号，重启后按钮失效即可 */
  private readonly feedCursors = new Map<string, FeedCursor>();
  private feedSeq = 1;
  /** 正在执行只读命令的联系人：记忆开关按它的渠道算 */
  private commandPeer: Peer | null = null;

  constructor(
    private readonly store: ContactStore,
    private readonly ports: ContactServicePorts
  ) {
    this.telegram = new TelegramChannel(store, {
      audit: ports.audit,
      publish: () => this.ports.publish(),
      now: ports.now,
      random: ports.random,
      lang: ports.lang,
      onError: (code, detail) => this.ports.onError?.(code, detail),
      inbound: (message) => this.inbound(message),
      menuCommands: () => this.menuCommands(TELEGRAM_CHANNEL_ID),
      ...(ports.api ? { api: ports.api } : {}),
    });
    this.registry.upsert(
      { id: TELEGRAM_CHANNEL_ID, title: 'Telegram', builtin: true },
      { channel: this.telegram }
    );
  }

  state(): SecretaryContactState {
    const file = this.store.file();
    return {
      enabled: file.enabled,
      channels: this.registry.list().map((entry) => this.channelView(entry)),
      telegram: { ...this.telegram.view(), following: followingViews(this.followingList()) },
    };
  }

  private channelView(entry: ChannelEntry): SecretaryContactChannelView {
    const { status, detail } = this.statusOf(entry);
    const meta = entry.meta;
    return {
      id: meta.id,
      title: meta.title,
      builtin: meta.builtin,
      ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
      ...(meta.icon ? { icon: meta.icon } : {}),
      ...(meta.settingsView ? { settingsView: meta.settingsView } : {}),
      status,
      ...(detail ? { detail } : {}),
      caps: this.capsOf(meta.id) ?? { ...TELEGRAM_CAPS, buttons: false, edit: false },
      prefs: channelPrefs(this.store.file(), meta.id),
    };
  }

  private statusOf(entry: ChannelEntry): {
    status: SecretaryContactChannelStatus;
    detail?: string;
  } {
    if (entry.meta.id === TELEGRAM_CHANNEL_ID) return this.telegram.status();
    if (!entry.channel) return { status: 'unconfigured' };
    return { status: entry.status, ...(entry.detail ? { detail: entry.detail } : {}) };
  }

  private capsOf(channelId: string): ChannelCaps | null {
    return this.registry.get(channelId)?.channel?.caps() ?? null;
  }

  private prefsOf(channelId: string): SecretaryContactChannelPrefs {
    return channelPrefs(this.store.file(), channelId);
  }

  /** 总开关与渠道开关都开着、实现也在：才收发 */
  private active(channelId: string): ContactChannel | null {
    if (!this.store.file().enabled) return null;
    const entry = this.registry.get(channelId);
    if (!entry?.channel || !this.prefsOf(channelId).enabled) return null;
    return entry.channel;
  }

  /** 已连接的联系人：Telegram 是绑定的 chat，插件渠道是它上报的 peers */
  private connectedPeers(entry: ChannelEntry): Peer[] {
    if (entry.meta.id === TELEGRAM_CHANNEL_ID) {
      const peerId = this.telegram.peerId();
      return peerId ? [{ channelId: TELEGRAM_CHANNEL_ID, peerId }] : [];
    }
    if (entry.status !== 'connected') return [];
    return entry.peers.map((peerId) => ({ channelId: entry.meta.id, peerId }));
  }

  /** 主动推送：启用、已连接、并且打开了主动推送的渠道 */
  private pushTargets(): Peer[] {
    return this.registry
      .list()
      .filter((entry) => this.active(entry.meta.id) && this.prefsOf(entry.meta.id).push)
      .flatMap((entry) => this.connectedPeers(entry));
  }

  /** 同步镜像：打开了镜像的渠道 */
  private mirrorTargets(): Peer[] {
    return this.registry
      .list()
      .filter((entry) => this.active(entry.meta.id) && this.prefsOf(entry.meta.id).syncMirror)
      .flatMap((entry) => this.connectedPeers(entry));
  }

  /**
   * 手机发起的回合：等待回复的那一轮，或正在手机上确认卡片的那一会儿。
   * 返回发起它的联系人，派发与定时据此决定要不要记进关注列表。
   */
  phoneTurnChat(conversationId: string): Peer | null {
    const first =
      this.awaitingReply.get(conversationId)?.values().next().value ??
      this.phoneOrigin.get(conversationId) ??
      this.phoneChain.get(conversationId)?.values().next().value;
    if (!first || !this.active(first.channelId)) return null;
    return first;
  }

  /** 手机关注中的任务：结果一定要回推，不受 notify 降噪影响 */
  follows(conversationId: string): boolean {
    return this.ports.following?.find('session', conversationId) !== undefined;
  }

  /** 只读命令里的 /memory：按发命令那个人的渠道开关算 */
  memoryAllowed(): boolean {
    return this.prefsOf(this.commandPeer?.channelId ?? TELEGRAM_CHANNEL_ID).memory;
  }

  private remember(map: Map<string, Map<string, Peer>>, conversationId: string, peer: Peer): void {
    const peers = map.get(conversationId) ?? new Map<string, Peer>();
    peers.set(peerKey(peer), peer);
    map.set(conversationId, peers);
  }

  private forget(map: Map<string, Map<string, Peer>>, conversationId: string, peer: Peer): void {
    const peers = map.get(conversationId);
    if (!peers) return;
    peers.delete(peerKey(peer));
    if (peers.size === 0) map.delete(conversationId);
  }

  /** 链上的任务都收口了就把这条链断掉：之后的回合不再回推手机 */
  private prunePhoneChain(conversationId: string): void {
    if (this.followingList().some((item) => item.secretaryConversationId === conversationId)) {
      return;
    }
    this.phoneChain.delete(conversationId);
  }

  /** 同一轮只回推一次：有 turnId 认 turnId，没有就认正文 */
  private alreadyRelayed(conversationId: string, text: string, turnId?: string): boolean {
    const last = this.relayed.get(conversationId);
    const same =
      last !== undefined && (turnId !== undefined ? last.turnId === turnId : last.text === text);
    if (same) return true;
    this.relayed.set(conversationId, { ...(turnId ? { turnId } : {}), text });
    return false;
  }

  /** 这个会话上还有手机上处理不了的卡或审批 */
  private needsAppConfirm(conversationId: string): boolean {
    if (this.approvalCards.has(conversationId)) return true;
    for (const card of this.cardsById.values()) {
      if (!card.settled && card.conversationId === conversationId) return true;
    }
    return false;
  }

  private followingList(): FollowedTask[] {
    return this.ports.following?.list() ?? [];
  }

  async start(): Promise<void> {
    await this.store.ready();
    if (this.active(TELEGRAM_CHANNEL_ID)) await this.telegram.start();
  }

  async stop(): Promise<void> {
    this.stopTyping();
    await this.telegram.stop();
  }

  // ---------- Telegram 绑定向导（内置渠道专属） ----------

  async bind(rawToken?: unknown): Promise<ContactResult> {
    return this.telegram.bind(rawToken);
  }

  /** 第 3 步的「重新生成」：码过期或对不上时用同一个 bot 再发一个新码 */
  async regenerate(): Promise<ContactResult> {
    return this.bind();
  }

  async cancelBind(): Promise<void> {
    await this.telegram.cancelBind();
  }

  /** 解绑：清 chat 与绑定码，停止轮询；bot 与 token 留着，重新绑定不必再贴一次 */
  async unbind(): Promise<ContactResult> {
    await this.telegram.unbind();
    this.dropChannelState(TELEGRAM_CHANNEL_ID, 'contact_unbind');
    this.audit('contact_unbind', true);
    this.ports.publish();
    return { ok: true };
  }

  /** 更换 bot：token、bot 身份、chat 一起清，向导回到第 1 步 */
  async forgetBot(): Promise<ContactResult> {
    await this.telegram.forgetBot();
    this.dropChannelState(TELEGRAM_CHANNEL_ID, 'contact_forget_bot');
    this.audit('contact_forget_bot', true);
    this.ports.publish();
    return { ok: true };
  }

  async sendTest(): Promise<ContactResult> {
    const peerId = this.telegram.peerId();
    if (!peerId) return { ok: false, error: 'not-bound' };
    const sent = await this.post(
      { channelId: TELEGRAM_CHANNEL_ID, peerId },
      'sendText',
      { text: this.telegram.testText() },
      { force: true }
    );
    this.audit('contact_test', sent.ok, sent.ok ? undefined : sent.error);
    return sent.ok ? { ok: true } : { ok: false, error: sent.error };
  }

  setAllowCardConfirm(value: boolean): void {
    this.setChannelPrefs(TELEGRAM_CHANNEL_ID, { cardConfirm: value === true });
  }

  /** 记忆标题的开关：关掉时命令菜单里也不出现 /memory */
  setAllowMemory(value: boolean): void {
    this.setChannelPrefs(TELEGRAM_CHANNEL_ID, { memory: value === true });
  }

  /** 总开关：关掉后 Telegram 停止轮询，插件渠道不再路由 */
  async setEnabled(value: boolean): Promise<void> {
    const on = value === true;
    this.store.save({ ...this.store.file(), enabled: on });
    this.audit('contact_settings', true, `enabled=${on}`);
    if (!on) this.stopTyping();
    await this.syncTelegramRunning();
    this.ports.publish();
  }

  /** 渠道卡片上的通用开关 */
  setChannelPrefs(channelId: string, patch: Partial<SecretaryContactChannelPrefs>): ContactResult {
    if (!this.registry.get(channelId)) return { ok: false, error: 'not-found' };
    const caps = this.capsOf(channelId);
    const clean: Partial<SecretaryContactChannelPrefs> = {};
    for (const key of ['enabled', 'push', 'cardConfirm', 'syncMirror', 'memory'] as const) {
      if (typeof patch[key] === 'boolean') clean[key] = patch[key];
    }
    // 没按钮的渠道也能靠「确认 N」确认卡片；没有渠道实现时不改能力相关的开关
    if (!caps) {
      delete clean.cardConfirm;
      delete clean.syncMirror;
    }
    this.store.save(withChannelPrefs(this.store.file(), channelId, clean));
    const detail = Object.entries(clean)
      .map(([key, value]) => `${legacyPrefName(channelId, key)}=${value}`)
      .join(' ');
    if (detail) this.audit('contact_settings', true, detail);
    if (clean.syncMirror === false || clean.enabled === false) this.stopTyping();
    if (clean.memory !== undefined) this.syncMenu(channelId);
    if (clean.enabled !== undefined && channelId === TELEGRAM_CHANNEL_ID) {
      void this.syncTelegramRunning();
    }
    this.ports.publish();
    return { ok: true };
  }

  private async syncTelegramRunning(): Promise<void> {
    if (this.active(TELEGRAM_CHANNEL_ID)) await this.telegram.start();
    else await this.telegram.stop();
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

  // ---------- 插件渠道 ----------

  /** 清单声明了渠道：卡片先出来（未配置），等插件 register */
  declareChannel(meta: ChannelMeta): void {
    if (meta.builtin || meta.id === TELEGRAM_CHANNEL_ID) return;
    const current = this.registry.get(meta.id)?.meta;
    if (current && JSON.stringify(current) === JSON.stringify(meta)) return;
    this.registry.upsert(meta);
    this.ports.publish();
  }

  attachChannel(channelId: string, channel: ContactChannel): boolean {
    const entry = this.registry.get(channelId);
    if (!entry || entry.meta.builtin) return false;
    this.registry.upsert(entry.meta, { channel });
    this.audit('contact_channel', true, `register ${channelId}`);
    this.ports.publish();
    return true;
  }

  setChannelStatus(channelId: string, input: ChannelStatusInput): boolean {
    const entry = this.registry.get(channelId);
    if (!entry || entry.meta.builtin) return false;
    const before = entry.peers;
    const peers = input.peers ? [...new Set(input.peers.map(String))] : entry.peers;
    this.registry.upsert(entry.meta, {
      status: input.status,
      peers,
      ...(input.detail ? { detail: input.detail } : { detail: undefined }),
    });
    // 换了人（重新扫码）或断开：旧联系人的待收尾记录作废
    const gone = before.filter((peerId) => !peers.includes(peerId));
    if (gone.length > 0 || input.status === 'unconfigured') {
      this.dropChannelState(
        channelId,
        'contact_channel_reset',
        input.status === 'unconfigured' ? undefined : gone
      );
    }
    this.ports.publish();
    return true;
  }

  /** 插件停用或卸载：卡片消失、停掉路由，清掉这个渠道的关注项与待收尾记录 */
  removeChannel(channelId: string): void {
    const entry = this.registry.get(channelId);
    if (!entry || entry.meta.builtin) return;
    this.registry.remove(channelId);
    this.dropChannelState(channelId, 'contact_channel_removed');
    this.audit('contact_channel', true, `remove ${channelId}`);
    this.ports.publish();
  }

  /** 插件 id 下的全部渠道 */
  pluginChannels(pluginId: string): string[] {
    return this.registry
      .list()
      .filter((entry) => entry.meta.pluginId === pluginId)
      .map((entry) => entry.meta.id);
  }

  /** 渠道断开：发往它的提问、卡片、等待回复、任务链、关注一并清掉 */
  private dropChannelState(channelId: string, reason: string, peerIds?: readonly string[]): void {
    const hit = (peer: Peer) =>
      peer.channelId === channelId && (peerIds === undefined || peerIds.includes(peer.peerId));
    for (const ask of this.asks) ask.sends = ask.sends.filter((send) => !hit(send.peer));
    for (let index = this.asks.length - 1; index >= 0; index -= 1) {
      if (this.asks[index]?.sends.length === 0) this.asks.splice(index, 1);
    }
    const dropCard = (card: TrackedCard) => {
      card.sends = card.sends.filter((send) => !hit(send.peer));
      return card.sends.length === 0;
    };
    for (const [id, card] of this.cardMessages) {
      if (dropCard(card)) {
        this.cardMessages.delete(id);
        this.cardsById.delete(id);
      }
    }
    for (const [id, card] of this.cardsById) if (dropCard(card)) this.cardsById.delete(id);
    for (const [conversationId, list] of this.approvalCards) {
      const rest = list.filter((card) => !dropCard(card));
      if (rest.length > 0) this.approvalCards.set(conversationId, rest);
      else this.approvalCards.delete(conversationId);
    }
    for (const key of [...this.plainCards.keys()]) {
      if (key.startsWith(`${channelId}\u0000`)) this.plainCards.delete(key);
    }
    for (const map of [this.awaitingReply, this.phoneChain]) {
      for (const [conversationId, peers] of map) {
        for (const [key, peer] of peers) if (hit(peer)) peers.delete(key);
        if (peers.size === 0) map.delete(conversationId);
      }
    }
    for (const [conversationId, peer] of this.phoneOrigin) {
      if (hit(peer)) this.phoneOrigin.delete(conversationId);
    }
    if (this.typingLoop) {
      this.typingLoop.peers = this.typingLoop.peers.filter((peer) => !hit(peer));
      if (this.typingLoop.peers.length === 0) this.stopTyping();
    }
    if (channelId === TELEGRAM_CHANNEL_ID && peerIds === undefined) {
      this.settledAsks.clear();
      this.relayed.clear();
    }
    if (peerIds === undefined) {
      const count = this.ports.following?.clearChannel(channelId) ?? 0;
      if (count > 0) this.audit('contact_follow_clear', true, `cleared ${count} (${reason})`);
    }
  }

  // ---------- 出站 ----------

  /**
   * 出站统一入口：按渠道能力降级。没按钮就把按钮换成编号文本/链接行，
   * 不支持 HTML 就转纯文本，超长按 maxChars 切条。
   */
  private async post(
    peer: Peer,
    kind: PostKind,
    message: ChannelMessage,
    options?: { force?: boolean }
  ): Promise<ChannelSend> {
    const channel = options?.force
      ? (this.registry.get(peer.channelId)?.channel ?? null)
      : this.active(peer.channelId);
    if (!channel) return { ok: false, error: 'token-required' };
    const caps = channel.caps();
    let sent: ChannelSend;
    if (caps.buttons) {
      sent = await channel[kind](peer.peerId, message);
    } else {
      const base = message.format === 'html' ? htmlToPlain(message.text) : message.text;
      const extra = plainButtonsText(message.buttons);
      const text = extra ? `${base}\n${extra}` : base;
      sent = { ok: true };
      for (const chunk of splitPlain(text, caps.maxChars)) {
        sent = await channel[kind](peer.peerId, { text: chunk });
        if (!sent.ok) break;
      }
    }
    if (sent.ok) this.audit('contact_outbound', true, describe(message.text));
    else {
      this.audit('contact_outbound', false, sent.error);
      this.ports.onError?.(sent.error);
    }
    return sent;
  }

  private urlButtonFor(peer: Peer, link: string | undefined): boolean {
    return (
      link !== undefined &&
      (this.capsOf(peer.channelId)?.urlButtons ?? false) &&
      telegramUrlButtonSupported(link)
    );
  }

  private hasButtons(peer: Peer): boolean {
    return this.capsOf(peer.channelId)?.buttons ?? false;
  }

  /**
   * 秘书对 J 哥说的里程碑：与系统通知同一批结果，按 notify 决定发不发。
   * 手机关注的任务只回发起它的联系人；完成或失败推过一次就结束关注。
   */
  onMilestone(input: ContactMilestoneInput): void {
    const mode = this.ports.notifyMode();
    const follow = this.ports.following?.find('session', input.conversationId);
    // 手机关注中的任务是 J 哥亲手要的答案：notify 降噪不挡它，一轮结束仍然不发
    if (input.kind === 'turn-ended') return;
    if (!follow && (!mode || !shouldForwardMilestone(mode, input.kind))) return;
    const targets = follow
      ? this.active(follow.origin.channelId)
        ? [follow.origin]
        : []
      : this.pushTargets();
    if (targets.length === 0) return;
    const link = conversationDeepLink(input.conversationId);
    let finished = false;
    for (const peer of targets) {
      const asButton = this.urlButtonFor(peer, link);
      const text = formatMilestoneMessage(this.ports.lang(), {
        kind: input.kind,
        title: input.title,
        ...(input.lastText ? { lastText: input.lastText } : {}),
        ...(follow ? { summary: follow.summary } : {}),
        // url 按钮只认 http(s)/tg；enso:// 只能当等宽文本发出去让人复制
        ...(asButton ? {} : { link }),
      });
      const buttons = asButton
        ? [[{ text: cardOpenButtonText(this.ports.lang()), url: link }]]
        : [];
      void this.post(peer, 'sendText', { text, buttons }).then((sent) => {
        this.audit(
          follow ? 'contact_follow_push' : 'contact_milestone',
          sent.ok,
          sent.ok ? input.kind : sent.error
        );
        if (!sent.ok || !follow || finished) return;
        // 推出去才算结束：发失败的关注留着，下一次结果还能再推
        if (!FOLLOW_END_KINDS.has(input.kind)) return;
        finished = true;
        this.ports.following?.take('session', input.conversationId);
        this.audit('contact_follow_done', true, `${input.kind} ${follow.summary}`);
      });
    }
  }

  /** 手机关注里的定时到点了：只推给发起它的联系人，推完就结束关注 */
  onScheduleFired(input: ContactScheduleFiredInput): void {
    const follow = this.ports.following?.find('schedule', input.scheduleId);
    if (!follow || !this.active(follow.origin.channelId)) return;
    const text = formatFollowedScheduleMessage(this.ports.lang(), {
      summary: follow.summary,
      text: input.text,
    });
    void this.post(follow.origin, 'sendText', { text }).then((sent) => {
      this.audit('contact_follow_push', sent.ok, sent.ok ? 'schedule' : sent.error);
      if (!sent.ok) return;
      this.ports.following?.take('schedule', input.scheduleId);
      this.audit('contact_follow_done', true, `schedule ${follow.summary}`);
    });
  }

  /** 派出会话转给秘书的提问：手机只提示，J 哥回话即进秘书会话 */
  onRelayAsk(input: ContactRelayAskInput): void {
    for (const peer of this.pushTargets()) {
      const text = formatAskMessage(this.ports.lang(), {
        question: input.question,
        ...(input.options ? { options: input.options } : {}),
        title: input.label,
        ...(this.hasButtons(peer) ? {} : { plain: true }),
      });
      void this.post(peer, 'sendText', { text }).then((sent) => {
        this.audit('contact_relay_ask', sent.ok, sent.ok ? undefined : sent.error);
      });
    }
  }

  /** 秘书自己用 ask_user 问 J 哥：所有推送渠道都发，谁先答算谁的 */
  onAskRequest(conversationId: string, ask: AskRequestInfo): void {
    const targets = this.pushTargets();
    if (targets.length === 0) return;
    const options = (ask.options ?? []).filter((option) => typeof option === 'string');
    const slot = this.slot++;
    const text = formatAskMessage(this.ports.lang(), {
      question: ask.question,
      ...(options.length > 0 ? { options } : {}),
    });
    const pending: PendingAsk = {
      slot,
      conversationId,
      requestId: ask.requestId,
      options,
      at: this.ports.now(),
      text,
      sends: [],
      settled: false,
    };
    this.asks.push(pending);
    while (this.asks.length > MAX_PENDING_ASKS) {
      // 挤出去的提问也收尾：手机上那条标成已过期，按钮不能一直留着
      const dropped = this.asks.shift();
      if (dropped) void this.settleAsk(dropped, { kind: 'expired' });
    }
    for (const peer of targets) {
      const buttons = this.hasButtons(peer);
      const message: ChannelMessage = buttons
        ? {
            text,
            buttons: options
              .slice(0, 8)
              .map((option, index) => [
                { text: option.slice(0, 40), data: askCallbackData(slot, index) },
              ]),
          }
        : {
            text: formatAskMessage(this.ports.lang(), {
              question: ask.question,
              ...(options.length > 0 ? { options } : {}),
              plain: true,
            }),
          };
      const delivery: Delivery = { peer, messageId: null, ready: Promise.resolve() };
      pending.sends.push(delivery);
      delivery.ready = this.post(peer, 'ask', message).then((sent) => {
        this.audit('contact_ask_forward', sent.ok, sent.ok ? undefined : sent.error);
        if (sent.ok) delivery.messageId = sent.messageId ?? null;
      });
    }
  }

  /** 提问收尾（应用里先答了、超时、取消）：各渠道上的按钮随之失效 */
  onAskResolved(conversationId: string, requestId: string, resolution?: AskResolvedInfo): void {
    const index = this.asks.findIndex(
      (ask) => ask.conversationId === conversationId && ask.requestId === requestId
    );
    if (index < 0) return;
    const [pending] = this.asks.splice(index, 1);
    if (pending) void this.settleAsk(pending, askOutcomeFromResolution(resolution));
  }

  /**
   * 提问收尾：能改消息的渠道原地换成「已回答 / 已过期」并清按钮；
   * 不能改的渠道不动旧消息。改不动只记一笔审计，不能打断回答。
   */
  private async settleAsk(pending: PendingAsk, outcome: AskSettledOutcome): Promise<void> {
    if (pending.settled) return;
    pending.settled = true;
    this.rememberSettledAsk(pending.slot, outcome.kind);
    const text = `${pending.text}\n\n${askSettledLine(this.ports.lang(), outcome)}`;
    for (const send of pending.sends) {
      await send.ready;
      const channel = this.registry.get(send.peer.channelId)?.channel;
      if (!channel?.caps().edit || send.messageId === null) continue;
      const result = await channel.settle(send.peer.peerId, send.messageId, text);
      if (result.ok && !result.markupOnly) {
        this.audit('contact_ask_settled', true, outcome.kind);
        continue;
      }
      this.audit('contact_ask_settled', false, `${outcome.kind} ${result.error}`);
      if (result.ok) this.audit('contact_ask_settled', true, `${outcome.kind} markup-only`);
    }
  }

  /** 已经收尾的提问：旧按钮再点一次只回「已经回答过了」，不重复触发 */
  private rememberSettledAsk(slot: number, kind: AskSettledOutcome['kind']): void {
    this.settledAsks.set(slot, kind);
    while (this.settledAsks.size > MAX_PENDING_ASKS * 4) {
      const oldest = this.settledAsks.keys().next().value;
      if (oldest === undefined) break;
      this.settledAsks.delete(oldest);
    }
  }

  /** 旧按钮的提示：答过的说「已经回答过了」，过期/作废的说「已经结束了」 */
  private staleAskToast(slot: number | undefined): string {
    const lang = this.ports.lang();
    const kind = slot === undefined ? undefined : this.settledAsks.get(slot);
    if (kind === 'answered' || kind === 'app') {
      return lang === 'zh' ? '已经回答过了' : 'Already answered';
    }
    return lang === 'zh' ? '这条提问已经结束了' : 'Already answered';
  }

  /**
   * 回合开始：这一轮的回复会发给谁（手机发起的那个人、打开镜像的渠道）就对谁点亮「正在输入…」。
   * 渠道没有正在输入就跳过；已有循环在跑时不重复起。
   */
  onTurnStart(conversationId: string): void {
    if (this.typingLoop) return;
    const peers = uniquePeers([
      ...(this.awaitingReply.get(conversationId)?.values() ?? []),
      ...this.mirrorTargets(),
    ]).filter((peer) => this.active(peer.channelId) && this.capsOf(peer.channelId)?.typing);
    if (peers.length === 0) return;
    const timer = setTimeout(() => this.refreshTyping(), TYPING_REFRESH_MS);
    this.typingLoop = { conversationId, peers, timer };
    void this.sendTyping();
  }

  /** 回合收尾：完成、出错、被停都走这里，回复发出后不再续发 */
  onTurnEnd(conversationId: string): void {
    if (this.typingLoop?.conversationId !== conversationId) return;
    this.stopTyping();
  }

  /**
   * 秘书这一轮的正文：回给发起这一轮的联系人、手机任务链上的联系人、打开镜像的渠道。
   * 同一轮只推一次；链上的任务都收口后这条链就断掉，应用里自己聊的不再误推。
   */
  onTurnReply(
    conversationId: string,
    text: string,
    options?: { delivery?: boolean; turnId?: string }
  ): void {
    this.onTurnEnd(conversationId);
    const fromPhone = [...(this.awaitingReply.get(conversationId)?.values() ?? [])];
    this.awaitingReply.delete(conversationId);
    const chained =
      options?.delivery === true ? [...(this.phoneChain.get(conversationId)?.values() ?? [])] : [];
    this.prunePhoneChain(conversationId);
    const body = text.trim();
    if (!body) return;
    const origin = uniquePeers([...fromPhone, ...chained]).filter((peer) =>
      this.active(peer.channelId)
    );
    const mirror = this.mirrorTargets().filter(
      (peer) => !origin.some((item) => samePeer(item, peer))
    );
    if (origin.length === 0 && mirror.length === 0) return;
    if (this.alreadyRelayed(conversationId, body, options?.turnId)) return;
    // 手机上看不到确认卡也处理不了审批：同一条里点明还得回应用点一下
    const payload = this.needsAppConfirm(conversationId)
      ? `${body}\n\n${formatNeedsAppConfirmLine(this.ports.lang())}`
      : body;
    for (const peer of origin) {
      void this.post(peer, 'sendText', { text: payload }).then((sent) => {
        this.audit('contact_reply', sent.ok, sent.ok ? undefined : sent.error);
      });
    }
    for (const peer of mirror) {
      void this.post(peer, 'sendText', { text: payload }).then((sent) => {
        this.audit('contact_mirror', sent.ok, sent.ok ? undefined : sent.error);
      });
    }
  }

  /** 静默回合：正文是空的，打开镜像的渠道补一行摘要，让手机知道秘书看过 */
  onTurnSilent(conversationId: string, updates: number): void {
    // 静默就是不打扰：先收掉「正在输入…」，摘要发完也不再续
    this.onTurnEnd(conversationId);
    // 手机发起的回合一定会回话，静默只可能来自系统回传
    const fromPhone = this.awaitingReply.delete(conversationId);
    this.prunePhoneChain(conversationId);
    if (fromPhone) return;
    for (const peer of this.mirrorTargets()) {
      void this.post(peer, 'sendText', {
        text: formatSilentTurnLine(this.ports.lang(), updates),
      }).then((sent) => {
        this.audit('contact_mirror', sent.ok, sent.ok ? 'silent' : sent.error);
      });
    }
  }

  /**
   * 审批：永远不能在手机上确认，只给一条回应用的入口。
   * 确认卡走 syncPendingCards，与界面状态同步。
   */
  onCardWaiting(input: ContactCardWaitingInput): void {
    const targets = this.pushTargets();
    if (targets.length === 0 || input.count <= 0) return;
    const lang = this.ports.lang();
    const link = input.conversationId ? conversationDeepLink(input.conversationId) : undefined;
    const slot = this.slot++;
    const entry: TrackedCard = {
      id: `approval:${slot}`,
      kind: 'dispatch',
      sends: [],
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
    for (const peer of targets) {
      const asButton = this.urlButtonFor(peer, link);
      const buttons = this.hasButtons(peer);
      const text = formatCardWaitingMessage(lang, {
        count: input.count,
        ...(input.approval ? { approval: true } : {}),
        // 做成 url 按钮的深链不再在正文里重复一遍
        ...(link && !asButton ? { link } : {}),
      });
      // 审批永远只有一个回应用的入口：手机上不给确认按钮
      const message: ChannelMessage = buttons
        ? { text, buttons: [[this.openButton(peer, lang, entry.id, link)]] }
        : { text };
      const delivery: Delivery = { peer, messageId: null, ready: Promise.resolve() };
      entry.sends.push(delivery);
      delivery.ready = this.post(peer, 'approvalNotice', message).then((sent) => {
        this.audit('contact_card_waiting', sent.ok, sent.ok ? 'approval' : sent.error);
        if (sent.ok) delivery.messageId = sent.messageId ?? null;
      });
    }
  }

  /** 审批在应用里答完了：各渠道上的那条提示一起收尾 */
  onApprovalResolved(conversationId: string): void {
    const list = this.approvalCards.get(conversationId);
    if (!list) return;
    this.approvalCards.delete(conversationId);
    for (const entry of list) void this.settleCard(entry);
  }

  /**
   * 待确认的卡与界面状态同步：新卡往推送渠道各发一条提示，处理掉的卡各渠道收尾。
   * 渠道关着手机确认时按钮照样在，但点了只提醒回应用处理。
   */
  syncPendingCards(cards: readonly ContactCardRef[]): void {
    const pending = new Set(cards.map((card) => card.id));
    for (const tracked of this.cardMessages.values()) {
      if (!pending.has(tracked.id)) void this.settleCard(tracked);
    }
    const targets = this.pushTargets();
    if (targets.length === 0) return;
    const fresh = cards.filter((card) => !this.cardMessages.has(card.id));
    if (fresh.length === 0) return;
    this.announceCards(targets, fresh, cards.length);
  }

  /**
   * 「在应用里打开」：http(s)/tg 深链做成 url 按钮（渠道自己打开），
   * enso:// 这类自定义 scheme 只能走回调，由 Main 聚焦窗口并定位到这张卡。
   */
  private openButton(peer: Peer, lang: ContactLang, cardId: string, link?: string): ChannelButton {
    return link && this.urlButtonFor(peer, link)
      ? { text: cardOpenButtonText(lang), url: link }
      : { text: cardOpenButtonText(lang), data: cardCallbackData(cardId, 'open') };
  }

  /** 一条提示里每张卡一个「确认<类型>：<标题>」按钮，再加一个回应用的入口；没按钮就编号 */
  private announceCards(
    targets: readonly Peer[],
    cards: readonly ContactCardRef[],
    total: number
  ): void {
    const lang = this.ports.lang();
    const shown = cards.slice(0, MAX_CARD_BUTTONS);
    const first = shown[0];
    const link = first?.conversationId
      ? proposalDeepLink(first.conversationId, first.id)
      : undefined;
    const tracked: TrackedCard[] = shown.map((card) => {
      const entry: TrackedCard = {
        ...card,
        sends: [],
        label: cardLabel(lang, card.kind, card.title),
        settled: false,
      };
      this.cardsById.set(card.id, entry);
      this.cardMessages.set(card.id, entry);
      return entry;
    });
    for (const peer of targets) {
      const confirmable = this.prefsOf(peer.channelId).cardConfirm;
      const buttons = this.hasButtons(peer);
      const asButton = this.urlButtonFor(peer, link);
      let message: ChannelMessage;
      if (buttons) {
        const text = formatCardWaitingMessage(lang, {
          count: total,
          ...(first?.title ? { title: first.title } : {}),
          ...(confirmable ? { confirmable: true } : {}),
          ...(link && !asButton ? { link } : {}),
        });
        const rows: ChannelButton[][] = shown.map((card) => [
          {
            text: cardConfirmButtonText(lang, card.kind, card.title),
            data: cardCallbackData(card.id, 'confirm'),
          },
        ]);
        // 确认前想先看全文：一张卡时并排，多张卡时单独一行
        if (first) {
          const open = this.openButton(peer, lang, first.id, link);
          if (shown.length === 1) rows[0]?.push(open);
          else rows.push([open]);
        }
        message = { text, buttons: rows };
      } else {
        message = { text: plainCardsText(lang, shown, total, confirmable, link) };
        if (confirmable)
          this.plainCards.set(
            peerKey(peer),
            shown.map((card) => card.id)
          );
      }
      const deliveries = tracked.map((entry) => {
        const delivery: Delivery = { peer, messageId: null, ready: Promise.resolve() };
        entry.sends.push(delivery);
        return delivery;
      });
      const sending = this.post(peer, 'confirmCards', message).then((sent) => {
        this.audit(
          'contact_card_waiting',
          sent.ok,
          sent.ok
            ? `${shown.map((card) => cardKindLabel(lang, card.kind)).join(',')}${confirmable ? '' : ' readonly'}`
            : sent.error
        );
        if (!sent.ok) return;
        for (const delivery of deliveries) delivery.messageId = sent.messageId ?? null;
      });
      for (const delivery of deliveries) delivery.ready = sending;
    }
  }

  /**
   * 卡片被处理掉（哪边处理都一样）：能改消息的渠道整条换成「✅ 已确认：…」并清按钮；
   * 不能改的渠道不动旧消息。全都改不动的留着，下一次状态同步再试。
   */
  private async settleCard(
    tracked: TrackedCard,
    action: 'confirm' | 'reject' | 'handled' = tracked.pendingAction ?? 'handled'
  ): Promise<void> {
    if (tracked.settled) return;
    const lang = this.ports.lang();
    let failed = false;
    for (const send of tracked.sends) {
      if (send.done) continue;
      await send.ready;
      const channel = this.registry.get(send.peer.channelId)?.channel;
      if (!channel?.caps().edit || send.messageId === null) {
        // 消息本来就没发出去或渠道改不了：没有按钮可清，不用再试
        send.done = true;
        continue;
      }
      const result = await channel.settle(
        send.peer.peerId,
        send.messageId,
        cardSettledText(lang, action, tracked.label)
      );
      if (result.ok && !result.markupOnly) {
        send.done = true;
        this.audit('contact_card_settled', true, cardKindLabel(lang, tracked.kind));
        continue;
      }
      this.audit('contact_card_settled', false, result.error);
      this.ports.onError?.(result.error);
      if (result.ok) {
        send.done = true;
        this.audit('contact_card_settled', true, 'markup-only');
      } else failed = true;
    }
    if (!failed) tracked.settled = true;
  }

  // ---------- 入站 ----------

  /** 渠道回调：总开关与渠道开关关着就丢掉 */
  async inbound(message: ChannelInbound): Promise<void> {
    if (!this.active(message.peer.channelId)) {
      this.audit('contact_inbound_rejected', false, `disabled ${message.peer.channelId}`);
      return;
    }
    if (message.kind === 'action') {
      await this.handleAction(message);
      return;
    }
    await this.handleText(message);
  }

  private async handleText(message: Extract<ChannelInbound, { kind: 'text' }>): Promise<void> {
    const { peer, text } = message;
    // 只读命令：Main 直接查面板数据回一条，不进秘书会话、不唤醒模型
    const command = parseContactCommand(text);
    if (command) {
      if (command.name === 'last') {
        await this.runLast(peer, command.arg);
        return;
      }
      if (command.name === 'sync') {
        await this.runSync(peer, command.arg);
        return;
      }
      if (command.name === 'following') {
        await this.runFollowing(peer, command.arg);
        return;
      }
      await this.runCommand(peer, command.name, command.arg);
      return;
    }
    // 光秃秃的 /xxx 当成写错的命令，别让它落进秘书会话
    if (/^\/[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(text)) {
      await this.runUnknownCommand(peer);
      return;
    }

    // 没按钮的渠道：「确认 2」就是点第二张卡的确认
    const plainCard = this.hasButtons(peer) ? null : PLAIN_CARD_CONFIRM.exec(text);
    if (plainCard) {
      const ids = this.plainCards.get(peerKey(peer)) ?? [];
      const id = ids[Number(plainCard[1]) - 1];
      if (id) {
        await this.handleCardAction(peer, id, 'confirm', async () => {});
        return;
      }
    }

    // 挂着提问时，这句话就是回答：与应用里先答的那一边一致
    const pending = this.newestAsk(peer);
    if (pending) {
      const index = this.hasButtons(peer) ? -1 : Number(/^\d{1,2}$/u.test(text) ? text : 0) - 1;
      this.answerPendingAsk(peer, pending, pending.options[index] ?? text);
      return;
    }

    const conversationId = this.ports.secretaryConversationId();
    if (!conversationId) {
      this.audit('contact_inbound', false, 'no-secretary');
      await this.notifyUndelivered(peer);
      return;
    }
    // 入站只在这里包一次：所有渠道都走 wrapInboundMessage
    const meta = this.registry.get(peer.channelId)?.meta;
    const body = wrapInboundMessage(
      peer.channelId === TELEGRAM_CHANNEL_ID
        ? TELEGRAM_INBOUND
        : { id: peer.channelId, title: meta?.title ?? peer.channelId },
      this.ports.lang(),
      {
        ...(message.name ? { username: message.name } : {}),
        ...(message.at ? { at: message.at } : {}),
        text,
      }
    );
    this.remember(this.awaitingReply, conversationId, peer);
    // 这条消息发起了一条任务链：链上每一轮的正文都要回推这个联系人
    this.remember(this.phoneChain, conversationId, peer);
    const delivered = await this.ports.deliver(conversationId, body);
    this.audit(
      'contact_inbound',
      delivered.ok,
      delivered.ok ? describe(text) : (delivered.error ?? 'deliver-failed'),
      conversationId
    );
    if (!delivered.ok) {
      this.forget(this.awaitingReply, conversationId, peer);
      this.forget(this.phoneChain, conversationId, peer);
      await this.notifyUndelivered(peer);
    }
  }

  /** 秘书没拉起来或没有可用会话：回一句，别让手机那边干等 */
  private async notifyUndelivered(peer: Peer): Promise<void> {
    await this.post(peer, 'sendText', {
      text:
        this.ports.lang() === 'zh'
          ? '秘书没能启动，这条消息没送到。稍后再发，或在电脑上打开秘书看看。'
          : "Couldn't start the secretary, so this message wasn't delivered. Try again later or open the secretary on your computer.",
    });
  }

  private async handleAction(message: Extract<ChannelInbound, { kind: 'action' }>): Promise<void> {
    const { peer, data, ack } = message;
    const feedToken = parseFeedCallback(data);
    if (feedToken !== null) {
      await this.handleFeedCallback(peer, message.messageId, feedToken, ack);
      return;
    }
    const follow = parseFollowCallback(data);
    if (follow) {
      await this.handleFollowCallback(peer, message.messageId, follow, ack);
      return;
    }
    const card = parseCardCallbackData(data);
    if (card) {
      await this.handleCardAction(peer, card.id, card.action, ack);
      return;
    }
    // 老版本的卡片按钮（card:<槽位>:c）已经失效：别落到提问分支上答错话
    if (data.startsWith('card:')) {
      await ack(this.ports.lang() === 'zh' ? '这张卡已经处理过了' : 'That card is gone');
      return;
    }
    const parsed = parseAskCallbackData(data);
    const pending = parsed ? this.asks.find((ask) => ask.slot === parsed.slot) : undefined;
    if (!parsed || !pending) {
      await ack(this.staleAskToast(parsed?.slot));
      return;
    }
    const option = pending.options[parsed.index];
    if (option === undefined) {
      await ack(this.ports.lang() === 'zh' ? '选项不存在' : 'Unknown option');
      return;
    }
    const answered = this.ports.answerAsk(pending.conversationId, pending.requestId, option);
    this.asks.splice(this.asks.indexOf(pending), 1);
    if (answered.ok) {
      this.audit('contact_ask_answer', true, `ask=${pending.slot}`);
      await ack(askCallbackToast(this.ports.lang(), option));
      // 原消息立刻换成「已回答」，其他渠道上的同一条也一起收尾
      await this.settleAsk(pending, { kind: 'answered', answer: option });
      return;
    }
    // 应用里先答了：手机这边自动失效
    this.audit('contact_ask_answer', false, 'already-answered');
    await ack(this.ports.lang() === 'zh' ? '已在应用里回答过了' : 'Already answered in the app');
    await this.settleAsk(pending, { kind: 'app' });
  }

  /**
   * 确认卡的动作：确认直接执行，打开只回到应用。
   * 渠道关着手机确认时只提醒回应用处理；审批根本没有确认入口。
   * 卡片已经处理过（哪边处理的都算）就只提示。
   */
  private async handleCardAction(
    peer: Peer,
    id: string,
    action: 'confirm' | 'reject' | 'open',
    ack: (text?: string) => Promise<void>
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
      await ack(cardCallbackToast(lang, 'open'));
      return;
    }
    // 审批永远不能在手机上确认
    if (id.startsWith('approval:')) {
      await ack(lang === 'zh' ? '审批只能在应用里处理' : 'Approvals stay in the app');
      return;
    }
    if (card?.settled) {
      await ack(lang === 'zh' ? '这张卡已经处理过了' : 'That card is gone');
      if (!this.hasButtons(peer)) {
        await this.post(peer, 'sendText', {
          text: lang === 'zh' ? '这张卡已经处理过了。' : 'That card is already handled.',
        });
      }
      return;
    }
    if (!this.prefsOf(peer.channelId).cardConfirm) {
      // 开关关着：只提醒回应用处理，绝不执行
      const op = action === 'confirm' ? 'contact_card_confirm' : 'contact_card_reject';
      this.audit(op, false, 'disabled');
      await ack(
        lang === 'zh'
          ? '已在设置里关闭手机确认，请回应用处理'
          : 'Phone confirm is off in settings; handle it in the app'
      );
      await this.replyOpenOnly(peer, lang, id, card);
      return;
    }
    // 手机上确认出来的会话也算这个联系人发起的任务：确认期间派生的东西记进关注列表
    if (card?.conversationId) this.phoneOrigin.set(card.conversationId, peer);
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
      await ack(
        cardCallbackToast(
          lang,
          action,
          card ? { kind: card.kind, ...(card.title ? { title: card.title } : {}) } : undefined
        )
      );
      // 回一条结果，再把各渠道上的原消息整条换成「✅ 已确认：…」
      const sent = await this.post(peer, 'sendText', {
        text: cardSettledText(lang, action, card?.label ?? this.fallbackLabel(lang)),
      });
      this.audit('contact_card_result', sent.ok, sent.ok ? action : sent.error);
    } else {
      await ack(lang === 'zh' ? '这张卡已经处理过了' : 'That card is gone');
      if (!this.hasButtons(peer)) {
        await this.post(peer, 'sendText', {
          text: lang === 'zh' ? '这张卡已经处理过了。' : 'That card is already handled.',
        });
      }
    }
    if (card) await this.settleCard(card, action);
  }

  /** 重启后内存里没有卡片记录：收尾文案只能给一句泛的 */
  private fallbackLabel(lang: ContactLang): string {
    return lang === 'zh' ? '这张卡' : 'the card';
  }

  /** 开关关着时点「确认」：只回一条说明，附「在应用里打开」，不执行任何动作 */
  private async replyOpenOnly(
    peer: Peer,
    lang: ContactLang,
    id: string,
    card: TrackedCard | undefined
  ): Promise<void> {
    const link = card?.conversationId ? proposalDeepLink(card.conversationId, id) : undefined;
    const text =
      lang === 'zh'
        ? '已在设置里关闭手机确认，请回应用处理。'
        : 'Phone confirm is off in settings; handle it in the app.';
    const message: ChannelMessage = this.hasButtons(peer)
      ? { text, buttons: [[this.openButton(peer, lang, id, link)]] }
      : { text: link ? `${text}\n${deepLinkLine(lang, link)}` : text };
    const sent = await this.post(peer, 'sendText', message);
    this.audit('contact_card_readonly', sent.ok, sent.ok ? 'disabled' : sent.error);
  }

  private answerPendingAsk(peer: Peer, pending: PendingAsk, text: string): void {
    const answered = this.ports.answerAsk(pending.conversationId, pending.requestId, text);
    this.asks.splice(this.asks.indexOf(pending), 1);
    this.audit(
      'contact_ask_answer',
      answered.ok,
      answered.ok ? describe(text) : (answered.error ?? 'already-answered')
    );
    // 各渠道上的原消息跟着标成已回答：再回看时看得出这条已经答过
    void this.settleAsk(
      pending,
      answered.ok ? { kind: 'answered', answer: text } : { kind: 'app' }
    );
    const ack = answered.ok
      ? this.ports.lang() === 'zh'
        ? '✅ 已把你的回答交给秘书'
        : '✅ Sent your answer'
      : this.ports.lang() === 'zh'
        ? '这条提问已经结束了'
        : 'That question is already closed';
    void this.post(peer, 'sendText', { text: ack }).then(() => undefined);
  }

  /** 发给这个联系人的最新一条提问 */
  private newestAsk(peer: Peer): PendingAsk | undefined {
    for (let index = this.asks.length - 1; index >= 0; index -= 1) {
      const ask = this.asks[index];
      if (ask?.sends.some((send) => samePeer(send.peer, peer))) return ask;
    }
    return undefined;
  }

  // ---------- 只读命令 ----------

  /** 只读命令：查面板数据、格式化、回一条；审计只记命令名 */
  private async runCommand(peer: Peer, name: ContactReadCommandName, arg: string): Promise<void> {
    const commands = this.ports.commands;
    if (!commands) return;
    this.commandPeer = peer;
    let reply: Awaited<ReturnType<ContactCommands['run']>>;
    try {
      reply = await commands.run(name, arg);
    } finally {
      this.commandPeer = null;
    }
    const buttons = this.hasButtons(peer) ? this.feedButtons(reply.next) : undefined;
    const sent = await this.post(peer, 'sendText', {
      text: reply.text,
      format: 'html',
      ...(buttons ? { buttons } : {}),
    });
    this.audit('contact_command', sent.ok, name);
  }

  /**
   * /last：把秘书会话最近几轮读出来发过去。只读，不进会话、不唤醒模型，
   * 也不记成用户消息；正文交给现有出站路径切条与转义。
   */
  private async runLast(peer: Peer, arg: string): Promise<void> {
    const lang = this.ports.lang();
    const rounds = parseRecapRounds(arg);
    if (rounds === null) {
      const sent = await this.post(peer, 'sendText', { text: recapUsageText(lang) });
      this.audit('contact_command', sent.ok, 'last');
      return;
    }
    const messages = (await this.ports.recentTurns?.(rounds)) ?? [];
    const turns = buildRecapTurns(messages, rounds);
    const text =
      turns.length === 0
        ? recapEmptyText(lang)
        : formatRecapMessage(lang, { turns, name: this.ports.secretaryName() });
    const sent = await this.post(peer, 'sendText', { text });
    this.audit('contact_command', sent.ok, sent.ok ? `last ${rounds}` : 'last');
  }

  /** /sync：不带参数查状态，on/off 开关这个渠道的镜像；开关动作单独记一条审计 */
  private async runSync(peer: Peer, arg: string): Promise<void> {
    const lang = this.ports.lang();
    const action = parseSyncArg(arg);
    if (action === null) {
      const sent = await this.post(peer, 'sendText', { text: syncUsageText(lang) });
      this.audit('contact_command', sent.ok, 'sync');
      return;
    }
    const current = this.prefsOf(peer.channelId).syncMirror;
    if (action !== 'status') {
      const on = action === 'on';
      this.store.save(withChannelPrefs(this.store.file(), peer.channelId, { syncMirror: on }));
      // 关掉同步后这一轮不再镜像，也就没必要继续亮「正在输入…」
      if (!on) this.stopTyping();
      this.audit('contact_sync', true, on ? 'on' : 'off');
      this.ports.publish();
    }
    const on = action === 'status' ? current : action === 'on';
    const sent = await this.post(peer, 'sendText', { text: formatSyncMessage(lang, on) });
    this.audit('contact_command', sent.ok, 'sync');
  }

  /** 写错的命令：给一份清单，不进秘书会话 */
  private async runUnknownCommand(peer: Peer): Promise<void> {
    const text = unknownCommandText(this.ports.lang(), this.prefsOf(peer.channelId).memory);
    const sent = await this.post(peer, 'sendText', { text, format: 'html' });
    this.audit('contact_command', sent.ok, 'unknown');
  }

  /**
   * /following：列出手机关注的任务，可以逐个取消或全清。
   * 有按钮的渠道带「取消 N / 全清」，没按钮的靠 /following cancel N。
   */
  private async runFollowing(peer: Peer, arg: string): Promise<void> {
    const lang = this.ports.lang();
    const following = this.ports.following;
    const parsed = parseFollowingArg(arg);
    if (!parsed || !following) {
      const sent = await this.post(peer, 'sendText', { text: followingUsageText(lang) });
      this.audit('contact_command', sent.ok, 'following');
      return;
    }
    if (parsed.action === 'clear') {
      const count = following.clear();
      if (count > 0) this.audit('contact_follow_clear', true, `cleared ${count}`);
      const sent = await this.post(peer, 'sendText', {
        text:
          count > 0
            ? lang === 'zh'
              ? `已清空 ${count} 个关注的任务。`
              : `Cleared ${count} followed task${count === 1 ? '' : 's'}.`
            : followingEmptyText(lang),
      });
      this.audit('contact_command', sent.ok, 'following');
      return;
    }
    if (parsed.action === 'cancel') {
      const item = following.list()[parsed.index - 1];
      if (!item) {
        const sent = await this.post(peer, 'sendText', { text: followingUsageText(lang) });
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
    const items = this.followingList();
    const buttons = this.hasButtons(peer) ? this.followingButtons(items) : undefined;
    const sent = await this.post(peer, 'sendText', {
      text: formatFollowingMessage(lang, { items: followingViews(items), now: this.ports.now() }),
      format: 'html',
      ...(buttons ? { buttons } : {}),
    });
    this.audit('contact_command', sent.ok, 'following');
  }

  /** 每项一个「取消 N」按钮，最后一行是全清；没有关注项就不给按钮 */
  private followingButtons(items: readonly FollowedTask[]): ChannelButton[][] | undefined {
    if (items.length === 0) return undefined;
    const lang = this.ports.lang();
    const rows: ChannelButton[][] = items.slice(0, MAX_CARD_BUTTONS).map((_item, index) => [
      {
        text: lang === 'zh' ? `取消 ${index + 1}` : `Drop ${index + 1}`,
        data: followCallbackData('cancel', index + 1),
      },
    ]);
    rows.push([{ text: lang === 'zh' ? '全清' : 'Drop all', data: followCallbackData('clear') }]);
    return rows;
  }

  /** 取消一项或全清：原地换掉这条消息，按钮跟着列表一起变 */
  private async handleFollowCallback(
    peer: Peer,
    messageId: string | undefined,
    action: { action: 'cancel' | 'clear'; index?: number },
    ack: (text?: string) => Promise<void>
  ): Promise<void> {
    const lang = this.ports.lang();
    const following = this.ports.following;
    if (!following) {
      await ack(followingEmptyText(lang));
      return;
    }
    if (action.action === 'clear') {
      const count = following.clear();
      if (count > 0) this.audit('contact_follow_clear', true, `cleared ${count}`);
      await ack(lang === 'zh' ? `已清空 ${count} 个` : `Cleared ${count}`);
      await this.refreshFollowingMessage(peer, messageId);
      return;
    }
    const item = following.list()[(action.index ?? 0) - 1];
    if (!item) {
      await ack(lang === 'zh' ? '这条关注已经结束了' : 'Already gone');
      await this.refreshFollowingMessage(peer, messageId);
      return;
    }
    following.remove(item.id);
    this.audit(
      'contact_follow_cancel',
      true,
      `${followKindLabel(lang, item.kind)} ${item.summary}`
    );
    await ack(lang === 'zh' ? '已取消关注' : 'Dropped');
    await this.refreshFollowingMessage(peer, messageId);
  }

  /** 原地重画关注列表 */
  private async refreshFollowingMessage(peer: Peer, messageId: string | undefined): Promise<void> {
    const channel = this.active(peer.channelId);
    if (!channel?.edit || !channel.caps().edit || messageId === undefined) return;
    const lang = this.ports.lang();
    const items = this.followingList();
    const result = await channel.edit(peer.peerId, messageId, {
      text: formatFollowingMessage(lang, { items: followingViews(items), now: this.ports.now() }),
      format: 'html',
      buttons: this.followingButtons(items) ?? [],
    });
    if (!result.ok) this.audit('contact_command', false, 'following');
  }

  /** 「更早」：原地换掉这一条，翻页不刷屏 */
  private async handleFeedCallback(
    peer: Peer,
    messageId: string | undefined,
    token: string,
    ack: (text?: string) => Promise<void>
  ): Promise<void> {
    const cursor = this.feedCursors.get(token);
    const commands = this.ports.commands;
    const channel = this.active(peer.channelId);
    if (!cursor || messageId === undefined || !commands || !channel?.edit) {
      await ack(
        this.ports.lang() === 'zh'
          ? '这一页已经失效了，发 /feed 重新看'
          : 'Expired, send /feed again'
      );
      return;
    }
    const reply = await commands.feedPage(cursor);
    const buttons = this.feedButtons(reply.next);
    const result = await channel.edit(peer.peerId, messageId, {
      text: reply.text,
      format: 'html',
      ...(buttons ? { buttons } : {}),
    });
    this.audit('contact_command', result.ok, 'feed');
    await ack(undefined);
  }

  /** 翻页按钮：有下一页才给，游标留在内存里 */
  private feedButtons(next?: FeedCursor): ChannelButton[][] | undefined {
    if (!next) return undefined;
    const token = `f${this.feedSeq++}`;
    this.feedCursors.set(token, next);
    while (this.feedCursors.size > 20) {
      const oldest = this.feedCursors.keys().next().value;
      if (oldest === undefined) break;
      this.feedCursors.delete(oldest);
    }
    return [
      [{ text: this.ports.lang() === 'zh' ? '更早' : 'Older', data: feedCallbackData(token) }],
    ];
  }

  /** 记忆默认不出现；关着时菜单里也没有 /memory */
  private menuCommands(channelId: string): { command: string; description: string }[] {
    const allowMemory = this.prefsOf(channelId).memory;
    return botCommands().filter((entry) => entry.command !== 'memory' || allowMemory);
  }

  private syncMenu(channelId: string): void {
    const channel = this.active(channelId);
    if (!channel?.setCommands || !channel.caps().commandMenu) return;
    const entry = this.registry.get(channelId);
    for (const peer of entry ? this.connectedPeers(entry) : []) {
      void channel.setCommands(peer.peerId, this.menuCommands(channelId));
    }
  }

  // ---------- 正在输入 ----------

  /** 续发一次，再排下一次；循环只由 stopTyping 结束 */
  private refreshTyping(): void {
    const loop = this.typingLoop;
    if (!loop) return;
    void this.sendTyping();
    loop.timer = setTimeout(() => this.refreshTyping(), TYPING_REFRESH_MS);
  }

  /**
   * 对这一轮的每个联系人发一次「正在输入…」。只是提示：失败只记审计、不抛错也不重试，
   * 顺手停掉循环，免得每一轮都撞同一堵墙。
   */
  private async sendTyping(): Promise<void> {
    const loop = this.typingLoop;
    if (!loop) return;
    for (const peer of loop.peers) {
      const channel = this.active(peer.channelId);
      if (!channel) {
        this.stopTyping();
        return;
      }
      const result = await channel.typing(peer.peerId);
      if (result.ok) continue;
      // 解绑后立刻停：没有 token 或 chat 不算出错
      if (result.error !== 'token-required') this.audit('contact_typing', false, result.error);
      this.stopTyping();
      return;
    }
  }

  private stopTyping(): void {
    const loop = this.typingLoop;
    if (!loop) return;
    this.typingLoop = null;
    clearTimeout(loop.timer);
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

/** 审计沿用老字段名：Telegram 的三个开关仍叫 allowCardConfirm / syncMirror / allowMemory */
function legacyPrefName(channelId: string, key: string): string {
  if (channelId !== TELEGRAM_CHANNEL_ID) return `${channelId}.${key}`;
  if (key === 'cardConfirm') return 'allowCardConfirm';
  if (key === 'memory') return 'allowMemory';
  return key === 'enabled' || key === 'push' ? `telegram.${key}` : key;
}

/** 没按钮的渠道：卡片编号列出来，打开手机确认时回「确认 N」 */
function plainCardsText(
  lang: ContactLang,
  cards: readonly ContactCardRef[],
  total: number,
  confirmable: boolean,
  link: string | undefined
): string {
  const head = lang === 'zh' ? '🗂 有卡片在等你' : '🗂 Cards are waiting';
  const lines = [head];
  cards.forEach((card, index) => {
    lines.push(`${index + 1}. ${cardConfirmButtonText(lang, card.kind, card.title)}`);
  });
  if (total > cards.length) {
    lines.push(lang === 'zh' ? `共 ${total} 张` : `${total} cards in total`);
  }
  lines.push(
    confirmable
      ? lang === 'zh'
        ? '回复「确认 1」直接处理对应的卡；审批永远只能在应用里处理。'
        : 'Reply "confirm 1" to handle that card. Approvals always stay in the app.'
      : lang === 'zh'
        ? '这个渠道关着手机确认，请回应用处理。'
        : 'Phone confirm is off for this channel; handle it in the app.'
  );
  if (link) lines.push(deepLinkLine(lang, link));
  return lines.join('\n');
}
