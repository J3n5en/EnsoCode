import { randomUUID } from 'node:crypto';
import { wrapInterjection } from '../../../shared/bots/interject';
import { type BotDeliverySource, enqueueByLane } from '../../../shared/bots/lane';
import type {
  AgentWorkerEvent,
  AttachedImage,
  ConversationAuthority,
  ConversationBotBinding,
  ProjectAuthority,
  ProjectedMessage,
} from '../../../shared/types/agent';
import type { BotChat, BotEngine, BotProfile } from '../../../shared/types/bot';
import type {
  BotEvent,
  BotQueueItem,
  BotSessionRecord,
  BotSilence,
} from '../../../shared/types/botIpc';
import {
  BOT_BUDGET_ERROR,
  BOT_TURN_LIMIT_ERROR,
  type BotBudgetVerdict,
} from '../../../shared/usage/botUsage';
import type { BotNotesSnapshot } from './botNotes';
import { buildBotModeInstruction, buildBotSystemPrompt } from './botPrompt';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';
import { StartedDeliveryIndex } from './startedDeliveries';
import { messageTokens } from './turnTokens';

/** bot 会话同时在跑的轮次上限（私聊、群聊、委派、例行合计，Code 会话不计） */
export const BOT_MAX_RUNNING_TURNS = 4;
/** 运行中的轮次超过该时长没有任何输出（流式、工具进度、子代理）即视为静默 */
export const BOT_SILENCE_MS = 90_000;
/** 进行中的回合为成员日预算预留的估算 token：本回合已用部分抵扣，回合结束即释放 */
export const BOT_TURN_RESERVE_TOKENS = 32_000;

type ActionResult = { ok: boolean; error?: string };
type Fail = { ok: false; error: string };

/** SourceAuthorityRegistry 的 Main 专用子集 */
export interface BotAuthorityPort {
  project(projectId: string): ProjectAuthority | undefined;
  conversation(conversationId: string): ConversationAuthority | undefined;
  ensureBotHomeProject(dir: string): ProjectAuthority | undefined;
  botHomeProject(dir: string): ProjectAuthority | undefined;
  removeBotHomeProject(projectId: string): boolean;
  createBotConversation(
    projectId: string,
    bot: ConversationBotBinding
  ): ConversationAuthority | undefined;
  endBotConversation(conversationId: string): ConversationAuthority | undefined;
  removeBotConversation(conversationId: string): ConversationAuthority | undefined;
  botConversations(): ConversationAuthority[];
}

export interface BotSpawnSpec {
  conversationId: string;
  projectId: string;
  cwd: string;
  resumeFile?: string;
  bot: BotProfile;
  /** 替换 pi 角色段 */
  systemPrompt: string;
  /** Bot 模式说明，追加在全局指令之后 */
  instructionText: string;
  /** 群聊成员会话：挂 group_tasks 工具 */
  groupTasks?: boolean;
  /** 私聊 / 群聊成员会话（委派会话走 independentSpecs，不挂）：挂 routine_propose */
  routines?: boolean;
  /** 写成员：worker 内同工作区按文件占用、全局命令短独占；ancestors 为委派链祖先会话 */
  writeLock?: { label: string; ancestors: string[] };
}

export interface BotRuntimePort {
  updateEngine?(conversationId: string, engine?: BotEngine): Promise<ActionResult>;
  spawn(spec: BotSpawnSpec): Promise<ActionResult>;
  prompt(
    conversationId: string,
    text: string,
    images?: AttachedImage[],
    deliveryId?: string
  ): ActionResult;
  steer(
    conversationId: string,
    text: string,
    images?: AttachedImage[],
    deliveryId?: string
  ): ActionResult;
  release(conversationId: string): Promise<void>;
  abort?(conversationId: string): void;
  removeSessionFiles(conversation: ConversationAuthority): void;
  /** 私聊回退到持久化 user entry（可选还原文件）；结果经 rewind-done 事件回来 */
  rewind?(conversationId: string, entryId: string, restoreFiles: boolean): ActionResult;
  /** 终态错误后续跑当前分支 */
  retry?(conversationId: string): ActionResult;
}

export interface BotSessionHostDeps {
  bots: BotStore;
  chats: BotChatStore;
  authority: BotAuthorityPort;
  runtime: BotRuntimePort;
  emit: (event: BotEvent) => void;
  maxRunningTurns?: number;
  /** 轮次只收到 idle/failed 状态而迟迟没有 turn-completed/turn-failed 时的兜底结算延迟 */
  settleGraceMs?: number;
  /** 成员日预算：投递前与每条带用量的 assistant 消息结束后检查，超额拒绝 / 停止当前回合 */
  budget?: {
    /** 备好该成员的今日账本（首次读 jsonl，之后内存累计） */
    prepare(botId: string): Promise<void>;
    /** prepare 之后同步判定：今日已用 + reservedTokens 触达上限即超额 */
    verdict(botId: string, reservedTokens: number): BotBudgetVerdict | null;
    /** 一条 assistant 消息结束：计入今日账本 */
    record?(botId: string, conversationId: string, index: number, message: ProjectedMessage): void;
  };
  /** 核心笔记：成员 memory 关闭时返回 undefined */
  notes?: { snapshot(botId: string, chatId: string | null): BotNotesSnapshot | undefined };
  /** 静默看门狗阈值，缺省 BOT_SILENCE_MS */
  silenceMs?: number;
  now?: () => number;
  /** 界面语言：人类插话补充说明用，缺省中文 */
  language?: () => 'zh' | 'en';
}

/** 委派会话的来源：工作区写锁沿委派链共用，等待提示落到发起委派的群 */
export interface BotDelegationOrigin {
  parentConversationId: string;
  chatId: string | null;
}

export interface BotDeliverOptions {
  images?: AttachedImage[];
  deliveryId?: string;
  queueIfBusy?: boolean;
  /** 缺省 bot：人类插话才加补充说明 */
  source?: BotDeliverySource;
  onlyIfIdle?: boolean;
}

export type BotDeliverResult =
  | {
      ok: true;
      conversationId: string;
      queued?: boolean;
      turnId?: string;
      /** 同一 deliveryId 已被该会话处理过，本次没有发出 */
      duplicate?: true;
    }
  | Fail;

export interface BotTurnFinished {
  deliveryId?: string;
  /** 委派会话为 null */
  chatId: string | null;
  botId: string;
  conversationId: string;
  /** 排队投递在发给 worker 时失败则缺省 */
  turnId?: string;
  text: string;
  ok: boolean;
  error?: string;
  delegationId?: string;
  /** 本宿主发起该轮时分配的键；委派记录的 batchId 与之相同 */
  turnKey?: string;
  /** 进行中的轮次被用户停止或中断（不含预算 / 出错）；委派据此级联取消该轮发起的子委派 */
  stopped?: true;
  /** 单回合上限停止时，只算厂商实报用量并未超限，是按估算停的 */
  estimated?: true;
  /** 最后一条 assistant 消息的模型 id */
  model?: string;
}

interface Delivery extends BotDeliverOptions {
  chatId: string;
  botId: string;
  conversationId: string;
  text: string;
}

interface LastAssistant {
  index: number;
  text: string;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
}

type Workspace = { ok: true; cwd: string; projectId: string } | Fail;

