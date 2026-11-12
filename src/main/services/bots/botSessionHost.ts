import { randomUUID } from 'node:crypto';
import { normalizeBotMaxRunningTurns } from '../../../shared/bots/concurrency';
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
import type { MemberTaskClassifier } from './memberTaskClassifier';
import { isModelFailure, type ModelProbeResult } from './modelProbe';
import { StartedDeliveryIndex } from './startedDeliveries';
import { messageTokens } from './turnTokens';

/** 运行中的轮次超过该时长没有任何输出（流式、工具进度、子代理）即视为静默 */
export const BOT_SILENCE_MS = 5 * 60_000;
/** 委派执行登记卡住后迟迟不收尾时的软停止：只中止当前回合，不算用户停止 */
export const BOT_BLOCKED_STOP = 'blocked-stop';
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
  reopenBotConversation(conversationId: string): ConversationAuthority | undefined;
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
  /** 群聊成员会话且讨论模式（实验性）开启：delegate 工具说明加讨论接力句 */
  discussMode?: boolean;
  /** 私聊 / 群聊成员会话（委派会话走 independentSpecs，不挂）：挂 routine_propose */
  routines?: boolean;
  /** 写成员：worker 内同工作区按文件占用、全局命令短独占；ancestors 为委派链祖先会话 */
  writeLock?: { label: string; ancestors: string[] };
  /** 挂看板任务的委派会话：挂 report_blocked */
  delegationTask?: boolean;
  /**
   * 这次 spawn 的实例号（UUID，每次 spawn 新生成）。随 spawn-parent 下发，之后同会话的 prompt / steer / retry
   * 都带它；worker 在 parent-rejected / parent-ended 里回显，宿主据此确定结束事件属于哪个实例
   */
  instanceId: string;
}

/** spawn 规格里与具体实例无关的部分；实例号在每次 spawn 时现生成 */
type BotSpawnTemplate = Omit<BotSpawnSpec, 'instanceId'>;

export interface BotRuntimePort {
  updateEngine?(conversationId: string, engine?: BotEngine): Promise<ActionResult>;
  spawn(spec: BotSpawnSpec): Promise<ActionResult>;
  prompt(
    conversationId: string,
    text: string,
    images?: AttachedImage[],
    deliveryId?: string,
    /** 带新消息的断点续跑（见 BotDeliverOptions.resume） */
    resume?: true
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
  classifyMemberTask?: MemberTaskClassifier;
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
  /**
   * 投递前实测完整模型链；回退配置只用于本次投递，不修改成员档案。
   * 成员与默认均不可用才拒绝，error 为可读原因。
   */
  probe?: (bot: BotProfile) => Promise<ModelProbeResult>;
  /** 真实投递报模型类错误：作废该成员的测通缓存 */
  invalidateProbe?: (bot: BotProfile) => void;
  /** 静默看门狗阈值，缺省 BOT_SILENCE_MS */
  silenceMs?: number;
  now?: () => number;
  /** 界面语言：人类插话补充说明用，缺省中文 */
  language?: () => 'zh' | 'en';
  /** 讨论模式（实验性）总开关，缺省关闭：决定群聊成员会话的 Bot 说明与 delegate 文案 */
  discussEnabled?: () => boolean;
}

/** 委派会话的来源：工作区写锁沿委派链共用，等待提示落到发起委派的群 */
export interface BotDelegationOrigin {
  parentConversationId: string;
  chatId: string | null;
  /** 执行挂着看板任务（深度 1）：会话挂 report_blocked */
  task?: true;
}

export interface BotDeliverOptions {
  images?: AttachedImage[];
  deliveryId?: string;
  queueIfBusy?: boolean;
  /** 缺省 bot：人类插话才加补充说明 */
  source?: BotDeliverySource;
  onlyIfIdle?: boolean;
  /**
   * 带新消息的断点续跑（委派续跑附说明 / 验收原因 / 群背景新增）：开新轮时 worker 先按 retry 的语义
   * 移出未完成的最后一条 assistant 再 prompt。只对开新轮生效，插话（steer）不带。
   */
  resume?: true;
}

export type BotDeliverResult =
  | {
      ok: true;
      conversationId: string;
      queued?: boolean;
      /** 已按 steer 下发，不另建宿主轮次；不是 worker 已消费的回执。 */
      steered?: true;
      /** 与 queued 同时出现：已作为插话交给会话，等当前步骤结束后插入，不是排到下一轮 */
      steerPending?: true;
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
  /** 失败是 pi 回合内自动重试用尽后的瞬态错误（网络 / 限流 / 5xx）；委派据此做外层自动重试 */
  transient?: true;
}

interface Delivery extends BotDeliverOptions {
  order?: number;
  retry?: boolean;
  epoch?: number;
  admission?: { key: string; controller: AbortController; verdict?: 'parallel' | 'serial' };
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
  /**
   * 由本宿主发起、尚未结束的轮次；sawRunning 防止 spawn 后的 idle 误释放；
   * retry 标记这一格等的是 retry 命令开轮，只有它认 worker 的 retry-skipped 回执；
   * instance 是这一轮的 prompt / retry 发往的 worker 实例（见 instances），发出前缺省
   */
  private readonly slots = new Map<
    string,
    { sawRunning: boolean; retry?: true; instance?: string }
  >();
  /**
   * 会话当前的 worker 实例号（spawn 成功时登记 spec.instanceId）。只有回显这个号的 parent-ended /
   * parent-rejected 才算当前实例结束：旧实例命令的拒绝回显旧号，缺号的不是本宿主的实例，都与当前实例无关。
   * 实例结束（含 worker-exited）只结算已发到该实例上的轮次：还在准备（探测、预算、重建释放、spawn）的轮次
   * 不属于任何旧实例，由准备它的任务自己发出或失败结算
   */
  private readonly instances = new Map<string, string>();
  private readonly stopping = new Map<string, string>();
  private readonly epochs = new Map<string, number>();
  private readonly tasks = new Map<string, string>();
  private readonly retryTasks = new Map<string, string>();
  private queue: Delivery[] = [];
  private nextOrder = 0;
  private readonly preparing = new Set<Delivery>();
  private queueReasons = new Map<string, string>();
  private readonly lastAssistant = new Map<string, LastAssistant>();
  private readonly bindings = new Map<string, ConversationBotBinding | null>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<(event: BotTurnFinished) => void>();
  private maxRunning: number;
  private readonly settleGraceMs: number;
  private readonly settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly independentSpecs = new Map<string, BotSpawnTemplate>();
  private readonly liveProfiles = new Map<string, BotProfile>();
  /** live 会话 spawn 时采用的讨论模式；与当前开关不一致的群成员会话要换说明 */
  private readonly liveDiscuss = new Map<string, boolean>();
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
  private readonly modelNotices = new Map<string, string>();
  private readonly deliveries = new Map<string, Map<string, 'sent' | 'started'>>();
  /** 入 IPC 不等于已消费；保留原投递与顺序，直到 worker 回执或会话终止。 */
  private readonly pendingSteers = new Map<Delivery, string | undefined>();
  private readonly redirects = new Map<
    Delivery,
    {
      original: Delivery;
      settle: (result: ActionResult) => void;
    }
  >();
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
    (event: { conversationId: string; deliveryId: string; steered?: true }) => void
  >();

  onDeliverySent(
    listener: (event: { conversationId: string; deliveryId: string; steered?: true }) => void
  ): () => void {
    this.sentListeners.add(listener);
    return () => this.sentListeners.delete(listener);
  }
  private readonly deferredListeners = new Set<
    (event: { conversationId: string; deliveryId: string }) => void
  >();

  /** worker 回合收尾时没收下的插话：已改排成该会话的下一轮 */
  onDeliveryDeferred(
    listener: (event: { conversationId: string; deliveryId: string }) => void
  ): () => void {
    this.deferredListeners.add(listener);
    return () => this.deferredListeners.delete(listener);
  }

  /** 投递在本宿主排队（未发给 worker） */
  deliveryQueued(conversationId: string, deliveryId: string): boolean {
    return this.queue.some(
      (item) => item.conversationId === conversationId && item.deliveryId === deliveryId
    );
  }

  /** 会话还有排队或等回执的投递（不看当前回合） */
  hasPendingDeliveries(conversationId: string): boolean {
    return (
      [...this.pendingSteers.keys(), ...this.queue].some(
        (item) => item.conversationId === conversationId
      ) || [...this.preparing].some((item) => item.conversationId === conversationId)
    );
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
    this.maxRunning = normalizeBotMaxRunningTurns(deps.maxRunningTurns);
    this.settleGraceMs = deps.settleGraceMs ?? 2000;
  }

  setMaxRunningTurns(value: unknown): void {
    const limit = normalizeBotMaxRunningTurns(value);
    if (this.maxRunning === limit) return;
    // 已占位的轮次（含 spawn / 预算准备）不撤销，只限制后续准入。
    this.maxRunning = limit;
    this.pump();
  }

  onTurnFinished(listener: (event: BotTurnFinished) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isBotConversation(conversationId: string): boolean {
    return this.binding(conversationId) !== null;
  }

  runningCount(): number {
    return new Set([...this.slots.keys(), ...this.running, ...this.stopping.keys()]).size;
  }

  isBusy(conversationId: string): boolean {
    return (
      this.turnActive(conversationId) ||
      [...this.pendingSteers.keys()].some((item) => item.conversationId === conversationId) ||
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
        ...(origin?.task ? { delegationTask: true } : {}),
      }),
      ...(origin?.task ? { delegationTask: true } : {}),
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

  /**
   * 讨论模式开关变化：群聊成员会话按新说明重建，上下文保留。
   * 空闲的只释放 worker（会话不结束，下次投递带 resumeFile 重启并换上新说明）；正在跑回合的等回合结束；
   * 回合结束前已排队的投递在开新回合前重建。没有 sessionFile 的不重建（免得丢上下文）；私聊与委派子会话不受影响。
   */
  async refreshGroupInstructions(): Promise<void> {
    await Promise.all(
      [...this.live]
        .filter((id) => this.instructionsStale(id))
        .map((id) =>
          this.withLock(id, () => this.rebuildIfIdle(id)).catch((error) =>
            console.warn('[bots] instruction refresh deferred:', error)
          )
        )
    );
  }

  private discussOn(): boolean {
    return this.deps.discussEnabled?.() === true;
  }

  /** 起着 worker 的群聊成员会话（非委派、有 sessionFile），且 spawn 时的讨论模式与当前开关不一致 */
  private instructionsStale(id: string): boolean {
    if (this.disposed || !this.live.has(id) || this.independentSpecs.has(id)) return false;
    const binding = this.binding(id);
    if (!binding?.chatId || binding.delegationId) return false;
    if (this.deps.chats.get(binding.chatId)?.kind !== 'group') return false;
    if (!this.deps.authority.conversation(id)?.sessionFile) return false;
    return (this.liveDiscuss.get(id) ?? false) !== this.discussOn();
  }

  private async rebuildIfIdle(id: string): Promise<void> {
    if (!this.instructionsStale(id) || this.isBusy(id)) return;
    const error = await this.releaseForInstructions(id);
    if (error) console.warn('[bots] instruction refresh deferred:', error);
  }

  /** 只释放 worker 里的实例，会话保留；下次投递按新 spawnSpec 带 resumeFile 重启 */
  private async releaseForInstructions(id: string): Promise<string | undefined> {
    try {
      await this.deps.runtime.release(id);
    } catch (error) {
      // 等待期间已确认旧实例结束（parent-ended / worker-exited 已把它移出 live）：释放的目的已达成，
      // 只是 agentHost 的等待者没被唤醒（worker 退出不唤醒、要等超时）
      if (this.live.has(id)) return error instanceof Error ? error.message : 'release-failed';
    }
    this.live.delete(id);
    this.instances.delete(id);
    this.liveProfiles.delete(id);
    this.liveDiscuss.delete(id);
    return undefined;
  }

  private async syncEngine(
    conversationId: string,
    effective?: BotProfile
  ): Promise<string | undefined> {
    if (
      this.disposed ||
      !this.live.has(conversationId) ||
      (this.independentSpecs.has(conversationId) && !effective)
    )
      return undefined;
    const previous = this.liveProfiles.get(conversationId);
    const bot = effective ?? this.deps.bots.get(this.binding(conversationId)?.botId ?? '');
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
      return effective ? undefined : this.syncEngine(conversationId);
    } catch {
      return 'model-update-failed';
    }
  }

  /** 空闲时释放 worker 里的活实例（不推进 epoch、不走停止），下次投递按当前登记的配置与原 jsonl 重新 spawn */
  releaseIdle(conversationId: string): Promise<boolean> {
    return this.withLock(conversationId, async () => {
      if (this.disposed || !this.live.has(conversationId) || this.isBusy(conversationId))
        return false;
      await this.deps.runtime.release(conversationId);
      this.live.delete(conversationId);
      this.liveProfiles.delete(conversationId);
      return true;
    });
  }

  async abortConversation(conversationId: string): Promise<void> {
    this.markStopping(conversationId);
    this.cancelQueued((item) => item.conversationId === conversationId);
    this.deps.runtime.abort?.(conversationId);
    await this.withLock(conversationId, async () => {
      this.cancelActive(conversationId);
      await this.deps.runtime.release(conversationId);
      this.live.delete(conversationId);
      this.running.delete(conversationId);
      this.slots.delete(conversationId);
      this.stopping.delete(conversationId);
    });
    this.pump();
  }

  queueState(): BotQueueItem[] {
    return this.queue.map((item, position) => ({
      chatId: item.chatId,
      deliveryId: item.deliveryId,
      canInterject: !this.redirecting(item) && Boolean(this.interjectionTarget(item)),
      botId: item.botId,
      conversationId: item.conversationId,
      position,
      ...this.queueReason(item, position),
    }));
  }

  async interjectQueued(
    chatId: string,
    deliveryId: string,
    actor: { kind: 'human' | 'bot'; readOnly: boolean }
  ): Promise<ActionResult> {
    if (actor.kind !== 'human' || actor.readOnly) return { ok: false, error: 'unavailable' };
    const original = this.queue.find(
      (item) => item.chatId === chatId && item.deliveryId === deliveryId
    );
    if (original?.source !== 'human' || this.redirecting(original))
      return { ok: false, error: 'queue-unavailable' };
    const target = this.interjectionTarget(original);
    if (!target) return { ok: false, error: this.interjectionEnded(original) };
    const turnKey = this.turnKeys.get(target);
    const redirected: Delivery = {
      ...original,
      conversationId: target,
      deliveryId: randomUUID(),
      epoch: this.epochs.get(target) ?? 0,
      text: `来自群「${this.deps.chats.get(chatId)!.title}」的插话：\n${original.text}`,
    };
    let settle!: (result: ActionResult) => void;
    const receipt = new Promise<ActionResult>((resolve) => {
      settle = resolve;
    });
    this.redirects.set(redirected, { original, settle });
    this.deps.emit({ kind: 'queue', chatId });
    await this.withLock(target, async () => {
      if (
        !this.queue.includes(original) ||
        this.interjectionTarget(original) !== target ||
        this.turnKeys.get(target) !== turnKey
      ) {
        this.settleRedirect(redirected, false);
        return;
      }
      const sent = this.steer(redirected);
      if (!sent.ok) this.settleRedirect(redirected, false);
    });
    this.pump();
    return receipt;
  }

  private redirecting(item: Delivery): boolean {
    return [...this.redirects.values()].some((entry) => entry.original === item);
  }