/** (chatId, botId) → 根会话：建会话、spawn/恢复、投递、并发排队、回合结果回调 */
export class BotSessionHost {
  private readonly live = new Set<string>();
  private readonly running = new Set<string>();
  /** 由本宿主发起、尚未结束的轮次；sawRunning 防止 spawn 后的 idle 误释放 */
  private readonly slots = new Map<string, { sawRunning: boolean }>();
  private queue: Delivery[] = [];
  private queueReasons = new Map<string, string>();
  private readonly lastAssistant = new Map<string, LastAssistant>();
  private readonly bindings = new Map<string, ConversationBotBinding | null>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<(event: BotTurnFinished) => void>();
  private readonly maxRunning: number;
  private readonly settleGraceMs: number;
  private readonly settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly independentSpecs = new Map<string, BotSpawnSpec>();
  private readonly liveProfiles = new Map<string, BotProfile>();
  private readonly activeDeliveries = new Map<string, string>();
  private readonly turnKeys = new Map<string, string>();
  private disposed = false;
  private readonly budgetChecks = new Set<string>();
  /** 本宿主发起的回合内每条 assistant 消息的用量（含流式估算；settled = 实报用量已记入日账本），按 turnKey 隔离各回合 */
  private readonly turnUsage = new Map<
    string,
    {
      turnKey: string;
      byIndex: Map<number, { tokens: number; real: number; settled: boolean }>;
    }
  >();
  /** 会话最近一次上报的上下文占用，估算流式中未报 input 的消息 */
  private readonly contextTokens = new Map<string, number>();
  /** 会话已看到的笔记版本（spawn 时进系统提示词，之后变化在投递前追加一次） */
  private readonly notesSeen = new Map<string, string>();
  private readonly deliveries = new Map<string, Map<string, 'sent' | 'started'>>();
  /** jsonl 里已开始处理的委派结果：首次全量、之后只读追加部分 */
  private readonly persistedStarts = new StartedDeliveryIndex();
  private readonly startedListeners = new Set<
    (event: { conversationId: string; deliveryId: string }) => void
  >();
  /** 运行中轮次的最后输出时间；silent = 已判静默（值为最后输出时间） */
  private readonly lastOutput = new Map<string, number>();
  private readonly silent = new Map<string, number>();
  /** 等待人类答复的审批 / 提问：期间不算静默 */
  private readonly waiting = new Map<string, Set<string>>();
  private readonly origins = new Map<string, BotDelegationOrigin>();
  /** 处于自动重试倒计时的会话：插话改排下一轮 */
  private readonly retrying = new Set<string>();
  private watchdog: ReturnType<typeof setInterval> | undefined;

  onDeliveryStarted(
    listener: (event: { conversationId: string; deliveryId: string }) => void
  ): () => void {
    this.startedListeners.add(listener);
    return () => this.startedListeners.delete(listener);
  }

  hasStartedDelivery(conversationId: string, deliveryId: string): boolean {
    if (this.deliveries.get(conversationId)?.get(deliveryId) === 'started') return true;
    const file = this.deps.authority.conversation(conversationId)?.sessionFile;
    if (!file || !this.persistedStarts.has(file, deliveryId)) return false;
    this.rememberDelivery(conversationId, deliveryId, 'started');
    return true;
  }
  private readonly sentListeners = new Set<
    (event: { conversationId: string; deliveryId: string }) => void
  >();

  onDeliverySent(
    listener: (event: { conversationId: string; deliveryId: string }) => void
  ): () => void {
    this.sentListeners.add(listener);
    return () => this.sentListeners.delete(listener);
  }
  private readonly discardListeners = new Set<
    (scope: { chatId?: string; botId?: string; conversationId?: string }) => void
  >();

  onDiscard(
    listener: (scope: { chatId?: string; botId?: string; conversationId?: string }) => void
  ): () => void {
    this.discardListeners.add(listener);
    return () => this.discardListeners.delete(listener);
  }

  constructor(private readonly deps: BotSessionHostDeps) {
    this.maxRunning = deps.maxRunningTurns ?? BOT_MAX_RUNNING_TURNS;
    this.settleGraceMs = deps.settleGraceMs ?? 2000;
  }