  private interjectionTarget(item: Delivery): string | undefined {
    const chat = this.deps.chats.get(item.chatId);
    if (
      this.disposed ||
      item.source !== 'human' ||
      !item.deliveryId ||
      chat?.kind !== 'group' ||
      chat.archivedAt !== undefined ||
      !chat.members.includes(item.botId) ||
      chat.sessions[item.botId]?.conversationId !== item.conversationId ||
      this.turnActive(item.conversationId) ||
      this.hasEarlierConversationDelivery(item)
    )
      return;
    const active = this.memberActive(item);
    if (active.length !== 1) return;
    const id = active[0];
    if (
      !this.binding(id)?.delegationId ||
      !this.running.has(id) ||
      !this.turnKeys.has(id) ||
      this.stopping.has(id) ||
      this.retrying.has(id) ||
      this.awaitingTurnEnd(id)
    )
      return;
    return id;
  }

  private interjectionEnded(item: Delivery): string {
    return `${this.deps.bots.get(item.botId)?.name ?? '成员'} 当前任务已结束，消息继续排队`;
  }

  private settleRedirect(delivery: Delivery, accepted: boolean): boolean {
    const redirect = this.redirects.get(delivery);
    if (!redirect) return false;
    this.redirects.delete(delivery);
    this.pendingSteers.delete(delivery);
    const { original, settle } = redirect;
    if (accepted) {
      this.queue = this.queue.filter((item) => item !== original);
      original.admission?.controller.abort();
      const saved = this.deps.chats.appendEntry(original.chatId, {
        kind: 'system',
        id: randomUUID(),
        at: this.now(),
        text: `已转给 ${this.deps.bots.get(original.botId)?.name ?? '成员'} 当前任务`,
      });
      if (saved) this.deps.emit({ kind: 'timeline', chatId: original.chatId, seq: saved.seq });
      this.deliverySent(original);
      this.rememberDelivery(original.conversationId, original.deliveryId!, 'started');
      this.finish(original.conversationId, undefined, true, undefined, '', original.deliveryId);
    } else this.deliveries.get(delivery.conversationId)?.delete(delivery.deliveryId!);
    settle(accepted ? { ok: true } : { ok: false, error: this.interjectionEnded(original) });
    this.deps.emit({ kind: 'queue', chatId: original.chatId });
    return true;
  }

  private queueReason(item: Delivery, position: number): Pick<BotQueueItem, 'reason'> {
    const id = item.conversationId;
    if (
      this.stopping.has(id) ||
      this.memberActive(item).some((active) => this.stopping.has(active))
    )
      return { reason: 'member-stopping' };
    if (this.turnActive(id) || this.queue.slice(0, position).some((o) => o.conversationId === id))
      return { reason: 'turn' };
    if (this.hasEarlierTask(item)) return { reason: 'member-fifo' };
    if (this.memberActive(item).length && this.runningCount() < this.maxRunning)
      return { reason: item.admission?.verdict === 'serial' ? 'member-serial' : 'member-check' };
    return this.runningCount() >= this.maxRunning ? { reason: 'capacity' } : {};
  }

  /** 排队原因变了的聊天（出队之外，如并发位让出后改等工作目录） */
  private changedQueueReasons(): string[] {
    const next = new Map<string, string>();
    for (const item of this.queueState()) {
      const note = `${item.conversationId}:${item.reason ?? ''}:${item.canInterject}`;
      next.set(item.chatId, `${next.get(item.chatId) ?? ''}|${note}`);
    }
    const changed = [...next].filter(
      ([chatId, note]) => chatId && this.queueReasons.get(chatId) !== note
    );
    this.queueReasons = next;
    return changed.map(([chatId]) => chatId);
  }

  /**
   * 只中止会话当前回合（软停止）：排队投递保留，已下发但 worker 还没收下的插话改回排队，
   * 都作为后续回合；不按用户停止结算（不级联取消该回合发起的委派）。没有进行中的回合返回 false。
   */
  async interruptTurn(id: string, reason: string): Promise<boolean> {
    if (this.disposed || !this.turnActive(id)) return false;
    this.markStopping(id);
    for (const [delivery] of [...this.redirects])
      if (delivery.conversationId === id) this.settleRedirect(delivery, false);
    // markStopping 推进了 epoch：保留下来的投递跟上新 epoch；回合结算前就回到排队，结算方能看到它们
    const epoch = this.epochs.get(id) ?? 0;
    for (const item of [...this.queue, ...this.preparing])
      if (item.conversationId === id) item.epoch = epoch;
    for (const item of [...this.pendingSteers.keys()]) {
      if (item.conversationId !== id) continue;
      this.pendingSteers.delete(item);
      if (item.deliveryId) this.deliveries.get(id)?.delete(item.deliveryId);
      item.queueIfBusy = true;
      item.epoch = epoch;
      this.enqueue(item);
    }
    await this.withLock(id, async () => {
      this.deps.runtime.abort?.(id);
      this.cancelActive(id, reason);
      await this.deps.runtime.release(id);
      this.live.delete(id);
      this.running.delete(id);
      this.slots.delete(id);
      this.stopping.delete(id);
      this.lastAssistant.delete(id);
    });
    this.pump();
    return true;
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
    this.markStopping(id);
    this.cancelQueued((item) => item.conversationId === id, reason);
    await this.withLock(id, async () => {
      this.deps.runtime.abort?.(id);
      this.cancelActive(id, reason, estimated);
      // 等旧 generation 结束再允许后续发送，避免迟到的完成事件污染新一轮。
      await this.deps.runtime.release(id);
      this.live.delete(id);
      this.running.delete(id);
      this.slots.delete(id);
      this.stopping.delete(id);
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
    // 同步抛错与 reject 同样按「检查失败、照常放行」处理：调用方此时可能已占着运行槽
    try {
      await this.deps.budget?.prepare(botId);
    } catch (error) {
      console.warn('[bots] budget check failed', error);
    }
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
    const projects = new Map<string, string | undefined>();
    const projectOf = (botId: string) => {
      if (!projects.has(botId)) {
        const workspace = chat && this.resolveWorkspace(chat, botId);
        projects.set(botId, workspace?.ok ? workspace.projectId : undefined);
      }
      return projects.get(botId);
    };
    return this.deps.authority
      .botConversations()
      .filter((conversation) => conversation.bot?.chatId === chatId)
      .map((conversation) => ({
        conversationId: conversation.conversationId,
        botId: conversation.bot!.botId,
        lifecycle: conversation.lifecycle,
        current: current.has(conversation.conversationId),
        resumable:
          chat?.kind === 'direct' && conversation.projectId === projectOf(conversation.bot!.botId),
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

  /** 切回本聊天该成员的旧对话：重新打开它作当前会话，原当前会话结束只读；工作区已换的不能续 */
  switchSession(chatId: string, botId: string, conversationId: string): { ok: true } | Fail {
    const checked = this.canSwitch(chatId, botId, conversationId);
    if (!checked.ok) return checked;
    const current = this.deps.chats.get(chatId)?.sessions[botId];
    if (current?.conversationId === conversationId) return { ok: true };
    if (!this.deps.authority.reopenBotConversation(conversationId))
      return { ok: false, error: 'authority-unavailable' };
    if (current) this.retireSession(current.conversationId);
    this.bindings.set(conversationId, { botId, chatId });
    const cursor = this.deps.chats.lastSeq(chatId);
    this.deps.chats.update(chatId, (draft) => {
      draft.sessions[botId] = { conversationId, cursor };
      return draft;
    });
    this.deps.emit({ kind: 'chat', chatId });
    return { ok: true };
  }

  /** switchSession 的前置校验（无副作用），调用方据此决定是否先停掉当前回合 */
  canSwitch(chatId: string, botId: string, conversationId: string): { ok: true } | Fail {
    const chat = this.deps.chats.get(chatId);
    if (!chat) return { ok: false, error: 'chat-not-found' };
    if (!chat.members.includes(botId)) return { ok: false, error: 'not-member' };
    const bot = this.deps.bots.get(botId);
    if (!bot) return { ok: false, error: 'bot-not-found' };
    if (bot.archivedAt !== undefined) return { ok: false, error: 'bot-archived' };
    const target = this.deps.authority.conversation(conversationId);
    if (target?.bot?.botId !== botId || target.bot.chatId !== chatId)
      return { ok: false, error: 'session-not-found' };
    if (chat.sessions[botId]?.conversationId === conversationId) return { ok: true };
    const workspace = this.resolveWorkspace(chat, botId);
    if (!workspace.ok) return workspace;
    if (target.projectId !== workspace.projectId) return { ok: false, error: 'workspace-changed' };
    return { ok: true };
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
    const delivery: Delivery = {
      ...options,
      chatId,
      botId,
      conversationId,
      text,
      order: this.nextOrder++,
      epoch: this.epochs.get(conversationId) ?? 0,
    };
    this.preparing.add(delivery);
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
      this.preparing.delete(delivery);
      if (this.disposed) return { ok: false, error: 'disabled' };
      if (delivery.epoch !== (this.epochs.get(conversationId) ?? 0))
        return { ok: false, error: 'canceled' };
      if (this.budgetExceeded(botId, binding.chatId, conversationId))
        return { ok: false, error: BOT_BUDGET_ERROR };
      if (
        this.turnActive(conversationId) &&
        !options.queueIfBusy &&
        !this.hasEarlierConversationDelivery(delivery)
      ) {
        if (
          !this.retrying.has(conversationId) &&
          !this.stopping.has(conversationId) &&
          !this.awaitingTurnEnd(conversationId)
        )
          return this.steer(delivery);
        // 重试倒计时或已 idle 待结算时没有活轮可插：排到下一轮。
        delivery.queueIfBusy = true;
      }
      if (
        this.turnActive(conversationId) ||
        this.queue.some((item) => this.sameMemberChat(delivery, item)) ||
        this.hasEarlierTask(delivery) ||
        this.memberActive(delivery).length > 0 ||
        this.runningCount() >= this.maxRunning
      ) {
        this.enqueue(delivery);
        return { ok: true, conversationId, queued: true };
      }
      const started = await this.start(delivery);
      if (!started.ok) this.pump();
      return started;
    }).finally(() => {
      this.preparing.delete(delivery);
      this.pump();
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
    const bossOf = chats
      .filter((chat) => !chat.parentId && chat.bossBotId === botId)
      .map((chat) => chat.id);
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
      // 只有已发到 worker 的轮次随 worker 一起中断；还在准备的轮次保留占位，由准备它的任务换新 worker 发出或失败结算
      // （start 的任何出口——返回失败或抛错——都会把槽绑定到实例或删掉，见 start）
      const preparing = [...this.slots]
        .filter(([id, slot]) => slot.instance === undefined && !this.stopping.has(id))
        .map(([id]) => id);
      const interrupted = [...this.slots.keys()].filter(
        (id) => !this.stopping.has(id) && !preparing.includes(id)
      );
      for (const id of this.stopping.keys()) this.confirmRelease(id);
      for (const id of [...this.settleTimers.keys()]) this.cancelSettle(id);
      this.live.clear();
      this.instances.clear();
      this.running.clear();
      for (const id of [...this.slots.keys()]) if (!preparing.includes(id)) this.slots.delete(id);
      this.lastAssistant.clear();
      this.waiting.clear();
      this.retrying.clear();
      for (const id of [...this.lastOutput.keys()]) if (!preparing.includes(id)) this.quiet(id);
      for (const id of interrupted) {
        this.finish(id, undefined, false, 'worker-exited', '', undefined, true);
        this.turnKeys.delete(id);
      }
      this.failPendingSteers(() => true, 'worker-exited');
      this.pump();
      return;
    }
    if (!('identity' in event) || !event.identity) return;
    this.noteOutput(event);
    if ('parent' in event.identity) return;
    const id = event.identity.sessionId;
    // 有当前实例时，结束事件只认回显它的号：旧实例命令的拒绝 / 结束既不结束当前实例，也不确认正在等的 release。
    // 没有当前实例时这条事件结束不了任何实例（endInstance 不结算），只照旧清掉残留的运行标记并出队
    if (event.type === 'parent-ended' || event.type === 'parent-rejected') {
      const current = this.instances.get(id);
      if (current !== undefined && event.instanceId !== current) return;
    }
    if (this.stopping.has(id)) {
      if (event.type === 'parent-ended' || event.type === 'parent-rejected')
        this.confirmRelease(id);
      return;
    }
    if (!this.isBotConversation(id)) return;
    switch (event.type) {
      case 'delivery-settled':
      case 'delivery-deferred':
      case 'delivery-rejected': {
        const delivery = [...this.pendingSteers.keys()].find(
          (item) => item.conversationId === id && item.deliveryId === event.deliveryId
        );
        if (!delivery) return;
        const seen = this.pendingSteers.get(delivery);
        if (event.type === 'delivery-settled' && seen !== undefined) this.notesSeen.set(id, seen);
        if (this.settleRedirect(delivery, event.type === 'delivery-settled')) {
          if (event.type === 'delivery-settled')
            this.rememberDelivery(id, event.deliveryId, 'started');
          this.pump();
          return;
        }
        this.pendingSteers.delete(delivery);
        if (event.type === 'delivery-settled') {
          if (seen !== undefined) this.notesSeen.set(id, seen);
          this.deliverySent(delivery, true);
          this.rememberDelivery(id, event.deliveryId, 'started');
          for (const listener of this.startedListeners)
            listener({ conversationId: id, deliveryId: event.deliveryId });
          this.pump();
        } else if (event.type === 'delivery-deferred') {
          this.deliveries.get(id)?.delete(event.deliveryId);
          delivery.queueIfBusy = true;
          this.enqueue(delivery);
          for (const listener of this.deferredListeners)
            listener({ conversationId: id, deliveryId: event.deliveryId });
        } else {
          this.finish(id, undefined, false, 'steer-rejected', '', event.deliveryId);
          this.pump();
        }
        return;
      }
      case 'status': {
        const slot = this.slots.get(id);
        this.retrying.delete(id);
        if (event.status === 'running') {
          this.cancelSettle(id);
          if (!this.running.has(id) && !slot?.sawRunning) this.lastAssistant.delete(id);
          this.running.add(id);
          if (slot) slot.sawRunning = true;
          this.deliveryStarted(id);
          this.emitQueueChanges();
          return;
        }
        this.running.delete(id);
        // idle 先于 turn-completed 到达，正常由后者结算；中断等路径只有 idle/failed，到期兜底。
        // worker 的 abort 只发 idle、命令异常只发 failed，没有逐轮终态回执，所以这里仍按宽限兜底。
        // 只有 abort 产生 idle 的路径能保证本轮已终止：兜底后晚到的 running 是另起的一轮（没有占位），
        // 由它自己的 idle / turn-* / parent-ended 补出队。failed 来自 supervisor 的通用异常处理，
        // 不保证当前活动已终止，failed 之后的终态不一定会出现（见 #41、#43）
        if (slot && (slot.sawRunning || event.status === 'failed'))
          this.scheduleSettle(id, slot, event.status === 'failed' ? event.error : undefined);
        else if (!slot) this.pump();
        this.emitQueueChanges();
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
        // release 失败/超时会让停回合 reject（stopping 保留，等真实 parent-ended 解除）；
        // 这里无人 await，不接住的话纯 Node 的 enso-server 会因未处理拒绝退出
        if (this.deps.budget || capped)
          void this.enforceBudget(id, final).catch((error) =>
            console.warn('[bots] budget stop failed:', error)
          );
        return;
      }
      case 'session-meta': {
        if (event.occupancy) this.contextTokens.set(id, event.occupancy.used);
        return;
      }
      case 'turn-retry':
        if (this.turnActive(id)) this.retrying.add(id);
        this.emitQueueChanges();
        return;
      case 'retry-skipped': {
        // 只认等 retry 开轮的那一格；续跑已经开始（running）或普通投递的轮次不受影响
        const slot = this.slots.get(id);
        if (!slot?.retry || slot.sawRunning || this.running.has(id)) return;
        this.finish(
          id,
          undefined,
          false,
          event.reason === 'busy' ? 'session-busy' : 'nothing-to-retry'
        );
        this.lastAssistant.delete(id);
        this.release(id);
        return;
      }
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
        this.finish(
          id,
          event.turnId,
          false,
          event.error,
          this.lastAssistant.get(id)?.text ?? '',
          undefined,
          false,
          false,
          event.retryExhausted === true
        );
        this.lastAssistant.delete(id);
        this.release(id);
        return;
      case 'parent-ended':
      case 'parent-rejected': {
        this.failPendingSteers((item) => item.conversationId === id, event.reason);
        const owned = this.endInstance(id);
        this.live.delete(id);
        this.running.delete(id);
        this.retrying.delete(id);
        this.lastAssistant.delete(id);
        if (owned) {
          this.finish(id, undefined, false, event.reason);
          this.release(id);
        } else this.pump();
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

  /**
   * worker 里会话的当前实例已结束（调用方已按实例号确认归属）：回答这一格是否是发到该实例上的轮次、要随它结算。
   * 宿主自己 release（重建说明）时，worker 回传的 parent-ended 先于 release 返回到达，此时占槽的是
   * 还没发出的新轮次，不属于结束的实例。worker 自己结束实例（闲置回收 evicted，以及 #44 的
   * force-released）同样只结算已发出的轮次。实例号同时作废，之后的 spawn 换新号
   */
  private endInstance(conversationId: string): boolean {
    const ended = this.instances.get(conversationId);
    this.instances.delete(conversationId);
    const sentTo = this.slots.get(conversationId)?.instance;
    return ended !== undefined && sentTo === ended;
  }

  /**
   * 这一轮即将发往会话当前的 worker 实例；没有当前实例（准备期间已结束）时返回 false，不能发：
   * 发往已结束实例的命令被拒时回显的是旧号，不会再结算这一轮
   */
  private dispatchTo(conversationId: string): boolean {
    const slot = this.slots.get(conversationId);
    const instance = this.instances.get(conversationId);
    if (!slot || instance === undefined) return false;
    slot.instance = instance;
    return true;
  }

  private awaitingTurnEnd(conversationId: string): boolean {
    return Boolean(this.slots.get(conversationId)?.sawRunning) && !this.running.has(conversationId);
  }

  private turnActive(conversationId: string): boolean {
    return (
      this.slots.has(conversationId) ||
      this.running.has(conversationId) ||
      this.stopping.has(conversationId)
    );
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
    if (!this.turnActive(id) || this.stopping.has(id)) return;
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
    // 群话题共用根群的群笔记
    const chat = chatId ? this.deps.chats.rootOf(chatId) : undefined;
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
    if (this.disposed) return { ok: false, error: 'disabled' };
    if (
      this.stopping.has(delivery.conversationId) ||
      delivery.epoch !== (this.epochs.get(delivery.conversationId) ?? 0)
    )
      return { ok: false, error: 'canceled' };
    const notes = this.withNotesUpdate(
      delivery,
      delivery.source === 'human'
        ? wrapInterjection(delivery.text, this.deps.language?.() ?? 'zh')
        : delivery.text
    );
    delivery.deliveryId ??= randomUUID();
    this.pendingSteers.set(delivery, notes.seen);
    this.rememberDelivery(delivery.conversationId, delivery.deliveryId, 'sent');
    const sent = this.deps.runtime.steer(
      delivery.conversationId,
      notes.text,
      delivery.images,
      delivery.deliveryId
    );
    if (sent.ok) {
      const previous = this.tasks.get(delivery.conversationId);
      const task = `${previous ?? ''}\n${delivery.text}`;
      this.tasks.set(delivery.conversationId, previous && task.length <= 2000 ? task : '');
      this.retryTasks.set(delivery.conversationId, this.tasks.get(delivery.conversationId)!);
      this.pump();
    } else {
      this.pendingSteers.delete(delivery);
      this.deliveries.get(delivery.conversationId)?.delete(delivery.deliveryId);
    }
    return sent.ok
      ? {
          ok: true,
          conversationId: delivery.conversationId,
          ...(this.hasStartedDelivery(delivery.conversationId, delivery.deliveryId)
            ? { steered: true as const }
            : { queued: true, steerPending: true as const }),
        }
      : { ok: false, error: sent.error ?? 'steer-failed' };
  }

  private async start(delivery: Delivery): Promise<BotDeliverResult> {
    if (this.disposed) return { ok: false, error: 'disabled' };
    const { conversationId } = delivery;
    if (
      this.stopping.has(conversationId) ||
      delivery.epoch !== (this.epochs.get(conversationId) ?? 0)
    )
      return { ok: false, error: 'canceled' };
    let bot = this.usableBot(delivery);
    if (!bot) return { ok: false, error: 'session-unavailable' };
    const independent = this.independentSpecs.get(conversationId)?.bot;
    if (independent) bot = independent;
    this.slots.set(conversationId, { sawRunning: false });
    if (!this.turnKeys.has(conversationId)) this.turnKeys.set(conversationId, randomUUID());
    this.tasks.set(conversationId, delivery.text.length <= 2000 ? delivery.text : '');
    this.lastAssistant.delete(conversationId);
    this.touch(conversationId);
    if (delivery.deliveryId) this.activeDeliveries.set(conversationId, delivery.deliveryId);
    else this.activeDeliveries.delete(conversationId);
    const fail = (error: string): Fail => {
      if (!this.stopping.has(conversationId)) {
        this.slots.delete(conversationId);
        this.turnKeys.delete(conversationId);
      }
      this.quiet(conversationId);
      return { ok: false, error };
    };
    // 准备阶段（探测 / 重建 / spawn / 同步模型 / prompt / retry）抛错与返回失败同一出口：回合还没发出就删槽，
    // 由调用方按失败结果结算一次并 pump；已经发出则槽归实例，由该实例的回合事件结算（worker-exited 保留未发出的槽，
    // 前提就是这里一定收口）
    const stage = { failure: 'start-failed', sent: false };
    try {
      return await this.prepareTurn(delivery, bot, independent, fail, stage);
    } catch (error) {
      if (stage.sent) {
        console.warn('[bots] step after dispatch failed', error);
        return { ok: true, conversationId };
      }
      console.warn('[bots] turn preparation failed', error);
      return fail(error instanceof Error && error.message ? error.message : stage.failure);
    }
  }

  /** start 的准备与发出；stage 记录当前步骤的默认错误码与回合是否已发到 worker */
  private async prepareTurn(
    delivery: Delivery,
    initial: BotProfile,
    independent: BotProfile | undefined,
    fail: (error: string) => Fail,
    stage: { failure: string; sent: boolean }
  ): Promise<BotDeliverResult> {
    const { conversationId } = delivery;
    let bot = initial;
    let fallback: Extract<ModelProbeResult, { ok: true }>['fallback'];
    let selected: BotProfile | undefined = independent;
    if (this.deps.probe) {
      stage.failure = '模型检测失败';
      const probed = await this.deps
        .probe(bot)
        .catch((): { ok: false; error: string } => ({ ok: false, error: '模型检测失败' }));
      if (this.disposed) return fail('disabled');
      if (
        this.stopping.has(conversationId) ||
        delivery.epoch !== (this.epochs.get(conversationId) ?? 0)
      )
        return fail('canceled');
      if (!probed.ok) return fail(probed.error);
      fallback = probed.fallback;
      if (fallback) bot = { ...bot, engine: fallback.model };
      else if (probed.model) bot = { ...bot, engine: { ...bot.engine, ...probed.model } };
      if (fallback || probed.model) selected = bot;
    }
    let notes: { text: string; seen?: string } = { text: delivery.text };
    if (this.instructionsStale(conversationId)) {
      stage.failure = 'release-failed';
      const error = await this.releaseForInstructions(conversationId);
      if (error) return fail(error);
    }
    if (!this.live.has(conversationId)) {
      stage.failure = 'spawn-failed';
      const spawned = await this.spawnLive(delivery, bot, selected);
      if (spawned) return fail(spawned);
    } else {
      stage.failure = 'model-update-failed';
      const error = await this.syncEngine(conversationId, selected);
      if (error) return fail(error);
      stage.failure = 'start-failed';
      notes = this.withNotesUpdate(delivery);
    }
    if (
      this.stopping.has(conversationId) ||
      delivery.epoch !== (this.epochs.get(conversationId) ?? 0)
    )
      return fail('canceled');
    if (delivery.retry) {
      // 这里不挂计时器：worker 要么开轮（running 落在这一格、沿用本轮 turnKey），要么回执 retry-skipped，
      // 要么开轮失败发 turn-failed / 会话不在时发 parent-rejected。worker 与 Main 同包发布，
      // 不存在不发回执的旧 worker。worker 一直不回时由 worker-exited、parent-ended、委派超时
      // （abortConversation）、手动停止兜底，静默看门狗也照常提醒（#29）。
      this.slots.get(conversationId)!.retry = true;
      if (!this.dispatchTo(conversationId)) return fail('session-unavailable');
      stage.failure = 'retry-failed';
      const sent = this.deps.runtime.retry?.(conversationId);
      if (!sent?.ok) return fail(sent?.error ?? 'retry-failed');
      stage.sent = true;
      // 续跑没有 deliveryId、不改任务文本：发出后无必做记账，只剩附属的回退提示
      this.afterDispatch(() => this.modelNotice(delivery, bot, fallback));
      return { ok: true, conversationId };
    }
    if (!this.dispatchTo(conversationId)) return fail('session-unavailable');
    stage.failure = 'prompt-failed';
    const sent = delivery.resume
      ? this.deps.runtime.prompt(
          conversationId,
          notes.text,
          delivery.images,
          delivery.deliveryId,
          true
        )
      : this.deps.runtime.prompt(conversationId, notes.text, delivery.images, delivery.deliveryId);
    if (!sent.ok) return fail(sent.error ?? 'prompt-failed');
    stage.sent = true;
    // 发出后先做必做记账（续跑任务、笔记已读版本、去重登记与 sent 通知——排队投递靠 sent 推进群游标），
    // 再做附属的回退提示；附属步骤失败只告警，不影响记账，也不改变「已发出」的结果
    this.retryTasks.set(conversationId, this.tasks.get(conversationId) ?? '');
    if (notes.seen !== undefined) this.notesSeen.set(conversationId, notes.seen);
    this.deliverySent(delivery);
    this.afterDispatch(() => this.modelNotice(delivery, bot, fallback));
    return { ok: true, conversationId };
  }

  /** 回合已发出后的附属步骤：失败只告警，回合仍由实例结算 */
  private afterDispatch(step: () => void): void {
    try {
      step();
    } catch (error) {
      console.warn('[bots] step after dispatch failed', error);
    }
  }

  private modelNotice(
    delivery: Delivery,
    bot: BotProfile,
    fallback: Extract<ModelProbeResult, { ok: true }>['fallback']
  ): void {
    const chatId = delivery.chatId || this.origins.get(delivery.conversationId)?.chatId || '';
    const key = `${chatId}:${bot.id}`;
    if (!fallback) {
      this.modelNotices.delete(key);
      return;
    }
    const text = `${bot.name} 的模型不可用，本次改用默认模型 ${fallback.label}（${fallback.reason}）`;
    if (this.modelNotices.get(key) === text) return;
    this.modelNotices.set(key, text);
    const chat = this.deps.chats.get(chatId);
    if (chat?.kind === 'group') {
      const saved = this.deps.chats.appendEntry(chat.id, {
        kind: 'system',
        id: randomUUID(),
        at: this.now(),
        text,
      });
      if (saved) this.deps.emit({ kind: 'timeline', chatId: chat.id, seq: saved.seq });
    } else {
      this.deps.emit({ kind: 'model-notice', chatId, text });
    }
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
  private async spawnLive(
    delivery: Delivery,
    bot: BotProfile,
    effective?: BotProfile
  ): Promise<string | undefined> {
    const { conversationId } = delivery;
    const spec = this.spawnSpec(delivery);
    if (!spec.ok) return spec.error;
    if (effective)
      spec.spec = { ...spec.spec, bot: { ...spec.spec.bot, engine: effective.engine } };
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
    const instanceId = randomUUID();
    const spawned = await this.deps.runtime.spawn({ ...spec.spec, instanceId });
    if (!spawned.ok) return spawned.error ?? 'spawn-failed';
    // 先登记实例号：之后的结束事件（含下面 release 回放的 parent-ended）按它认归属
    this.instances.set(conversationId, instanceId);
    if (this.disposed || this.deps.authority.conversation(conversationId)?.lifecycle === 'ended') {
      await this.deps.runtime.release(conversationId);
      this.instances.delete(conversationId);
      return this.disposed ? 'disabled' : 'canceled';
    }
    this.liveProfiles.set(conversationId, spec.spec.bot);
    this.liveDiscuss.set(conversationId, spec.spec.discussMode === true);
    this.live.add(conversationId);
    this.notesSeen.set(conversationId, snap?.version ?? '');
    return undefined;
  }

  /** 回退 / 重试的公共前置：会话空闲、可用，且已在 worker 里（冷会话只恢复不 prompt）；delegation 只认已登记的委派子会话 */
  private async controllable(
    conversationId: string,
    delegation = false,
    restore = true
  ): Promise<Delivery | Fail> {
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
      epoch: this.epochs.get(conversationId) ?? 0,
    };
    const bot = this.usableBot(delivery);
    if (!bot) return { ok: false, error: 'session-unavailable' };
    if (!restore) return delivery;
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
      if (sent.ok) this.retryTasks.delete(conversationId);
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
    const binding = this.binding(conversationId);
    if (!binding) return Promise.resolve({ ok: false, error: 'not-bot-session' });
    const ready: Delivery = {
      botId: binding.botId,
      chatId: binding.chatId ?? '',
      conversationId,
      text: '',
      order: this.nextOrder++,
      epoch: this.epochs.get(conversationId) ?? 0,
      retry: true,
      queueIfBusy: true,
    };
    this.preparing.add(ready);
    return this.withLock(conversationId, async (): Promise<BotDeliverResult> => {
      const checked = await this.controllable(conversationId, options.delegation, false);
      if ('ok' in checked) return checked;
      if (!this.deps.runtime.retry) return { ok: false, error: 'unsupported' };
      const overBudget = await this.overBudget(ready.botId, ready.chatId || null);
      this.preparing.delete(ready);
      if (this.disposed) return { ok: false, error: 'disabled' };
      if (overBudget) return { ok: false, error: BOT_BUDGET_ERROR };
      if (ready.epoch !== (this.epochs.get(conversationId) ?? 0))
        return { ok: false, error: 'canceled' };
      ready.text = this.retryTasks.get(conversationId) ?? '';
      if (
        this.memberActive(ready).length ||
        this.hasEarlierTask(ready) ||
        this.queue.some((item) => this.sameMemberChat(ready, item)) ||
        this.runningCount() >= this.maxRunning
      ) {
        this.enqueue(ready);
        return { ok: true, conversationId, queued: true };
      }
      const result = await this.start(ready);
      if (!result.ok) this.pump();
      return result;
    }).finally(() => {
      this.preparing.delete(ready);
      this.pump();
    });
  }

  private deliverySent(delivery: Delivery, steered?: true): void {
    if (!delivery.deliveryId) return;
    this.rememberDelivery(delivery.conversationId, delivery.deliveryId, 'sent');
    const event = {
      conversationId: delivery.conversationId,
      deliveryId: delivery.deliveryId,
      ...(steered ? { steered } : {}),
    };
    // 每个监听器各自隔离：群游标等记账不能因前一个监听器抛错被跳过
    for (const listener of this.sentListeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[bots] delivery-sent listener failed', error);
      }
    }
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

  private spawnSpec(delivery: Delivery): { ok: true; spec: BotSpawnTemplate } | Fail {
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
    const discussMode = chat.kind === 'group' && this.discussOn();
    return {
      ok: true,
      spec: {
        conversationId: conversation.conversationId,
        projectId: conversation.projectId,
        cwd: workspace.cwd,
        ...(conversation.sessionFile ? { resumeFile: conversation.sessionFile } : {}),
        bot,
        systemPrompt: buildBotSystemPrompt(bot, this.deps.bots.readPersona(bot.id)),
        instructionText: buildBotModeInstruction({
          self: bot,
          kind: chat.kind,
          roster,
          ...(discussMode ? { discussMode } : {}),
        }),
        ...(chat.kind === 'group' ? { groupTasks: true } : {}),
        ...(discussMode ? { discussMode: true } : {}),
        routines: true,
      },
    };
  }

  private release(conversationId: string): void {
    for (const delivery of this.redirects.keys())
      if (delivery.conversationId === conversationId) this.settleRedirect(delivery, false);
    this.cancelSettle(conversationId);
    this.retrying.delete(conversationId);
    this.turnKeys.delete(conversationId);
    this.quiet(conversationId);
    if (this.slots.delete(conversationId)) {
      const botId = this.binding(conversationId)?.botId;
      if (botId) void this.refreshModel(botId);
    }
    // 讨论模式在回合中切换过：回合结束后换说明（之后已排队的投递由 start 在开新回合前处理）
    if (this.instructionsStale(conversationId))
      void this.withLock(conversationId, () => this.rebuildIfIdle(conversationId)).catch((error) =>
        console.warn('[bots] instruction refresh deferred:', error)
      );
    // 宿主没占位的运行（worker 自发 / 晚于结算宽限才开始）结束时调用方已移出 running：同样可能放出同成员的排队投递
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
      const heads = this.queue.filter(
        (item) =>
          (this.turnActive(item.conversationId) &&
            !item.queueIfBusy &&
            !this.retrying.has(item.conversationId)) ||
          !this.hasEarlierTask(item)
      );
      const candidates = heads
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .reduce<Delivery[]>((sorted, item) => enqueueByLane(sorted, item), []);
      const eligible = candidates.find((item) => this.dequeueable(item));
      const index = eligible ? this.queue.indexOf(eligible) : -1;
      if (index < 0) break;
      const next = this.queue[index];
      const active = this.turnActive(next.conversationId);
      if (!active && this.runningCount() >= this.maxRunning) break;
      this.queue.splice(index, 1);
      next.admission?.controller.abort();
      touched.add(next.chatId);
      if (active) {
        // 走同一把锁：同会话前一条可能还在 spawn
        this.preparing.add(next);
        void this.withLock(next.conversationId, async () => {
          this.preparing.delete(next);
          if (
            next.epoch === (this.epochs.get(next.conversationId) ?? 0) &&
            !this.stopping.has(next.conversationId) &&
            (!this.turnActive(next.conversationId) ||
              this.retrying.has(next.conversationId) ||
              this.awaitingTurnEnd(next.conversationId))
          ) {
            // 等锁期间活轮可能已结束；重新按空位/FIFO 准入，不能向空闲会话 steer。
            if (this.retrying.has(next.conversationId) || this.awaitingTurnEnd(next.conversationId))
              next.queueIfBusy = true;
            this.enqueue(next);
            this.pump();
            return;
          }
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
      this.turnKeys.set(next.conversationId, randomUUID());
      this.tasks.set(next.conversationId, next.text.length <= 2000 ? next.text : '');
      if (next.deliveryId) this.activeDeliveries.set(next.conversationId, next.deliveryId);
      void this.withLock(next.conversationId, async () => {
        let started: BotDeliverResult;
        try {
          await this.prepareBudget(next.botId);
          // 预算备好后才让出占位：期间别的投递抢不走并发位与工作区写锁
          const canceled =
            next.epoch !== (this.epochs.get(next.conversationId) ?? 0) ||
            this.stopping.has(next.conversationId);
          if (!this.stopping.has(next.conversationId)) this.slots.delete(next.conversationId);
          started = canceled
            ? { ok: false, error: 'canceled' }
            : this.budgetExceeded(next.botId, next.chatId || null, next.conversationId)
              ? { ok: false, error: BOT_BUDGET_ERROR }
              : await this.start(next);
        } catch (error) {
          // start 自己收口；这里兜住它之前的步骤：未发出的占位让出，并和返回失败一样结算一次
          console.warn('[bots] queued turn preparation failed', error);
          if (this.slots.get(next.conversationId)?.instance !== undefined) return;
          if (!this.stopping.has(next.conversationId)) this.slots.delete(next.conversationId);
          this.quiet(next.conversationId);
          started = {
            ok: false,
            error: error instanceof Error && error.message ? error.message : 'start-failed',
          };
        }
        if (!started.ok) {
          if (this.stopping.has(next.conversationId)) return;
          this.finish(
            next.conversationId,
            undefined,
            false,
            started.error,
            '',
            next.deliveryId ?? null
          );
          this.turnKeys.delete(next.conversationId);
          this.pump();
        }
      });
    }
    for (const chatId of this.changedQueueReasons()) touched.add(chatId);
    for (const chatId of touched) this.deps.emit({ kind: 'queue', chatId });
  }

  /** 活轮里可 steer 的插话（重试倒计时中改排下一轮），或可开的新轮 */
  private dequeueable(item: Delivery): boolean {
    if (this.redirecting(item)) return false;
    if (this.stopping.has(item.conversationId)) return false;
    if (this.hasEarlierConversationDelivery(item)) return false;
    if (!this.turnActive(item.conversationId)) {
      if (this.hasEarlierTask(item)) return false;
      if (this.runningCount() >= this.maxRunning) return false;
      return this.admitMember(item);
    }
    if (this.retrying.has(item.conversationId) || this.awaitingTurnEnd(item.conversationId))
      item.queueIfBusy = true;
    return !item.queueIfBusy;
  }

  private enqueue(item: Delivery): void {
    item.order ??= this.nextOrder++;
    const newer = this.queue.findIndex(
      (other) => other.botId === item.botId && (other.order ?? 0) > item.order!
    );
    // 跨成员保留来源优先级，但绝不越过本成员更早的任务。
    const last =
      newer >= 0 ? newer - 1 : this.queue.findLastIndex((other) => other.botId === item.botId);
    this.queue = [
      ...this.queue.slice(0, last + 1),
      ...(newer >= 0
        ? [item, ...this.queue.slice(newer)]
        : enqueueByLane(this.queue.slice(last + 1), item)),
    ];
    this.deps.emit({ kind: 'queue', chatId: item.chatId });
    this.pump();
  }

  private hasEarlierTask(item: Delivery): boolean {
    return [...this.queue, ...this.preparing, ...this.pendingSteers.keys()].some(
      (other) =>
        other !== item && this.sameMemberChat(item, other) && (other.order ?? 0) < (item.order ?? 0)
    );
  }

  /** 同成员准入只在同一聊天内生效 */
  private sameMemberChat(item: Delivery, other: Delivery): boolean {
    return (
      other.botId === item.botId &&
      (item.conversationId === other.conversationId ||
        this.sameChat(item.conversationId, other.conversationId))
    );
  }

  private sameChat(a: string, b: string): boolean {
    const chatA = this.chatOf(a);
    const chatB = this.chatOf(b);
    return chatA !== undefined && chatA === chatB;
  }

  /** 会话所属聊天：委派子会话按发起它的聊天，沿委派链追到根 */
  private chatOf(id: string): string | undefined {
    for (const seen = new Set<string>(); !seen.has(id); ) {
      seen.add(id);
      const chatId = this.binding(id)?.chatId;
      if (chatId) return chatId;
      const origin = this.origins.get(id);
      if (!origin) return undefined;
      if (origin.chatId) return origin.chatId;
      id = origin.parentConversationId;
    }
    return undefined;
  }

  private hasEarlierConversationDelivery(item: Delivery): boolean {
    return [...this.queue, ...this.preparing, ...this.pendingSteers.keys()].some(
      (other) =>
        other !== item &&
        other.conversationId === item.conversationId &&
        (other.order ?? 0) < (item.order ?? 0)
    );
  }

  private memberActive(item: Delivery): string[] {
    return [...new Set([...this.slots.keys(), ...this.running, ...this.stopping.keys()])]
      .filter(
        (id) =>
          id !== item.conversationId &&
          (this.stopping.get(id) ?? this.binding(id)?.botId) === item.botId &&
          this.sameChat(item.conversationId, id)
      )
      .sort();
  }

  private admitMember(item: Delivery): boolean {
    const active = this.memberActive(item);
    if (!active.length) return true;
    if (active.some((id) => this.stopping.has(id))) return false;
    const key = JSON.stringify(active.map((id) => [id, this.turnKeys.get(id), this.tasks.get(id)]));
    if (item.admission?.key === key) return item.admission.verdict === 'parallel';
    item.admission?.controller.abort();
    const admission: NonNullable<Delivery['admission']> = {
      key,
      controller: new AbortController(),
    };
    item.admission = admission;
    // 快照未知或过大时，无法安全判定任务相互独立。
    if (
      !this.deps.classifyMemberTask ||
      !item.text ||
      item.text.length > 2000 ||
      active.length > 16 ||
      active.some((id) => !this.tasks.get(id))
    ) {
      admission.verdict = 'serial';
      return false;
    }
    const input = {
      task: item.text,
      active: active.map((id) => ({ task: this.tasks.get(id)!, state: 'running' as const })),
    };
    void Promise.resolve()
      .then(() => this.deps.classifyMemberTask!(input, admission.controller.signal))
      .catch(() => 'serial' as const)
      .then((verdict) => {
        if (
          this.disposed ||
          admission.controller.signal.aborted ||
          item.admission !== admission ||
          !this.queue.includes(item)
        )
          return;
        admission.verdict = verdict === 'parallel' ? 'parallel' : 'serial';
        // pump 会重新计算快照，并在任何 spawn/prepare 的 await 之前同步占位。
        this.pump();
      });
    return false;
  }

  private markStopping(id: string): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    const botId = this.binding(id)?.botId;
    if (botId && (this.turnActive(id) || this.live.has(id))) this.stopping.set(id, botId);
    this.emitQueueChanges();
  }

  private emitQueueChanges(): void {
    for (const chatId of this.changedQueueReasons()) this.deps.emit({ kind: 'queue', chatId });
  }

  /** 释放超时不等于已释放；只有运行时确认或 worker 真正退出才能解除阻塞。 */
  private confirmRelease(id: string): void {
    const epoch = this.epochs.get(id);
    void this.withLock(id, async () => {
      if (!this.stopping.has(id) || this.epochs.get(id) !== epoch) return;
      this.cancelActive(id);
      this.live.delete(id);
      this.running.delete(id);
      this.slots.delete(id);
      this.stopping.delete(id);
      this.pump();
    });
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
    estimated = false,
    transient = false
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
      ...(transient ? { transient: true as const } : {}),
    };
    if (deliveryId === this.activeDeliveries.get(conversationId))
      this.activeDeliveries.delete(conversationId);
    if (!ok && !stopped && isModelFailure(error)) {
      const bot =
        this.independentSpecs.get(conversationId)?.bot ?? this.deps.bots.get(binding.botId);
      if (bot) this.deps.invalidateProbe?.(bot);
    }
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
    this.markStopping(conversationId);
    this.cancelQueued((item) => item.conversationId === conversationId);
    this.cancelActive(conversationId);
    if (this.stopping.has(conversationId)) {
      void this.withLock(conversationId, async () => {
        await this.deps.runtime.release(conversationId);
        this.stopping.delete(conversationId);
        this.pump();
      }).catch(() => {});
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
    this.liveDiscuss.clear();
    this.instances.clear();
    this.listeners.clear();
    this.discardListeners.clear();
    this.sentListeners.clear();
    this.deferredListeners.clear();
    this.startedListeners.clear();
    this.deliveries.clear();
    this.modelNotices.clear();
  }

  private cancelQueued(predicate: (item: Delivery) => boolean, reason = 'canceled'): void {
    for (const [delivery, redirect] of this.redirects)
      if (predicate(redirect.original)) this.settleRedirect(delivery, false);
    this.failPendingSteers(predicate, reason);
    const canceled = this.queue.filter(predicate);
    this.queue = this.queue.filter((item) => !predicate(item));
    for (const item of canceled) {
      item.admission?.controller.abort();
      this.finish(item.conversationId, undefined, false, reason, '', item.deliveryId ?? null);
      this.deps.emit({ kind: 'queue', chatId: item.chatId });
    }
  }

  private failPendingSteers(predicate: (item: Delivery) => boolean, reason: string): void {
    for (const item of this.pendingSteers.keys()) {
      if (!predicate(item)) continue;
      if (this.settleRedirect(item, false)) continue;
      this.pendingSteers.delete(item);
      this.finish(item.conversationId, undefined, false, reason, '', item.deliveryId ?? null);
    }
  }

  private cancelActive(id: string, reason = 'canceled', estimated = false): void {
    this.cancelSettle(id);
    this.retrying.delete(id);
    if (this.turnKeys.has(id) || this.running.has(id))
      this.finish(
        id,
        undefined,
        false,
        reason,
        '',
        undefined,
        reason !== BOT_BUDGET_ERROR &&
          reason !== BOT_TURN_LIMIT_ERROR &&
          reason !== BOT_BLOCKED_STOP,
        estimated
      );
    this.running.delete(id);
    if (!this.stopping.has(id)) this.slots.delete(id);
    this.turnKeys.delete(id);
    this.lastAssistant.delete(id);
    this.quiet(id);
  }

  private clearSession(id: string): void {
    this.tasks.delete(id);
    this.retryTasks.delete(id);
    this.cancelSettle(id);
    this.retrying.delete(id);
    this.turnUsage.delete(id);
    this.contextTokens.delete(id);
    this.running.delete(id);
    this.slots.delete(id);
    this.turnKeys.delete(id);
    this.lastAssistant.delete(id);
    this.quiet(id);
    this.activeDeliveries.delete(id);
    this.bindings.delete(id);
    this.independentSpecs.delete(id);
    this.liveProfiles.delete(id);
    this.liveDiscuss.delete(id);
    this.instances.delete(id);
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
        // 群话题用根群的群目录；自愈也写回根群（话题配置随根群级联）
        const home = chat.parentId ?? chat.id;
        const project = authority.ensureBotHomeProject(this.deps.chats.workspaceDir(home));
        if (!project) return { ok: false, error: 'workspace-unavailable' };
        if (project.projectId !== chat.workspace.projectId) {
          this.deps.chats.update(home, (draft) => {
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