  onTurnFinished(listener: (event: BotTurnFinished) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isBotConversation(conversationId: string): boolean {
    return this.binding(conversationId) !== null;
  }

  runningCount(): number {
    return new Set([...this.slots.keys(), ...this.running]).size;
  }

  isBusy(conversationId: string): boolean {
    return (
      this.turnActive(conversationId) ||
      this.queue.some((item) => item.conversationId === conversationId)
    );
  }

  activeDeliveryId(conversationId: string): string | undefined {
    return this.turnActive(conversationId) ? this.activeDeliveries.get(conversationId) : undefined;
  }

  /** 由本宿主发起、尚未结束的轮次的键 */
  turnKey(conversationId: string): string | undefined {
    return this.slots.has(conversationId) ? this.turnKeys.get(conversationId) : undefined;
  }

  registerDelegation(
    conversationId: string,
    bot: BotProfile,
    origin?: BotDelegationOrigin
  ): boolean {
    const conversation = this.deps.authority.conversation(conversationId);
    const project = conversation && this.deps.authority.project(conversation.projectId);
    if (
      !conversation?.bot?.delegationId ||
      !project ||
      project.state !== 'active' ||
      project.kind === 'ssh'
    )
      return false;
    if (origin) this.origins.set(conversationId, origin);
    this.independentSpecs.set(conversationId, {
      conversationId,
      projectId: project.projectId,
      cwd: project.canonicalPath,
      bot,
      ...(conversation.sessionFile ? { resumeFile: conversation.sessionFile } : {}),
      systemPrompt: buildBotSystemPrompt(bot, this.deps.bots.readPersona(bot.id)),
      instructionText: buildBotModeInstruction({
        self: bot,
        kind: 'direct',
        roster: this.deps.bots.list(),
      }),
    });
    return true;
  }

  effectiveBot(conversationId: string): BotProfile | undefined {
    return (
      (this.live.has(conversationId) ? this.liveProfiles.get(conversationId) : undefined) ??
      this.independentSpecs.get(conversationId)?.bot ??
      this.deps.bots.get(this.binding(conversationId)?.botId ?? '')
    );
  }

  /** 空闲立即更新；活轮不换模型，结束或下次投递时再同步。委派保留任务自己的配置。 */
  async refreshModel(botId: string): Promise<void> {
    await Promise.all(
      [...this.live]
        .filter((id) => this.binding(id)?.botId === botId)
        .map((id) =>
          this.withLock(id, async () => {
            if (this.turnActive(id)) return;
            const error = await this.syncEngine(id);
            if (error) console.warn('[bots] model update deferred:', error);
          })
        )
    );
  }

  private async syncEngine(conversationId: string): Promise<string | undefined> {
    if (
      this.disposed ||
      !this.live.has(conversationId) ||
      this.independentSpecs.has(conversationId)
    )
      return undefined;
    const previous = this.liveProfiles.get(conversationId);
    const bot = this.deps.bots.get(this.binding(conversationId)?.botId ?? '');
    if (!previous || !bot) return undefined;
    const a = previous.engine;
    const b = bot.engine;
    if (
      a?.providerId === b?.providerId &&
      a?.modelId === b?.modelId &&
      a?.thinkingLevel === b?.thinkingLevel
    )
      return undefined;
    try {
      const result = await this.deps.runtime.updateEngine?.(conversationId, b);
      if (!result?.ok) return result?.error ?? 'model-update-failed';
      if (
        this.disposed ||
        !this.live.has(conversationId) ||
        this.liveProfiles.get(conversationId) !== previous
      )
        return 'session-unavailable';
      this.liveProfiles.set(conversationId, { ...previous, engine: b });
      // 配置可能在取凭证期间再次改变；发下一条消息前追上最后一次保存。
      return this.syncEngine(conversationId);
    } catch {
      return 'model-update-failed';
    }
  }

  async abortConversation(conversationId: string): Promise<void> {
    this.cancelQueued((item) => item.conversationId === conversationId);
    this.deps.runtime.abort?.(conversationId);
    await this.withLock(conversationId, async () => {
      this.cancelActive(conversationId);
      await this.deps.runtime.release(conversationId);
      this.live.delete(conversationId);
      this.running.delete(conversationId);
      this.slots.delete(conversationId);
    });
    this.pump();
  }

  queueState(): BotQueueItem[] {
    return this.queue.map((item, position) => ({
      chatId: item.chatId,
      botId: item.botId,
      conversationId: item.conversationId,
      position,
      ...this.queueReason(item, position),
    }));
  }

  private queueReason(item: Delivery, position: number): Pick<BotQueueItem, 'reason'> {
    const id = item.conversationId;
    if (this.turnActive(id) || this.queue.slice(0, position).some((o) => o.conversationId === id))
      return { reason: 'turn' };
    return this.runningCount() >= this.maxRunning ? { reason: 'capacity' } : {};
  }

  /** 排队原因变了的聊天（出队之外，如并发位让出后改等工作目录） */
  private changedQueueReasons(): string[] {
    const next = new Map<string, string>();
    for (const item of this.queueState()) {
      const note = `${item.conversationId}:${item.reason ?? ''}`;
      next.set(item.chatId, `${next.get(item.chatId) ?? ''}|${note}`);
    }
    const changed = [...next].filter(
      ([chatId, note]) => chatId && this.queueReasons.get(chatId) !== note
    );
    this.queueReasons = next;
    return changed.map(([chatId]) => chatId);
  }

  async stopTurn(chatId: string, botId: string): Promise<void> {
    const id = this.deps.chats.get(chatId)?.sessions[botId]?.conversationId;
    if (!id) return;
    await this.stopConversation(id, 'canceled');
    this.deps.emit({ kind: 'queue', chatId });
    this.pump();
  }

  /** 中止会话当前回合并清掉它的排队投递，回合以 reason 结算 */
  private async stopConversation(id: string, reason: string, estimated = false): Promise<void> {
    this.cancelQueued((item) => item.conversationId === id, reason);
    await this.withLock(id, async () => {
      this.deps.runtime.abort?.(id);
      this.cancelActive(id, reason, estimated);
      // 等旧 generation 结束再允许后续发送，避免迟到的完成事件污染新一轮。
      await this.deps.runtime.release(id);
      this.live.delete(id);
      this.running.delete(id);
      this.slots.delete(id);
      this.lastAssistant.delete(id);
    });
  }

  private async overBudget(
    botId: string,
    chatId: string | null,
    conversationId?: string,
    inflight = 0
  ): Promise<boolean> {
    await this.prepareBudget(botId);
    return this.budgetExceeded(botId, chatId, conversationId, inflight);
  }

  private async prepareBudget(botId: string): Promise<void> {
    await this.deps.budget?.prepare(botId).catch((error) => {
      console.warn('[bots] budget check failed', error);
    });
  }

  /** 同步判定，计入该成员其他进行中回合的预留与本回合尚未入账的 inflight；开始回合的调用方须在同一同步段里占住 slot */
  private budgetExceeded(
    botId: string,
    chatId: string | null,
    conversationId?: string,
    inflight = 0
  ): boolean {
    if (!this.deps.budget) return false;
    let verdict: BotBudgetVerdict | null = null;
    try {
      verdict = this.deps.budget.verdict(
        botId,
        this.reservedTokens(botId, conversationId) + inflight
      );
    } catch (error) {
      console.warn('[bots] budget check failed', error);
    }
    if (verdict) this.deps.emit({ kind: 'budget', ...(chatId ? { chatId } : {}) });
    return verdict !== null;
  }

  /** 该成员除 exceptId 外进行中回合尚未用掉的预留（单回合上限更小时按上限） */
  private reservedTokens(botId: string, exceptId?: string): number {
    const hold = Math.min(
      BOT_TURN_RESERVE_TOKENS,
      this.deps.bots.get(botId)?.maxTokensPerTurn ?? Number.POSITIVE_INFINITY
    );
    let total = 0;
    for (const id of new Set([...this.slots.keys(), ...this.running])) {
      if (id !== exceptId && this.binding(id)?.botId === botId)
        total += Math.max(0, hold - this.turnTally(id).tokens);
    }
    return total;
  }

  /** 本回合用量：tokens 含估算，real 只算实报，inflight 为尚未记入日账本的部分 */
  private turnTally(id: string): { tokens: number; real: number; inflight: number } {
    const tally = { tokens: 0, real: 0, inflight: 0 };
    const usage = this.turnUsage.get(id);
    if (!usage || usage.turnKey !== this.turnKeys.get(id)) return tally;
    for (const entry of usage.byIndex.values()) {
      tally.tokens += entry.tokens;
      tally.real += entry.real;
      if (!entry.settled) tally.inflight += entry.tokens;
    }
    return tally;
  }

  private noteTurnUsage(
    id: string,
    index: number,
    message: ProjectedMessage,
    final: boolean
  ): void {
    const turnKey = this.turnKeys.get(id);
    if (!turnKey) return;
    let usage = this.turnUsage.get(id);
    if (usage?.turnKey !== turnKey) {
      usage = { turnKey, byIndex: new Map() };
      this.turnUsage.set(id, usage);
    }
    const counted = messageTokens(message, final, this.contextTokens.get(id));
    usage.byIndex.set(index, { ...counted, settled: final && counted.real > 0 });
  }

  /** 回合内用量（含流式估算）超过成员单回合上限或使日预算超额：停掉这一回合 */
  private async enforceBudget(id: string, final: boolean): Promise<void> {
    const binding = this.binding(id);
    if (!binding || this.budgetChecks.has(id)) return;
    this.budgetChecks.add(id);
    try {
      const tally = this.turnTally(id);
      const cap = this.deps.bots.get(binding.botId)?.maxTokensPerTurn;
      const overCap = cap !== undefined && tally.tokens > cap;
      const reason = overCap
        ? BOT_TURN_LIMIT_ERROR
        : (
              final
                ? await this.overBudget(binding.botId, binding.chatId, id, tally.inflight)
                : this.budgetExceeded(binding.botId, binding.chatId, id, tally.inflight)
            )
          ? BOT_BUDGET_ERROR
          : undefined;
      if (!reason || !this.turnActive(id)) return;
      await this.stopConversation(id, reason, overCap && tally.real <= cap);
      if (binding.chatId) this.deps.emit({ kind: 'queue', chatId: binding.chatId });
      this.pump();
    } finally {
      this.budgetChecks.delete(id);
    }
  }

  sessionsOf(chatId: string): BotSessionRecord[] {
    const chat = this.deps.chats.get(chatId);
    const current = new Set(Object.values(chat?.sessions ?? {}).map((s) => s.conversationId));
    return this.deps.authority
      .botConversations()
      .filter((conversation) => conversation.bot?.chatId === chatId)
      .map((conversation) => ({
        conversationId: conversation.conversationId,
        botId: conversation.bot!.botId,
        lifecycle: conversation.lifecycle,
        current: current.has(conversation.conversationId),
      }));
  }

  /** 聊天工作区在本机的目录；direct 的 member-home 取唯一成员 home */
  workspacePath(chatId: string): string | undefined {
    const chat = this.deps.chats.get(chatId);
    if (!chat) return undefined;
    const workspace = this.resolveWorkspace(chat, chat.members[0]);
    return workspace.ok ? workspace.cwd : undefined;
  }

  ensureSession(
    chatId: string,
    botId: string,
    options: { fresh?: boolean } = {}
  ): { ok: true; conversationId: string } | Fail {
    const chat = this.deps.chats.get(chatId);
    if (!chat) return { ok: false, error: 'chat-not-found' };
    if (!chat.members.includes(botId)) return { ok: false, error: 'not-member' };
    const bot = this.deps.bots.get(botId);
    if (!bot) return { ok: false, error: 'bot-not-found' };
    if (bot.archivedAt !== undefined) return { ok: false, error: 'bot-archived' };
    const workspace = this.resolveWorkspace(chat, botId);
    if (!workspace.ok) return workspace;
    const current = chat.sessions[botId];
    const existing = current && this.deps.authority.conversation(current.conversationId);
    if (
      !options.fresh &&
      existing &&
      existing.lifecycle !== 'ended' &&
      existing.projectId === workspace.projectId &&
      existing.bot?.botId === botId &&
      existing.bot.chatId === chatId
    ) {
      return { ok: true, conversationId: existing.conversationId };
    }
    if (current) this.retireSession(current.conversationId);
    const binding = { botId, chatId };
    const created = this.deps.authority.createBotConversation(workspace.projectId, binding);
    if (!created) return { ok: false, error: 'authority-unavailable' };
    this.bindings.set(created.conversationId, binding);
    const cursor = this.deps.chats.lastSeq(chatId);
    const updated = this.deps.chats.update(chatId, (draft) => {
      draft.sessions[botId] = { conversationId: created.conversationId, cursor };
      return draft;
    });
    if (!updated) {
      this.deps.authority.removeBotConversation(created.conversationId);
      return { ok: false, error: 'chat-update-failed' };
    }
    this.deps.emit({ kind: 'chat', chatId });
    return { ok: true, conversationId: created.conversationId };
  }

  /** 返回 ok 前确认命令已交给 worker；排队时 queued=true，之后失败经 onTurnFinished 回报 */
  async deliver(
    chatId: string,
    botId: string,
    text: string,
    options: BotDeliverOptions = {}
  ): Promise<BotDeliverResult> {
    if (this.disposed) return { ok: false, error: 'disabled' };
    const session = this.ensureSession(chatId, botId);
    if (!session.ok) return session;
    const { conversationId } = session;
    return this.deliverConversation(conversationId, text, options);
  }

  async deliverConversation(
    conversationId: string,
    text: string,
    options: BotDeliverOptions = {}
  ): Promise<BotDeliverResult> {
    if (this.disposed) return { ok: false, error: 'disabled' };
    const binding = this.binding(conversationId);
    if (!binding) return { ok: false, error: 'not-bot-session' };
    const { botId } = binding;
    const chatId = binding.chatId ?? '';
    const delivery: Delivery = { ...options, chatId, botId, conversationId, text };
    return this.withLock(conversationId, async (): Promise<BotDeliverResult> => {
      if (this.disposed) return { ok: false, error: 'disabled' };
      if (options.deliveryId) {
        if (this.hasStartedDelivery(conversationId, options.deliveryId))
          return { ok: true, conversationId, duplicate: true };
        if (
          this.deliveries.get(conversationId)?.has(options.deliveryId) ||
          this.queue.some(
            (item) =>
              item.conversationId === conversationId && item.deliveryId === options.deliveryId
          )
        )
          return { ok: true, conversationId, queued: true };
      }
      if (
        options.onlyIfIdle &&
        (this.isBusy(conversationId) || this.runningCount() >= this.maxRunning)
      )
        return { ok: false, error: 'session-busy' };
      await this.prepareBudget(botId);
      if (this.budgetExceeded(botId, binding.chatId, conversationId))
        return { ok: false, error: BOT_BUDGET_ERROR };
      if (this.turnActive(conversationId) && !options.queueIfBusy) {
        if (!this.retrying.has(conversationId)) return this.steer(delivery);
        // 自动重试倒计时里没有活轮可插：排到下一轮，不打断重试
        delivery.queueIfBusy = true;
      }
      if (
        this.turnActive(conversationId) ||
        this.queue.some((item) => item.conversationId === conversationId) ||
        this.runningCount() >= this.maxRunning
      ) {
        this.queue = enqueueByLane(this.queue, delivery);
        this.deps.emit({ kind: 'queue', chatId });
        return { ok: true, conversationId, queued: true };
      }
      const started = await this.start(delivery);
      if (!started.ok) this.pump();
      return started;
    });
  }

  /** 工作区变更 / 成员移出：结束旧会话（只读保留），下次投递开新会话 */
  resetSessions(chatId: string, botIds?: readonly string[]): void {
    const chat = this.deps.chats.get(chatId);
    if (!chat) return;
    const targets = Object.keys(chat.sessions).filter((id) => !botIds || botIds.includes(id));
    if (targets.length === 0) return;
    for (const botId of targets) this.retireSession(chat.sessions[botId].conversationId);
    this.deps.chats.update(chatId, (draft) => {
      for (const botId of targets) delete draft.sessions[botId];
      return draft;
    });
    this.deps.emit({ kind: 'chat', chatId });
  }

  /** 删除聊天：会话记录、会话文件、独立工作区与聊天目录一并清理 */
  discardChat(chatId: string): boolean {
    const chat = this.deps.chats.get(chatId);
    if (!chat) return false;
    for (const listener of this.discardListeners) listener({ chatId });
    for (const conversation of this.deps.authority.botConversations()) {
      if (conversation.bot?.chatId === chatId) this.discardConversation(conversation);
    }
    // 改选过工作区的群也可能留有独立目录项目，按路径找
    const home = this.deps.authority.botHomeProject(this.deps.chats.workspaceDir(chatId));
    if (home) this.deps.authority.removeBotHomeProject(home.projectId);
    this.deps.chats.remove(chatId);
    this.deps.emit({ kind: 'chat', chatId });
    return true;
  }

  /** 彻底删除成员：群主须先换人；私聊、委派会话、成员 home 一并删除，群里的发言保留 */
  discardBot(botId: string): { ok: true } | { ok: false; reason: string; chatIds?: string[] } {
    if (!this.deps.bots.get(botId)) return { ok: false, reason: 'not-found' };
    const chats = this.deps.chats.list();
    const bossOf = chats.filter((chat) => chat.bossBotId === botId).map((chat) => chat.id);
    if (bossOf.length > 0) return { ok: false, reason: 'boss', chatIds: bossOf };
    for (const listener of this.discardListeners) listener({ botId });
    for (const chat of chats) {
      if (chat.kind === 'direct' && chat.members.includes(botId)) this.discardChat(chat.id);
      else if (chat.sessions[botId]) this.resetSessions(chat.id, [botId]);
    }
    for (const conversation of this.deps.authority.botConversations()) {
      if (conversation.bot?.botId === botId && conversation.bot.chatId === null) {
        this.discardConversation(conversation);
      }
    }
    const home = this.deps.authority.botHomeProject(this.deps.bots.homeDir(botId));
    if (home) this.deps.authority.removeBotHomeProject(home.projectId);
    this.deps.bots.remove(botId);
    this.deps.emit({ kind: 'catalog' });
    return { ok: true };
  }

  observe(event: AgentWorkerEvent | { type: 'worker-exited' }): void {
    if (this.disposed) return;
    if (event.type === 'worker-exited') {
      const interrupted = [...this.slots.keys()];
      for (const id of [...this.settleTimers.keys()]) this.cancelSettle(id);
      this.live.clear();
      this.running.clear();
      this.slots.clear();
      this.lastAssistant.clear();
      this.waiting.clear();
      this.retrying.clear();
      for (const id of [...this.lastOutput.keys()]) this.quiet(id);
      for (const id of interrupted)
        this.finish(id, undefined, false, 'worker-exited', '', undefined, true);
      this.pump();
      return;
    }
    if (!('identity' in event) || !event.identity) return;
    this.noteOutput(event);
    if ('parent' in event.identity) return;
    const id = event.identity.sessionId;
    if (!this.isBotConversation(id)) return;
    switch (event.type) {
      case 'status': {
        const slot = this.slots.get(id);
        this.retrying.delete(id);
        if (event.status === 'running') {
          this.cancelSettle(id);
          if (!this.running.has(id) && !slot?.sawRunning) this.lastAssistant.delete(id);
          this.running.add(id);
          if (slot) slot.sawRunning = true;
          this.deliveryStarted(id);
          return;
        }
        this.running.delete(id);
        // idle 先于 turn-completed 到达，正常由后者结算；中断等路径只有 idle/failed，到期兜底
        if (slot && (slot.sawRunning || event.status === 'failed'))
          this.scheduleSettle(id, slot, event.status === 'failed' ? event.error : undefined);
        else if (!slot) this.pump();
        return;
      }
      case 'message-upsert': {
        if (event.message.role !== 'assistant') return;
        const previous = this.lastAssistant.get(id);
        if (previous && event.index < previous.index) return;
        const text = event.message.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('');
        this.lastAssistant.set(id, {
          index: event.index,
          text,
          ...(event.message.stopReason ? { stopReason: event.message.stopReason } : {}),
          ...(event.message.errorMessage ? { errorMessage: event.message.errorMessage } : {}),
          ...(event.message.model ? { model: event.message.model } : {}),
        });
        const binding = this.binding(id);
        const usage = event.message.usage;
        // pi 的流式中间态也带 stopReason；live 消息以 message_end 打上的 completedMs 为准
        const final =
          event.message.stopReason !== undefined &&
          usage !== undefined &&
          (event.message.timing === undefined || event.message.timing.completedMs !== undefined);
        if (!binding) return;
        if (final) this.deps.budget?.record?.(binding.botId, id, event.index, event.message);
        const capped = this.deps.bots.get(binding.botId)?.maxTokensPerTurn !== undefined;
        if (!this.turnActive(id)) return;
        this.noteTurnUsage(id, event.index, event.message, final);
        if (this.deps.budget || capped) void this.enforceBudget(id, final);
        return;
      }
      case 'session-meta': {
        if (event.occupancy) this.contextTokens.set(id, event.occupancy.used);
        return;
      }
      case 'turn-retry':
        if (this.turnActive(id)) this.retrying.add(id);
        return;
      case 'turn-completed': {
        if (!this.turnActive(id)) return;
        this.deliveryStarted(id);
        const last = this.lastAssistant.get(id);
        const failed = last?.stopReason === 'error' || last?.stopReason === 'aborted';
        this.running.delete(id);
        this.finish(
          id,
          event.turnId,
          !failed,
          failed ? (last?.errorMessage ?? last?.stopReason) : undefined,
          last?.text ?? event.digest?.assistantText ?? '',
          undefined,
          last?.stopReason === 'aborted'
        );
        this.lastAssistant.delete(id);
        this.release(id);
        return;
      }
      case 'turn-failed':
        if (!this.turnActive(id)) return;
        this.running.delete(id);
        this.finish(id, event.turnId, false, event.error, this.lastAssistant.get(id)?.text ?? '');
        this.lastAssistant.delete(id);
        this.release(id);
        return;
      case 'parent-ended':
      case 'parent-rejected': {
        const hadSlot = this.slots.has(id);
        this.live.delete(id);
        this.running.delete(id);
        this.retrying.delete(id);
        this.lastAssistant.delete(id);
        if (hadSlot) {
          this.finish(id, undefined, false, event.reason);
          this.release(id);
        }
        return;
      }
      default:
        return;
    }
  }

  private binding(conversationId: string): ConversationBotBinding | null {
    const cached = this.bindings.get(conversationId);
    if (cached !== undefined) return cached;
    const binding = this.deps.authority.conversation(conversationId)?.bot ?? null;
    if (binding) this.bindings.set(conversationId, binding);
    return binding;
  }

  private turnActive(conversationId: string): boolean {
    return this.slots.has(conversationId) || this.running.has(conversationId);
  }

  /** 当前处于静默的运行中轮次 */
  silences(): BotSilence[] {
    return [...this.silent].flatMap(([conversationId, since]) => {
      const binding = this.binding(conversationId);
      return binding
        ? [
            {
              conversationId,
              chatId: binding.chatId,
              botId: binding.botId,
              ...(binding.delegationId ? { delegationId: binding.delegationId } : {}),
              since,
            },
          ]
        : [];
    });
  }

  /** 看门狗巡检：由定时器驱动，测试可直接调用 */
  checkSilence(): void {
    const now = this.now();
    const limit = this.deps.silenceMs ?? BOT_SILENCE_MS;
    for (const [id, at] of this.lastOutput) {
      if (!this.turnActive(id)) this.quiet(id);
      else if (!this.waiting.get(id)?.size && !this.silent.has(id) && now - at >= limit) {
        this.silent.set(id, at);
        this.emitSilence(id);
      }
    }
    if (this.lastOutput.size === 0) this.stopWatchdog();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** 任何流式事件、工具进度或子代理事件都算本会话的输出 */
  private noteOutput(event: AgentWorkerEvent): void {
    if (!('identity' in event) || !event.identity) return;
    const identity = event.identity;
    const raw = 'parent' in identity ? identity.parent.sessionId : identity.sessionId;
    const sep = raw.indexOf('::');
    const id = sep === -1 ? raw : raw.slice(0, sep);
    if (!this.turnActive(id)) return;
    if (event.type === 'approval-request' || event.type === 'ask-request') {
      const requestId =
        event.type === 'approval-request' ? event.request.requestId : event.ask.requestId;
      const set = this.waiting.get(id) ?? new Set();
      set.add(requestId);
      this.waiting.set(id, set);
    } else if (event.type === 'approval-resolved' || event.type === 'ask-resolved') {
      this.waiting.get(id)?.delete(event.requestId);
    }
    this.touch(id);
  }

  private touch(id: string): void {
    this.lastOutput.set(id, this.now());
    if (this.silent.delete(id)) this.emitSilence(id);
    if (!this.watchdog && !this.disposed) {
      const limit = this.deps.silenceMs ?? BOT_SILENCE_MS;
      this.watchdog = setInterval(() => this.checkSilence(), Math.min(5_000, limit / 6));
      this.watchdog.unref?.();
    }
  }

  /** 轮次结束：不再巡检，已静默的撤销 */
  private quiet(id: string): void {
    this.lastOutput.delete(id);
    this.waiting.delete(id);
    if (this.silent.delete(id)) this.emitSilence(id);
  }

  private emitSilence(id: string): void {
    const chatId = this.binding(id)?.chatId;
    this.deps.emit({ kind: 'silence', ...(chatId ? { chatId } : {}), conversationId: id });
  }

  private stopWatchdog(): void {
    clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private notesFor(conversationId: string, botId: string): BotNotesSnapshot | undefined {
    if (!this.deps.notes) return undefined;
    const chatId = this.deps.authority.conversation(conversationId)?.bot?.chatId;
    const chat = chatId ? this.deps.chats.get(chatId) : undefined;
    return this.deps.notes.snapshot(botId, chat?.kind === 'group' ? chat.id : null);
  }

  /** 运行中会话的笔记变了：在本次投递前追加一次 <notes-updated> */
  private withNotesUpdate(
    delivery: Delivery,
    text = delivery.text
  ): { text: string; seen?: string } {
    const snap = this.notesFor(delivery.conversationId, delivery.botId);
    if (!snap || snap.version === (this.notesSeen.get(delivery.conversationId) ?? ''))
      return { text };
    return {
      text: snap.update ? `${snap.update}\n\n${text}` : text,
      seen: snap.version,
    };
  }

  private steer(delivery: Delivery): BotDeliverResult {
    const notes = this.withNotesUpdate(
      delivery,
      delivery.source === 'human'
        ? wrapInterjection(delivery.text, this.deps.language?.() ?? 'zh')
        : delivery.text
    );
    const sent = this.deps.runtime.steer(
      delivery.conversationId,
      notes.text,
      delivery.images,
      delivery.deliveryId
    );
    if (sent.ok && notes.seen !== undefined)
      this.notesSeen.set(delivery.conversationId, notes.seen);
    if (sent.ok) this.deliverySent(delivery);
    return sent.ok
      ? { ok: true, conversationId: delivery.conversationId }
      : { ok: false, error: sent.error ?? 'steer-failed' };
  }

  private async start(delivery: Delivery): Promise<BotDeliverResult> {
    if (this.disposed) return { ok: false, error: 'disabled' };
    const { conversationId } = delivery;
    const bot = this.usableBot(delivery);
    if (!bot) return { ok: false, error: 'session-unavailable' };
    this.slots.set(conversationId, { sawRunning: false });
    this.turnKeys.set(conversationId, randomUUID());
    this.lastAssistant.delete(conversationId);
    this.touch(conversationId);
    if (delivery.deliveryId) this.activeDeliveries.set(conversationId, delivery.deliveryId);
    else this.activeDeliveries.delete(conversationId);
    const fail = (error: string): Fail => {
      this.slots.delete(conversationId);
      this.quiet(conversationId);
      return { ok: false, error };
    };
    let notes: { text: string; seen?: string } = { text: delivery.text };
    if (!this.live.has(conversationId)) {
      const spawned = await this.spawnLive(delivery, bot);
      if (spawned) return fail(spawned);
    } else {
      const error = await this.syncEngine(conversationId);
      if (error) return fail(error);
      notes = this.withNotesUpdate(delivery);
    }
    const sent = this.deps.runtime.prompt(
      conversationId,
      notes.text,
      delivery.images,
      delivery.deliveryId
    );
    if (!sent.ok) return fail(sent.error ?? 'prompt-failed');
    if (notes.seen !== undefined) this.notesSeen.set(conversationId, notes.seen);
    this.deliverySent(delivery);
    return { ok: true, conversationId };
  }

  /** 会话仍可用（未结束、成员未归档、项目在、仍在聊天里）时返回成员档案 */
  private usableBot(delivery: Delivery): BotProfile | undefined {
    const conversation = this.deps.authority.conversation(delivery.conversationId);
    const bot = this.deps.bots.get(delivery.botId);
    const chat = conversation?.bot?.chatId
      ? this.deps.chats.get(conversation.bot.chatId)
      : undefined;
    if (
      !conversation ||
      conversation.lifecycle === 'ended' ||
      !bot ||
      bot.archivedAt !== undefined ||
      this.deps.authority.project(conversation.projectId)?.state !== 'active' ||
      (conversation.bot?.chatId &&
        (!chat || chat.archivedAt !== undefined || !chat.members.includes(bot.id)))
    )
      return undefined;
    return bot;
  }

  /** spawn（带 resumeFile 恢复）并登记为 live；失败返回错误码 */
  private async spawnLive(delivery: Delivery, bot: BotProfile): Promise<string | undefined> {
    const { conversationId } = delivery;
    const spec = this.spawnSpec(delivery);
    if (!spec.ok) return spec.error;
    if (spec.spec.bot.tools === 'all')
      spec.spec = {
        ...spec.spec,
        writeLock: { label: spec.spec.bot.name, ancestors: this.ancestors(conversationId) },
      };
    const snap = this.notesFor(conversationId, bot.id);
    if (snap?.section)
      spec.spec = {
        ...spec.spec,
        systemPrompt: `${spec.spec.systemPrompt}\n\n${snap.section}`,
      };
    const spawned = await this.deps.runtime.spawn(spec.spec);
    if (!spawned.ok) return spawned.error ?? 'spawn-failed';
    if (this.disposed || this.deps.authority.conversation(conversationId)?.lifecycle === 'ended') {
      await this.deps.runtime.release(conversationId);
      return this.disposed ? 'disabled' : 'canceled';
    }
    this.liveProfiles.set(conversationId, spec.spec.bot);
    this.live.add(conversationId);
    this.notesSeen.set(conversationId, snap?.version ?? '');
    return undefined;
  }

  /** 回退 / 重试的公共前置：会话空闲、可用，且已在 worker 里（冷会话只恢复不 prompt）；delegation 只认已登记的委派子会话 */
  private async controllable(conversationId: string, delegation = false): Promise<Delivery | Fail> {
    if (this.disposed) return { ok: false, error: 'disabled' };
    const binding = this.binding(conversationId);
    if (
      !binding ||
      (delegation
        ? !binding.delegationId || !this.independentSpecs.has(conversationId)
        : !binding.chatId || binding.delegationId)
    )
      return { ok: false, error: 'not-bot-session' };
    if (this.isBusy(conversationId)) return { ok: false, error: 'session-busy' };
    const delivery: Delivery = {
      chatId: binding.chatId ?? '',
      botId: binding.botId,
      conversationId,
      text: '',
    };
    const bot = this.usableBot(delivery);
    if (!bot) return { ok: false, error: 'session-unavailable' };
    if (!this.live.has(conversationId)) {
      const failed = await this.spawnLive(delivery, bot);
      if (failed) return { ok: false, error: failed };
    }
    const error = await this.syncEngine(conversationId);
    if (error) return { ok: false, error };
    return delivery;
  }

  /** 私聊回退：只在空闲时执行；正文与草稿经 worker 的 rewind-done 事件回流 */
  rewindConversation(
    conversationId: string,
    entryId: string,
    restoreFiles: boolean
  ): Promise<{ ok: true } | Fail> {
    return this.withLock(conversationId, async () => {
      const ready = await this.controllable(conversationId);
      if ('ok' in ready) return ready;
      if (!this.deps.runtime.rewind) return { ok: false, error: 'unsupported' };
      const sent = this.deps.runtime.rewind(conversationId, entryId, restoreFiles);
      if (!sent.ok) return { ok: false, error: sent.error ?? 'rewind-failed' };
      this.lastAssistant.delete(conversationId);
      return { ok: true };
    });
  }

  /** 私聊 / 委派续跑：像一次投递那样占用回合（新 turnKey、计入并发、正常结算） */
  retryConversation(
    conversationId: string,
    options: { delegation?: boolean } = {}
  ): Promise<BotDeliverResult> {
    return this.withLock(conversationId, async (): Promise<BotDeliverResult> => {
      if (this.runningCount() >= this.maxRunning) return { ok: false, error: 'session-busy' };
      const ready = await this.controllable(conversationId, options.delegation);
      if ('ok' in ready) return ready;
      if (!this.deps.runtime.retry) return { ok: false, error: 'unsupported' };
      if (await this.overBudget(ready.botId, ready.chatId || null))
        return { ok: false, error: BOT_BUDGET_ERROR };
      const slot = { sawRunning: false };
      this.slots.set(conversationId, slot);
      this.turnKeys.set(conversationId, randomUUID());
      this.lastAssistant.delete(conversationId);
      this.activeDeliveries.delete(conversationId);
      this.touch(conversationId);
      const sent = this.deps.runtime.retry(conversationId);
      if (!sent.ok) {
        this.slots.delete(conversationId);
        this.turnKeys.delete(conversationId);
        this.quiet(conversationId);
        return { ok: false, error: sent.error ?? 'retry-failed' };
      }
      // worker 认为无需续跑时不会进入 running：宽限期后按未运行结算，回合不悬挂
      this.scheduleSettle(conversationId, slot, 'nothing-to-retry');
      return { ok: true, conversationId };
    });
  }

  private deliverySent(delivery: Delivery): void {
    if (!delivery.deliveryId) return;
    this.rememberDelivery(delivery.conversationId, delivery.deliveryId, 'sent');
    for (const listener of this.sentListeners)
      listener({ conversationId: delivery.conversationId, deliveryId: delivery.deliveryId });
  }

  private rememberDelivery(
    conversationId: string,
    deliveryId: string,
    state: 'sent' | 'started'
  ): void {
    const records = this.deliveries.get(conversationId) ?? new Map();
    if (records.get(deliveryId) !== 'started') records.set(deliveryId, state);
    this.deliveries.set(conversationId, records);
  }

  private deliveryStarted(conversationId: string): void {
    const deliveryId = this.activeDeliveries.get(conversationId);
    if (!deliveryId || this.deliveries.get(conversationId)?.get(deliveryId) === 'started') return;
    this.rememberDelivery(conversationId, deliveryId, 'started');
    for (const listener of this.startedListeners) listener({ conversationId, deliveryId });
  }

  private spawnSpec(delivery: Delivery): { ok: true; spec: BotSpawnSpec } | Fail {
    const independent = this.independentSpecs.get(delivery.conversationId);
    if (independent) return { ok: true, spec: independent };
    const chat = this.deps.chats.get(delivery.chatId);
    const bot = this.deps.bots.get(delivery.botId);
    const conversation = this.deps.authority.conversation(delivery.conversationId);
    if (!chat || !bot || !conversation || conversation.lifecycle === 'ended') {
      return { ok: false, error: 'session-unavailable' };
    }
    const workspace = this.resolveWorkspace(chat, bot.id);
    if (!workspace.ok) return workspace;
    if (workspace.projectId !== conversation.projectId) {
      return { ok: false, error: 'workspace-changed' };
    }
    const roster = chat.members
      .map((id) => this.deps.bots.get(id))
      .filter((member): member is BotProfile => member !== undefined);
    return {
      ok: true,
      spec: {
        conversationId: conversation.conversationId,
        projectId: conversation.projectId,
        cwd: workspace.cwd,
        ...(conversation.sessionFile ? { resumeFile: conversation.sessionFile } : {}),
        bot,
        systemPrompt: buildBotSystemPrompt(bot, this.deps.bots.readPersona(bot.id)),
        instructionText: buildBotModeInstruction({ self: bot, kind: chat.kind, roster }),
        ...(chat.kind === 'group' ? { groupTasks: true } : {}),
        routines: true,
      },
    };
  }

  private release(conversationId: string): void {
    this.cancelSettle(conversationId);
    this.retrying.delete(conversationId);
    this.turnKeys.delete(conversationId);
    this.quiet(conversationId);
    if (!this.slots.delete(conversationId)) return;
    const botId = this.binding(conversationId)?.botId;
    if (botId) void this.refreshModel(botId);
    this.pump();
  }

  private scheduleSettle(id: string, slot: { sawRunning: boolean }, error?: string): void {
    this.cancelSettle(id);
    const timer = setTimeout(() => {
      this.settleTimers.delete(id);
      if (this.disposed || this.slots.get(id) !== slot || this.running.has(id)) return;
      this.finish(
        id,
        undefined,
        false,
        error ?? 'interrupted',
        this.lastAssistant.get(id)?.text,
        undefined,
        error === undefined
      );
      this.lastAssistant.delete(id);
      this.release(id);
    }, this.settleGraceMs);
    timer.unref?.();
    this.settleTimers.set(id, timer);
  }

  private cancelSettle(id: string): void {
    clearTimeout(this.settleTimers.get(id));
    this.settleTimers.delete(id);
  }

  private pump(): void {
    if (this.disposed) return;
    const touched = new Set<string>();
    while (this.queue.length > 0) {
      const index = this.queue.findIndex((item) => this.dequeueable(item));
      if (index < 0) break;
      const next = this.queue[index];
      const active = this.turnActive(next.conversationId);
      if (!active && this.runningCount() >= this.maxRunning) break;
      this.queue.splice(index, 1);
      touched.add(next.chatId);
      if (active) {
        // 走同一把锁：同会话前一条可能还在 spawn
        void this.withLock(next.conversationId, async () => {
          const steered = this.steer(next);
          if (!steered.ok)
            this.finish(
              next.conversationId,
              undefined,
              false,
              steered.error,
              '',
              next.deliveryId ?? null
            );
        });
        continue;
      }
      this.slots.set(next.conversationId, { sawRunning: false });
      if (next.deliveryId) this.activeDeliveries.set(next.conversationId, next.deliveryId);
      void this.withLock(next.conversationId, async () => {
        await this.prepareBudget(next.botId);
        // 预算备好后才让出占位：期间别的投递抢不走并发位与工作区写锁
        this.slots.delete(next.conversationId);
        const started: BotDeliverResult = this.budgetExceeded(
          next.botId,
          next.chatId || null,
          next.conversationId
        )
          ? { ok: false, error: BOT_BUDGET_ERROR }
          : await this.start(next);
        if (!started.ok) {
          this.finish(
            next.conversationId,
            undefined,
            false,
            started.error,
            '',
            next.deliveryId ?? null
          );
          this.pump();
        }
      });
    }
    for (const chatId of this.changedQueueReasons()) touched.add(chatId);
    for (const chatId of touched) this.deps.emit({ kind: 'queue', chatId });
  }

  /** 活轮里可 steer 的插话（重试倒计时中改排下一轮），或可开的新轮 */
  private dequeueable(item: Delivery): boolean {
    if (!this.turnActive(item.conversationId)) return true;
    if (this.retrying.has(item.conversationId)) item.queueIfBusy = true;
    return !item.queueIfBusy;
  }

  /** 委派链上的祖先会话：worker 写协调里子委派与祖先互不阻塞，父轮等子结果时不会死锁 */
  private ancestors(id: string): string[] {
    const chain: string[] = [];
    for (
      let parent = this.origins.get(id)?.parentConversationId;
      parent && parent !== id && !chain.includes(parent);
      parent = this.origins.get(parent)?.parentConversationId
    )
      chain.push(parent);
    return chain;
  }

  private finish(
    conversationId: string,
    turnId: string | undefined,
    ok: boolean,
    error?: string,
    text = '',
    deliveryId: string | null | undefined = this.activeDeliveries.get(conversationId),
    stopped = false,
    estimated = false
  ): void {
    const binding = this.binding(conversationId);
    if (!binding) return;
    const turnKey = this.turnKeys.get(conversationId);
    const model = this.lastAssistant.get(conversationId)?.model;
    const event: BotTurnFinished = {
      ...(deliveryId ? { deliveryId } : {}),
      chatId: binding.chatId,
      botId: binding.botId,
      conversationId,
      ...(turnId ? { turnId } : {}),
      text,
      ok,
      ...(error ? { error } : {}),
      ...(binding.delegationId ? { delegationId: binding.delegationId } : {}),
      ...(turnKey ? { turnKey } : {}),
      ...(stopped ? { stopped: true as const } : {}),
      ...(estimated ? { estimated: true as const } : {}),
      ...(model ? { model } : {}),
    };
    if (deliveryId === this.activeDeliveries.get(conversationId))
      this.activeDeliveries.delete(conversationId);
    if (deliveryId && this.deliveries.get(conversationId)?.get(deliveryId) !== 'started')
      this.deliveries.get(conversationId)?.delete(deliveryId);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (cause) {
        console.warn('[bots] turn listener failed', cause);
      }
    }
  }

  /** 结束会话（只读保留）并释放 worker 里的实例；丢弃它的排队投递 */
  retireSession(conversationId: string): void {
    this.cancelQueued((item) => item.conversationId === conversationId);
    this.cancelActive(conversationId);
    if (this.live.has(conversationId) || this.slots.has(conversationId)) {
      void this.deps.runtime.release(conversationId).catch(() => {});
    }
    this.live.delete(conversationId);
    this.clearSession(conversationId);
    this.deps.authority.endBotConversation(conversationId);
    this.pump();
  }

  freeze(): void {
    this.disposed = true;
    this.stopWatchdog();
  }

  dispose(): void {
    this.freeze();
    this.cancelQueued(() => true);
    for (const id of new Set([...this.live, ...this.slots.keys()])) {
      this.cancelActive(id);
      this.deps.runtime.abort?.(id);
      void this.deps.runtime.release(id).catch(console.warn);
      this.clearSession(id);
    }
    this.live.clear();
    this.bindings.clear();
    this.independentSpecs.clear();
    this.origins.clear();
    this.liveProfiles.clear();
    this.listeners.clear();
    this.discardListeners.clear();
    this.sentListeners.clear();
    this.startedListeners.clear();
    this.deliveries.clear();
  }

  private cancelQueued(predicate: (item: Delivery) => boolean, reason = 'canceled'): void {
    const canceled = this.queue.filter(predicate);
    this.queue = this.queue.filter((item) => !predicate(item));
    for (const item of canceled) {
      this.finish(item.conversationId, undefined, false, reason, '', item.deliveryId ?? null);
      this.deps.emit({ kind: 'queue', chatId: item.chatId });
    }
  }

  private cancelActive(id: string, reason = 'canceled', estimated = false): void {
    this.cancelSettle(id);
    this.retrying.delete(id);
    if (this.turnActive(id))
      this.finish(
        id,
        undefined,
        false,
        reason,
        '',
        undefined,
        reason !== BOT_BUDGET_ERROR && reason !== BOT_TURN_LIMIT_ERROR,
        estimated
      );
    this.running.delete(id);
    this.slots.delete(id);
    this.lastAssistant.delete(id);
    this.quiet(id);
  }

  private clearSession(id: string): void {
    this.cancelSettle(id);
    this.retrying.delete(id);
    this.turnUsage.delete(id);
    this.contextTokens.delete(id);
    this.running.delete(id);
    this.slots.delete(id);
    this.lastAssistant.delete(id);
    this.quiet(id);
    this.activeDeliveries.delete(id);
    this.bindings.delete(id);
    this.independentSpecs.delete(id);
    this.liveProfiles.delete(id);
    this.deliveries.delete(id);
    this.origins.delete(id);
  }

  private discardConversation(conversation: ConversationAuthority): void {
    for (const listener of this.discardListeners)
      listener({ conversationId: conversation.conversationId });
    this.retireSession(conversation.conversationId);
    const removed = this.deps.authority.removeBotConversation(conversation.conversationId);
    if (removed) this.deps.runtime.removeSessionFiles(removed);
    if (removed?.sessionFile) this.persistedStarts.forget(removed.sessionFile);
  }

  private resolveWorkspace(chat: BotChat, botId: string | undefined): Workspace {
    const { authority } = this.deps;
    switch (chat.workspace.kind) {
      case 'member-home': {
        if (!botId) return { ok: false, error: 'workspace-unavailable' };
        const project = authority.ensureBotHomeProject(this.deps.bots.homeDir(botId));
        return project
          ? { ok: true, cwd: project.canonicalPath, projectId: project.projectId }
          : { ok: false, error: 'workspace-unavailable' };
      }
      case 'chat-home': {
        const project = authority.ensureBotHomeProject(this.deps.chats.workspaceDir(chat.id));
        if (!project) return { ok: false, error: 'workspace-unavailable' };
        if (project.projectId !== chat.workspace.projectId) {
          this.deps.chats.update(chat.id, (draft) => {
            draft.workspace = { kind: 'chat-home', projectId: project.projectId };
            return draft;
          });
        }
        return { ok: true, cwd: project.canonicalPath, projectId: project.projectId };
      }
      case 'project': {
        const project = authority.project(chat.workspace.projectId);
        if (project?.state !== 'active') return { ok: false, error: 'workspace-unavailable' };
        if (project.kind === 'ssh' || project.kind === 'bot-home') {
          return { ok: false, error: 'workspace-unsupported' };
        }
        return { ok: true, cwd: project.canonicalPath, projectId: project.projectId };
      }
    }
  }

  private async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => {});
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }
}
