import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  buildDiscussNextInput,
  DISCUSS_NOTE,
  DISCUSS_OWNER_NOTE,
  type DiscussNextDecision,
  type DiscussNextInput,
} from '../../../shared/bots/discussRoute';
import {
  type DiscussEndReason,
  discussCap,
  planWrapUp,
  wrapUpOwner,
} from '../../../shared/bots/discussWrapUp';
import { retryableGroupFailures } from '../../../shared/bots/groupRetry';
import { parseMentions } from '../../../shared/bots/mentions';
import {
  buildSummaryNote,
  clearDiscussion,
  clearWrapUp,
  discussPick,
  discussStep,
  type HumanEntry,
  isBlankReply,
  isSkipReply,
  mergePending,
  needsSmartRoute,
  onHumanMessage,
  onReply,
  type RouterState,
  startDiscussion,
  startRound,
  startWrapUp,
} from '../../../shared/bots/router';
import {
  buildSmartRouteInput,
  SMART_ROUTE_BUILD_NOTE,
  type SmartRouteDecision,
  type SmartRouteInput,
  type SmartRouteIntent,
} from '../../../shared/bots/smartRoute';
import { buildGroupDelta, buildGroupStateBlock } from '../../../shared/bots/transcript';
import {
  clearTurns,
  endTurns,
  onTurnReply,
  planTurnsEnd,
  skipTurn,
  startTurns,
  type TurnStep,
  turnsEligible,
  turnsNote,
  turnsWrapUp,
} from '../../../shared/bots/turnRoute';
import type {
  BotChat,
  BotId,
  DelegationState,
  GroupEntry,
  GroupEntryInput,
  GroupTaskStatus,
  HumanEntryRefs,
} from '../../../shared/types/bot';
import type {
  BotActionResult,
  BotChatStateResult,
  BotEvent,
  BotSendResult,
} from '../../../shared/types/botIpc';
import { BOT_BUDGET_ERROR, BOT_TURN_LIMIT_ERROR } from '../../../shared/usage/botUsage';
import type {
  BotDeliverOptions,
  BotDeliverResult,
  BotSessionHost,
  BotTurnFinished,
} from './botSessionHost';
import type { BotStore } from './botStore';
import type { BotChatStore } from './chatStore';
import { readJson, writeJsonAtomic } from './files';
import { briefErrorReason } from './modelProbe';

interface Round {
  retrying?: boolean;
  /** 仅人类触发且至今全员 [skip] 的轮次保留；群主兜底最多一次 */
  allSkipped?: { botIds: BotId[]; forwarded?: boolean };
  state: RouterState;
  pending: HumanEntry[];
  options?: BotDeliverOptions;
  generation: number;
  deliveryId?: string;
  /** 人类追加消息的独立投递，不属于 current 的接力代际 */
  parallel: Map<
    string,
    {
      botId: BotId;
      conversationId: string;
      routedBy?: Extract<GroupEntry, { kind: 'bot' }>['routedBy'];
      /** 触发这条投递的人类消息，智能选人时作为该成员正在做的事 */
      task?: string;
    }
  >;
  stopping?: BotId[];
  /** 进行中的智能选人；abort 同时充当本次结果的身份 */
  routing?: { entry: HumanEntry; abort: AbortController; parallelOptions?: BotDeliverOptions };
  /** 讨论模式进行中的「下一位 / 结束」判断；abort 同时充当本次结果的身份 */
  deciding?: { abort: AbortController };
  /** 本轮由智能选人选出、尚未发言的成员；其发言标 routedBy */
  smartPicked?: string[];
  /** 本批（一条人类消息 / 例行任务引发的整串接力）已结束的发言，批次结束时合并通知 */
  batch?: { botIds: string[]; failed: string[]; last?: { botId: string; text: string } };
  /** 智能选人判定的意图，写进 routedBy */
  smartIntent?: SmartRouteIntent;
  /** build 被选中的成员：其下一次投递附「先动手」指令 */
  buildNote?: BotId;
  /** 派单成员都回复后排队的群主汇总：投递时附 note，其发言标 routedBy: summary */
  summary?: { botId: BotId; note?: string };
  /**
   * 讨论结束后的群主收尾：note 还在表示收尾附注尚未投递出去；投递后只留 botId，
   * 用于给收尾发言标 routedBy: wrap-up（开关在收尾中关闭也照标），该回合结束即删除
   */
  wrapUp?: { botId: BotId; note?: string };
  /** 讨论中判断点到了群主：下一次给 TA 的投递附裁决提示 */
  ownerCall?: BotId;
  /** 讨论中判断刚选中、还没投递的成员（及判断时的上一位发言者）：投递前复核失效时按当前名单重新判断 */
  judged?: { botId: BotId; lastBotId: BotId };
  /**
   * 成员自选群里的例行任务 / 委派回传 / 重试：只有这一位成员说一回合，回复里的 @ 不接力（开关打开时才生效）
   */
  solo?: true;
}
interface AutonomousReply {
  botId: string;
  text: string;
  title: string | undefined;
  options: BotDeliverOptions;
  /** 随 text 给过全文的委派结果，增量里不再重复 */
  hideDelegationIds?: readonly string[];
  resolve: (result: BotSendResult) => void;
}
/** 智能选人：返回意图与有序成员 id 名单（1–3 位，build 只 1 位）；空名单交给群主。超时由 GroupChatService 统一兜底 */
export interface GroupResponderSelector {
  timeoutMs(): number;
  select(input: SmartRouteInput, signal: AbortSignal): Promise<SmartRouteDecision>;
  /** 讨论模式：单选下一位或结束；超时同样由 GroupChatService 兜底 */
  next(input: DiscussNextInput, signal: AbortSignal): Promise<DiscussNextDecision>;
}
export interface GroupBatchSettled {
  chatId: string;
  /** 有正文发言的成员（去重，按首次发言顺序）；[skip] 不算 */
  botIds: string[];
  failed: string[];
  lastBotId?: string;
  lastText?: string;
}
interface GroupChatDeps {
  bots: BotStore;
  chats: BotChatStore;
  host: Pick<BotSessionHost, 'deliver' | 'onTurnFinished' | 'stopTurn' | 'onDeliverySent'> &
    Partial<Pick<BotSessionHost, 'retryConversation'>>;
  emit: (event: BotEvent) => void;
  retryImages?: (chatId: string, mediaIds: string[]) => NonNullable<BotDeliverOptions['images']>;
  responder?: GroupResponderSelector;
  /**
   * 讨论模式（实验性）总开关，缺省关闭。关闭时不进入讨论（judge 选下一位、讨论 note、@所有人 / 「大家」进讨论、
   * 讨论中委派即结束、全员 skip 不交群主等全部走不到），群聊路由与 main 一致。
   */
  discussEnabled?: () => boolean;
  /** 接力整批结束（无人在回复、无排队、无待路由消息）；用户停止的批次不报 */
  onBatchSettled?: (batch: GroupBatchSettled) => void;
  /** 输入框引用（@聊天 / $技能）：按被投递成员展开，附在增量之后 */
  refsAppendix?: (chat: BotChat, botId: BotId, entries: readonly GroupEntry[]) => Promise<string>;
  /** 某会话某一轮（BotTurnFinished.turnKey）新建委派的目标成员；正文 @ 他们不再接力 */
  delegatedTargets?: (conversationId: string, turnKey: string) => readonly string[];
  /** 压缩后补群状态用：进行中的委派与看板未完成任务 */
  groupState?: (chatId: string) => {
    delegations: readonly { from: BotId; to: BotId; state: DelegationState; task: string }[];
    tasks: readonly {
      seq: number;
      title: string;
      status: GroupTaskStatus;
      assigneeBotId?: BotId;
    }[];
  };
}
const SMART_ROUTE_HISTORY_SCAN = 40;
const DISCUSS_CLOSED_NOTICE = '讨论模式已关闭，本轮讨论结束';
/** 收尾投递准备期间开关被关闭：不发给宿主，由 dispatch 丢弃收尾 */
const WRAP_UP_CANCELLED = 'wrap-up-cancelled';
/** 投递准备期间（拼增量 / 附录的 await）成员自选或判断选中的发言者已不能发言：不发给宿主，由 dispatch 跳过 */
const SPEAKER_UNAVAILABLE = 'speaker-unavailable';
/** 讨论 / 成员自选 / 收尾里成功但空白的回复按 [skip] 处理 */
const BLANK_AS_SKIP = '[skip]';
const empty = (): RouterState => ({
  rootEntrySeq: 0,
  current: null,
  queue: [],
  hops: 0,
  turnsByBot: {},
  noticed: [],
});
/** 本轮首个投递之后的接力：deliveryId 与 onlyIfIdle 只属于触发这一轮的那条投递 */
const relayOptions = (options: BotDeliverOptions | undefined): BotDeliverOptions | undefined => {
  if (!options) return options;
  const { deliveryId: _deliveryId, onlyIfIdle: _onlyIfIdle, ...rest } = options;
  return { ...rest, source: 'bot' };
};
const budgetNotice = (name: string) => `${name} 今日预算已用完`;
const isDecision = (value: unknown): value is SmartRouteDecision =>
  Boolean(value) &&
  typeof value === 'object' &&
  Array.isArray((value as SmartRouteDecision).ids) &&
  (value as SmartRouteDecision).ids.every((id) => typeof id === 'string');
const isDiscussDecision = (value: unknown): value is DiscussNextDecision => {
  if (!value || typeof value !== 'object') return false;
  const decision = value as Record<string, unknown>;
  return (
    typeof decision.next === 'string' ||
    decision.end === true ||
    typeof decision.failure === 'string'
  );
};

/** 选人 / 讨论判断共用：不占锁地跑模型，超时或取消时立即放弃（不等模型返回），出错转成 fallback(error) */
async function raceSelector<T>(
  timeoutMs: number,
  abort: AbortController,
  run: (signal: AbortSignal) => Promise<T>,
  fallback: (error?: unknown) => T
): Promise<{ result: T; timedOut: boolean }> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = AbortSignal.any([abort.signal, timeout.signal]);
  try {
    const cut = new Promise<T>((resolve) => {
      if (signal.aborted) resolve(fallback());
      signal.addEventListener('abort', () => resolve(fallback()), { once: true });
    });
    const running = Promise.resolve()
      .then(() => run(signal))
      .catch((error): T => fallback(signal.aborted ? undefined : error));
    const result = await Promise.race([running, cut]);
    return { result, timedOut: timeout.signal.aborted && !abort.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

/** 每群串行归并；router.json 只用于崩溃恢复，不重放未完成的工作。 */
export class GroupChatService {
  private rounds = new Map<string, Round>();
  private locks = new Map<string, Promise<unknown>>();
  private autonomous = new Map<string, AutonomousReply[]>();
  private readonly cursors = new Map<
    string,
    { chatId: string; botId: string; cursor: number; steered?: true }
  >();
  /** 刚压缩过、下次投递需补 <group-state> 的成员会话；只在内存，重启丢失可接受 */
  private readonly compacted = new Map<string, { chatId: string; botId: string }>();
  /** 开关打开时各群的最后一条 seq：打开只从下一条人类消息开始生效，不追溯进行中的这一轮 */
  private readonly discussFrom = new Map<string, number>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeSent: () => void;
  private disposed = false;

  constructor(private readonly deps: GroupChatDeps) {
    for (const chat of deps.chats.list()) {
      if (chat.kind !== 'group') continue;
      const saved = readJson(this.file(chat.id));
      const interrupted = new Set<string>();
      if (
        saved &&
        typeof saved === 'object' &&
        'state' in saved &&
        saved.state &&
        typeof saved.state === 'object' &&
        'current' in saved.state &&
        typeof saved.state.current === 'string'
      ) {
        interrupted.add(saved.state.current);
      }
      if (
        saved &&
        typeof saved === 'object' &&
        'parallel' in saved &&
        Array.isArray(saved.parallel)
      ) {
        for (const botId of saved.parallel)
          if (typeof botId === 'string' && chat.members.includes(botId)) interrupted.add(botId);
      }
      for (const botId of interrupted) {
        const conversationId = chat.sessions[botId]?.conversationId;
        this.system(
          chat.id,
          '回复被中断',
          conversationId ? { botId, conversationId, mode: 'resume' } : undefined
        );
      }
      this.persist(chat.id);
    }
    this.unsubscribeSent = deps.host.onDeliverySent((event) => {
      const pending = this.cursors.get(event.deliveryId);
      if (!pending) return;
      this.cursors.delete(event.deliveryId);
      if (event.steered) {
        pending.steered = true;
        if (this.round(pending.chatId).parallel.delete(event.deliveryId))
          this.persist(pending.chatId);
      }
      deps.chats.update(pending.chatId, (chat) => {
        const session = chat.sessions[pending.botId];
        if (session?.conversationId === event.conversationId)
          session.cursor = Math.max(session.cursor, pending.cursor);
        return chat;
      });
      if (event.steered) this.settleBatch(pending.chatId);
    });
    this.unsubscribe = deps.host.onTurnFinished((event) => {
      if (event.deliveryId) this.cursors.delete(event.deliveryId);
      if (
        this.disposed ||
        !event.chatId ||
        event.delegationId ||
        !this.rounds.has(event.chatId) ||
        deps.chats.get(event.chatId)?.kind !== 'group'
      )
        return;
      const id = event.chatId;
      const generation = this.round(id).generation;
      void this.lock(id, () => this.finished(event, generation)).catch((error) =>
        console.warn('[bots] group reply failed', error)
      );
    });
  }

  settled(chatId: string): Promise<unknown> {
    return this.locks.get(chatId) ?? Promise.resolve();
  }

  retry(chatId: string, entryId: string): Promise<BotActionResult> {
    return this.lock(chatId, async () => {
      const chat = this.deps.chats.get(chatId);
      if (this.disposed || chat?.kind !== 'group' || chat.archivedAt !== undefined)
        return { ok: false, error: 'group-unavailable' };
      const round = this.round(chatId);
      if (
        round.state.current ||
        round.parallel.size ||
        round.routing ||
        round.deciding ||
        round.stopping ||
        round.pending.length
      )
        return { ok: false, error: 'session-busy' };
      const entry = this.deps.chats.findEntry(chatId, entryId);
      const entries = this.deps.chats.readAfter(chatId, chat.epochSeq ?? 0);
      if (
        entry?.kind !== 'system' ||
        !entry.failure ||
        !retryableGroupFailures(entries).has(entryId)
      )
        return { ok: false, error: 'retry-unavailable' };
      const { botId, conversationId, mode } = entry.failure;
      const bot = this.deps.bots.get(botId);
      if (
        !chat.members.includes(botId) ||
        !bot ||
        bot.archivedAt !== undefined ||
        (mode === 'resume' && chat.sessions[botId]?.conversationId !== conversationId)
      )
        return { ok: false, error: 'retry-unavailable' };
      round.state = { ...empty(), current: botId, turnsByBot: { [botId]: 1 } };
      round.options = undefined;
      round.retrying = true;
      delete round.deliveryId;
      round.generation++;
      this.persist(chatId);
      try {
        const human = entries.findLast((item) => item.kind === 'human');
        const mediaIds = human?.kind === 'human' ? human.images : undefined;
        if (mode === 'deliver' && mediaIds?.length && !this.deps.retryImages)
          throw new Error('retry images unavailable');
        const images =
          mode === 'deliver' && mediaIds?.length
            ? this.deps.retryImages?.(chatId, mediaIds)
            : undefined;
        const result =
          mode === 'resume' && conversationId
            ? ((await this.deps.host.retryConversation?.(conversationId)) ?? {
                ok: false,
                error: 'retry-unavailable',
              })
            : await this.deliver(chat, botId, { source: 'human', ...(images ? { images } : {}) });
        if (!result.ok) {
          round.state = empty();
          delete round.retrying;
          return result;
        }
        this.append(chatId, {
          kind: 'system',
          text: `正在重试 ${bot.name} 的回复`,
          retryOf: entryId,
          id: randomUUID(),
          at: Date.now(),
        });
        return { ok: true };
      } catch {
        round.state = empty();
        delete round.retrying;
        return { ok: false, error: 'retry-unavailable' };
      } finally {
        this.persist(chatId);
      }
    });
  }

  state(chatId: string): BotChatStateResult {
    const chat = this.deps.chats.get(chatId);
    if (chat?.kind !== 'group') return { ok: false, error: 'group-not-found' };
    const { state, pending, routing, deciding } = this.round(chatId);
    const on = this.discussOn();
    return {
      ok: true,
      current: state.current,
      queue: [...state.queue],
      hops: state.hops,
      turnsByBot: { ...state.turnsByBot },
      pendingHuman: pending.length > 0,
      // 讨论模式关闭后不返回讨论的实时状态（判断中）
      routing: Boolean(routing || (deciding && on)),
      // 讨论计数与收尾状态同样只在开关打开时返回
      ...(on && state.discuss
        ? { discuss: { turns: state.discussTurns ?? 0, max: discussCap(chat.routing) } }
        : {}),
      // 成员自选：轮次 + 与讨论共用的安全上限进度，同样只在开关打开时返回
      ...(on && state.turns
        ? {
            discuss: { turns: state.discussTurns ?? 0, max: discussCap(chat.routing) },
            turns: { round: state.turns.round },
          }
        : {}),
      ...(on && state.wrapUp ? { wrapUp: true as const } : {}),
    };
  }

  /**
   * 讨论模式开关变化（设置写入后由 Main 调用）。
   * 打开：只从各群下一条人类消息开始生效。
   * 关闭：逐群在锁内取消进行中的判断、去掉讨论标记、丢掉还没发言的候选；当前发言者说完就停、不收尾，
   * 其回复按 main 的 onReply 规则处理（@ 接力、[skip] 兜底）。只在确实中断了讨论的群里提示一次。
   * 群主已在收尾：让 TA 说完，回复按 main 规则处理；收尾还没投递出去则丢弃，同样只提示一次。
   */
  async syncDiscussMode(): Promise<void> {
    if (this.disposed) return;
    const ids = [...this.rounds.keys()];
    if (this.discussOn()) {
      for (const chatId of ids) this.discussFrom.set(chatId, this.deps.chats.lastSeq(chatId));
      return;
    }
    await Promise.all(
      ids.map((chatId) =>
        this.lock(chatId, async () => {
          const round = this.rounds.get(chatId);
          if (this.disposed || !round || this.discussOn()) return;
          if (!round.state.discuss && !round.deciding && !round.state.wrapUp && !round.state.turns)
            return;
          if (this.closeDiscussion(chatId, round)) await this.dispatch(chatId);
          this.persist(chatId);
          this.settleBatch(chatId);
        }).catch((error) => console.warn('[bots] discuss mode sync failed', error))
      )
    );
  }

  send(
    chatId: string,
    text: string,
    options: BotDeliverOptions = {},
    refs?: HumanEntryRefs,
    images?: string[]
  ): Promise<BotSendResult> {
    return this.lock(chatId, async () => {
      if (this.disposed) return { ok: false, error: 'disabled' };
      const chat = this.deps.chats.get(chatId);
      if (chat?.kind !== 'group' || chat.archivedAt !== undefined)
        return { ok: false, error: 'group-unavailable' };
      if (this.round(chatId).stopping) return { ok: false, error: 'chat-stopping' };
      // 手机离线队列按原 deliveryId 重放：同一条人类消息只落一次时间线
      const entryId = options.deliveryId ? `human:${options.deliveryId}` : randomUUID();
      if (options.deliveryId && this.deps.chats.findEntry(chatId, entryId))
        return { ok: true, duplicate: true };
      const members = this.members(chat);
      const entry = this.append(chatId, {
        kind: 'human',
        text,
        mentions: parseMentions(text, members).ids,
        ...(refs ? { refs } : {}),
        ...(images?.length ? { images } : {}),
        id: entryId,
        at: Date.now(),
      });
      if (entry?.kind !== 'human') return { ok: false, error: 'timeline-write-failed' };
      const round = this.round(chatId);
      // 开关已关但还没同步到这个群：先按关闭处理，再决定这条消息怎么走
      if (this.closeDiscussion(chatId, round)) this.persist(chatId);
      // 讨论判断进行中来了人类消息：取消判断，按新消息重开（与任何一条新人类消息一样重新路由、重算上限）
      if (round.deciding) this.cancelDeciding(round);
      if (round.routing) {
        // 选人期间又来人类消息：放弃本次结果，对合并后的消息重新判定
        const merged = mergePending([round.routing.entry, entry]) ?? entry;
        const parallel = round.routing.parallelOptions !== undefined;
        this.cancelRouting(round);
        if (parallel) await this.routeParallel(chat, merged, options);
        else {
          round.options = options;
          await this.begin(chat, merged);
        }
        this.persist(chatId);
        return { ok: true };
      }
      if (this.turnsFor(chat, entry.seq)) {
        // 成员自选：有人在说（含只 @ 当前发言者、收尾中、例行任务）时不插话，等他说完按合并后的消息重开
        round.options = options;
        if (round.state.current !== null) round.pending.push(entry);
        else await this.begin(chat, entry);
        this.persist(chatId);
        return { ok: true };
      }
      const decision = onHumanMessage(round.state, chat, members, entry);
      if (decision.action === 'steer') {
        await this.deliverParallel(chat, [round.state.current!], options, entry);
      } else if (decision.action === 'parallel') {
        await this.deliverParallel(chat, decision.targets, options, entry);
      } else if (
        decision.action === 'route-parallel' ||
        (decision.action === 'start' && round.parallel.size > 0)
      ) {
        await this.routeParallel(chat, entry, options);
      } else if (decision.action === 'restart-after-current') {
        round.pending.push(entry);
        round.options = options;
      } else {
        round.options = options;
        await this.begin(chat, entry);
      }
      this.persist(chatId);
      return { ok: true };
    });
  }

  runAs(
    chatId: string,
    botId: string,
    text: string,
    title: string | undefined,
    options: BotDeliverOptions = {},
    extra: { hideDelegationIds?: readonly string[] } = {}
  ): Promise<BotSendResult> {
    return new Promise((resolve) => {
      void this.lock(chatId, async () => {
        if (this.disposed) {
          resolve({ ok: false, error: 'disabled' });
          return;
        }
        const chat = this.deps.chats.get(chatId);
        if (
          chat?.kind !== 'group' ||
          chat.archivedAt !== undefined ||
          !chat.members.includes(botId)
        ) {
          resolve({ ok: false, error: 'group-unavailable' });
          return;
        }
        const jobs = this.autonomous.get(chatId) ?? [];
        jobs.push({
          botId,
          text,
          title,
          options,
          resolve,
          ...(extra.hideDelegationIds?.length
            ? { hideDelegationIds: [...extra.hideDelegationIds] }
            : {}),
        });
        this.autonomous.set(chatId, jobs);
        if (!this.round(chatId).state.current) await this.dispatch(chatId);
      }).catch((error) => resolve({ ok: false, error: String(error) }));
    });
  }

  stop(chatId: string): Promise<BotActionResult> {
    return this.lock(chatId, async () => {
      if (this.deps.chats.get(chatId)?.kind !== 'group')
        return { ok: false, error: 'group-not-found' };
      const round = this.round(chatId);
      const targets = [
        ...new Set([
          ...(round.stopping ?? []),
          ...(round.state.current ? [round.state.current] : []),
          ...Array.from(round.parallel.values(), (delivery) => delivery.botId),
        ]),
      ];
      round.generation++;
      round.state = empty();
      round.parallel.clear();
      round.pending = [];
      delete round.batch;
      delete round.retrying;
      this.cancelRouting(round);
      this.cancelDeciding(round);
      this.clearSmart(round);
      for (const job of this.autonomous.get(chatId) ?? [])
        job.resolve({ ok: false, error: 'chat-stopped' });
      this.autonomous.delete(chatId);
      this.persist(chatId);
      if (targets.length) {
        round.stopping = targets;
        try {
          while (targets.length) {
            await this.deps.host.stopTurn(chatId, targets[0]);
            targets.shift();
          }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'stop-failed' };
        }
        delete round.stopping;
      }
      return { ok: true };
    });
  }

  private async finished(event: BotTurnFinished, generation: number): Promise<void> {
    if (this.disposed) return;
    const chat = event.chatId ? this.deps.chats.get(event.chatId) : undefined;
    if (chat?.kind !== 'group') return;
    const round = this.round(chat.id);
    const parallel = event.deliveryId ? round.parallel.get(event.deliveryId) : undefined;
    if (
      parallel &&
      (parallel.botId !== event.botId || parallel.conversationId !== event.conversationId)
    )
      return;
    if (parallel && event.deliveryId) round.parallel.delete(event.deliveryId);
    if (
      (!parallel &&
        (generation !== round.generation ||
          round.state.current !== event.botId ||
          (event.deliveryId && round.deliveryId && event.deliveryId !== round.deliveryId))) ||
      chat.sessions[event.botId]?.conversationId !== event.conversationId
    ) {
      if (parallel) {
        this.persist(chat.id);
        this.settleBatch(chat.id);
      }
      return;
    }
    let seq: number | undefined;
    const summarized =
      !parallel && round.summary?.botId === event.botId && round.summary.note === undefined;
    if (summarized) delete round.summary;
    const wrapping = !parallel && round.wrapUp?.botId === event.botId;
    // 开关打开时，成员自选 / 讨论 / 收尾里成功但空白的回复按 [skip]：不写时间线、不算有效发言；
    // 开关关闭（含还没同步到这个群）与普通接力保持 main 行为
    const blank =
      event.ok &&
      !parallel &&
      isBlankReply(event.text) &&
      this.discussOn() &&
      Boolean(round.state.turns || round.state.discuss || round.state.wrapUp);
    if (!event.ok) {
      const name = this.deps.bots.get(event.botId)?.name ?? '已删除成员';
      this.system(
        chat.id,
        event.error === BOT_BUDGET_ERROR
          ? budgetNotice(name)
          : event.error === BOT_TURN_LIMIT_ERROR
            ? `${name} 本回合用量${event.estimated ? '（按估算）' : ''}超过单回合上限，已停止`
            : `${name} 回复失败：${event.error ?? '未知错误'}`,
        { botId: event.botId, conversationId: event.conversationId, mode: 'resume' }
      );
    } else if (!blank && !isSkipReply(event.text) && event.turnId) {
      const smart = !parallel && (round.smartPicked?.includes(event.botId) ?? false);
      seq = this.append(chat.id, {
        kind: 'bot',
        botId: event.botId,
        text: event.text,
        conversationId: event.conversationId,
        turnId: event.turnId,
        ...(event.model ? { model: event.model } : {}),
        ...(wrapping
          ? { routedBy: 'wrap-up' as const }
          : summarized
            ? { routedBy: 'summary' as const }
            : parallel?.routedBy
              ? { routedBy: parallel.routedBy }
              : smart
                ? {
                    routedBy: round.smartIntent ? (`smart:${round.smartIntent}` as const) : 'smart',
                  }
                : {}),
        id: randomUUID(),
        at: Date.now(),
      })?.seq;
    }
    this.recordBatch(round, event, blank);
    if (parallel && event.deliveryId) {
      // 讨论中并行发言者本回合发起了委派：讨论同样就此结束（丢掉剩余候选、取消进行中的判断）
      const cancelledJudge =
        event.turnKey !== undefined &&
        Boolean(this.deps.delegatedTargets?.(event.conversationId, event.turnKey)?.length) &&
        this.endDiscussion(round);
      this.persist(chat.id);
      if (cancelledJudge) await this.dispatch(chat.id);
      this.settleBatch(chat.id);
      return;
    }
    round.smartPicked = round.smartPicked?.filter((botId) => botId !== event.botId);
    const retrying = round.retrying;
    delete round.retrying;
    if (retrying) round.state = empty();
    else
      this.advance(
        chat,
        blank ? BLANK_AS_SKIP : event.ok ? event.text : '',
        event.turnKey
          ? this.deps.delegatedTargets?.(event.conversationId, event.turnKey)
          : undefined,
        seq,
        !event.ok
      );
    const pending = mergePending(round.pending);
    if (pending) {
      round.pending = [];
      await this.begin(chat, pending);
    } else await this.dispatch(chat.id);
    this.persist(chat.id);
    this.settleBatch(chat.id);
  }

  private recordBatch(round: Round, event: BotTurnFinished, blank = false): void {
    const batch = round.batch ?? { botIds: [], failed: [] };
    round.batch = batch;
    if (!event.ok) {
      if (!batch.failed.includes(event.botId)) batch.failed.push(event.botId);
    } else if (!blank && !isSkipReply(event.text) && event.text.trim()) {
      if (!batch.botIds.includes(event.botId)) batch.botIds.push(event.botId);
      batch.last = { botId: event.botId, text: event.text };
    }
  }

  /** 无人回复、无排队、无待路由的人类消息、无例行任务：本批结束 */
  private settleBatch(chatId: string): void {
    const round = this.round(chatId);
    const batch = round.batch;
    if (
      !batch ||
      round.state.current ||
      round.parallel.size > 0 ||
      round.routing ||
      round.deciding ||
      round.pending.length > 0 ||
      this.autonomous.get(chatId)?.length
    )
      return;
    delete round.batch;
    if (batch.botIds.length === 0 && batch.failed.length === 0) return;
    try {
      this.deps.onBatchSettled?.({
        chatId,
        botIds: batch.botIds,
        failed: batch.failed,
        ...(batch.last ? { lastBotId: batch.last.botId, lastText: batch.last.text } : {}),
      });
    } catch (error) {
      console.warn('[bots] batch listener failed', error);
    }
  }

  /** 新一轮：需要智能选人时异步分类（不占锁），否则按 @ / 群主直接开始 */
  private async begin(chat: BotChat, entry: HumanEntry): Promise<void> {
    const round = this.round(chat.id);
    delete round.retrying;
    const members = this.members(chat);
    this.clearSmart(round);
    round.allSkipped = { botIds: [] };
    if (this.turnsFor(chat, entry.seq)) {
      const started = startTurns(chat, members, entry);
      if ('notice' in started) {
        round.state = empty();
        delete round.allSkipped;
        this.system(chat.id, started.notice);
      } else round.state = started.state;
      await this.dispatch(chat.id);
      return;
    }
    const responder = this.deps.responder;
    if (responder && needsSmartRoute(this.routingView(chat), members, entry)) {
      round.state = empty();
      this.selectResponders(chat, entry, responder);
      return;
    }
    round.state = startRound(chat, members, entry);
    if (
      round.state.current &&
      parseMentions(entry.text, members).all &&
      this.canDiscuss(chat, entry.seq)
    )
      round.state = startDiscussion(round.state);
    if (!round.state.current) this.system(chat.id, '请先指定群主');
    await this.dispatch(chat.id);
  }

  private selectResponders(
    chat: BotChat,
    entry: HumanEntry,
    responder: GroupResponderSelector,
    parallelOptions?: BotDeliverOptions
  ): void {
    const abort = new AbortController();
    const round = this.round(chat.id);
    round.routing = { entry, abort, parallelOptions };
    const current = round.state.current;
    const busy = [
      ...(current
        ? [{ botId: current, task: this.humanText(chat.id, round.state.rootEntrySeq) }]
        : []),
      ...Array.from(round.parallel.values(), ({ botId, task }) => ({ botId, task })),
    ];
    const input = buildSmartRouteInput(
      chat,
      this.members(chat),
      this.deps.chats
        .readEntries(chat.id, { beforeSeq: entry.seq, limit: SMART_ROUTE_HISTORY_SCAN })
        .filter((item) => item.seq > (chat.epochSeq ?? 0)),
      entry,
      busy
    );
    void this.smartRoute(chat.id, responder, input, abort);
  }

  private humanText(chatId: string, seq: number): string | undefined {
    if (seq <= 0) return undefined;
    const [found] = this.deps.chats.readEntries(chatId, { beforeSeq: seq + 1, limit: 1 });
    return found?.seq === seq && found.kind === 'human' ? found.text : undefined;
  }

  private async routeParallel(
    chat: BotChat,
    entry: HumanEntry,
    options: BotDeliverOptions
  ): Promise<void> {
    const responder = this.deps.responder;
    if (responder && needsSmartRoute(this.routingView(chat), this.members(chat), entry)) {
      this.selectResponders(chat, entry, responder, options);
      return;
    }
    await this.deliverPicked(chat, entry, options, { ids: [] });
  }

  private async deliverPicked(
    chat: BotChat,
    entry: HumanEntry,
    options: BotDeliverOptions,
    decision: SmartRouteDecision
  ): Promise<void> {
    // 仅用临时状态筛选名单与群主兜底，绝不替换主轮。
    const picked = startRound(chat, this.members(chat), entry, decision.ids);
    if (!picked.current) {
      this.system(chat.id, '请先指定群主');
      return;
    }
    const targets = [picked.current, ...picked.queue];
    if (decision.noWriter) this.system(chat.id, '没有能改代码或执行命令的成员，交给群主处理');
    await this.deliverParallel(chat, targets, options, entry, decision);
  }

  private async deliverParallel(
    chat: BotChat,
    targets: BotId[],
    options: BotDeliverOptions,
    entry: HumanEntry,
    decision?: SmartRouteDecision
  ): Promise<void> {
    const round = this.round(chat.id);
    const smart = targets.filter((botId) => decision?.ids.includes(botId));
    const markSmart = smart.length > 1 || (smart.length === 1 && smart[0] !== chat.bossBotId);
    for (const botId of targets) {
      const deliveryId = randomUUID();
      const separate = decision?.separate === true && smart.includes(botId);
      const sent = await this.deliver(
        chat,
        botId,
        { ...options, deliveryId, ...(separate ? { queueIfBusy: true } : {}) },
        decision?.intent === 'build' && decision.ids.length === 1 && decision.ids[0] === botId
          ? SMART_ROUTE_BUILD_NOTE
          : undefined
      );
      const name = this.deps.bots.get(botId)?.name ?? botId;
      if (sent.ok && !sent.duplicate) {
        // 以宿主在会话锁内选择的投递方式为准；群的 current 可能已过期。
        if (sent.steered) continue;
        round.parallel.set(deliveryId, {
          botId,
          conversationId: sent.conversationId,
          task: entry.text,
          ...(markSmart && smart.includes(botId)
            ? {
                routedBy: decision?.intent
                  ? (`smart:${decision.intent}` as const)
                  : ('smart' as const),
              }
            : {}),
        });
        if (sent.steerPending)
          this.system(chat.id, `${name} 正在忙，这条补充会在当前步骤结束后插入`);
        else if (sent.queued)
          this.system(
            chat.id,
            separate
              ? `${name} 正在忙，这条新任务排在当前任务之后`
              : `${name} 正在排队，等待可用会话`
          );
      } else {
        this.system(
          chat.id,
          sent.ok ? `${name} 的投递已处理过，本次未发出` : `${name} 投递失败：${sent.error}`,
          sent.ok ? undefined : { botId, mode: 'deliver' }
        );
      }
    }
  }

  private async smartRoute(
    chatId: string,
    responder: GroupResponderSelector,
    input: SmartRouteInput,
    abort: AbortController
  ): Promise<void> {
    let decision: SmartRouteDecision = { ids: [] };
    const { result, timedOut } = await raceSelector<SmartRouteDecision>(
      responder.timeoutMs(),
      abort,
      (signal) => responder.select(input, signal),
      (error) => {
        if (error === undefined) return { ids: [] };
        console.warn('[bots] smart routing failed', error);
        return { ids: [], failure: briefErrorReason(error) };
      }
    );
    if (isDecision(result)) decision = result;
    if (timedOut && decision.ids.length === 0) {
      console.warn('[bots] smart routing timed out');
      decision = { ids: [], failure: '选人超时' };
    }
    if (abort.signal.aborted) return;
    await this.lock(chatId, async () => {
      const round = this.rounds.get(chatId);
      const routing = round?.routing;
      if (this.disposed || !round || routing?.abort !== abort) return;
      delete round.routing;
      const chat = this.deps.chats.get(chatId);
      if (chat?.kind !== 'group' || chat.archivedAt !== undefined) {
        this.persist(chatId);
        return;
      }
      if (decision.failure)
        this.system(chatId, `智能选人不可用（${decision.failure}），已交给群主`);
      if (routing.parallelOptions !== undefined) {
        await this.deliverPicked(chat, routing.entry, routing.parallelOptions, decision);
        this.persist(chatId);
        this.settleBatch(chatId);
        return;
      }
      const picked = decision.ids;
      round.state = startRound(chat, this.members(chat), routing.entry, picked);
      if (
        (decision.intent === 'discuss' || decision.everyone) &&
        this.canDiscuss(chat, routing.entry.seq)
      )
        round.state = startDiscussion(round.state);
      const order = [round.state.current, ...round.state.queue];
      const smart = [...new Set(picked)].filter((botId) => order.includes(botId));
      // 只剩群主一人时等同兜底，不标
      if (smart.length > 1 || (smart.length === 1 && smart[0] !== chat.bossBotId)) {
        round.smartPicked = smart;
        if (decision.intent) round.smartIntent = decision.intent;
      }
      if (decision.intent === 'build' && picked.length === 1 && round.state.current === picked[0])
        round.buildNote = picked[0];
      if (decision.noWriter && round.state.current)
        this.system(chatId, '没有能改代码或执行命令的成员，交给群主处理');
      if (!round.state.current) this.system(chatId, '请先指定群主');
      await this.dispatch(chatId);
      this.persist(chatId);
    }).catch((error) => console.warn('[bots] smart routing failed', error));
  }

  private cancelRouting(round: Round): void {
    round.routing?.abort.abort();
    delete round.routing;
  }

  private cancelDeciding(round: Round): void {
    round.deciding?.abort.abort();
    delete round.deciding;
  }

  private discussOn(): boolean {
    return this.deps.discussEnabled?.() === true;
  }

  /** 成员自选群且讨论模式开关打开（例行任务等单人回合据此不接力） */
  private turnsGroup(chat: BotChat): boolean {
    return this.discussOn() && chat.routing.mode === 'turns';
  }

  /** 这条人类消息按成员自选走：开关打开、turns 群，且消息晚于开关打开时的末条 seq */
  private turnsFor(chat: BotChat, rootSeq: number): boolean {
    return this.turnsGroup(chat) && rootSeq > (this.discussFrom.get(chat.id) ?? 0);
  }

  /** 成员自选不生效时（开关关闭 / 打开前的消息）turns 群按 smart 路由；存储的 mode 不改写 */
  private routingView(chat: BotChat): BotChat {
    return chat.routing.mode === 'turns'
      ? { ...chat, routing: { ...chat.routing, mode: 'smart' } }
      : chat;
  }

  /**
   * 讨论模式只在开关打开、smart 群、有判断后端、且至少两位可发言成员时生效；
   * 开关打开之前发出的人类消息（rootSeq 不晚于打开时的末条 seq）不进入讨论
   */
  private canDiscuss(chat: BotChat, rootSeq: number): boolean {
    if (!this.discussOn() || rootSeq <= (this.discussFrom.get(chat.id) ?? 0)) return false;
    if (!this.deps.responder || chat.routing.mode !== 'smart') return false;
    const muted = chat.routing.muted ?? [];
    return (
      this.members(chat).filter((bot) => bot.archivedAt === undefined && !muted.includes(bot.id))
        .length >= 2
    );
  }

  /**
   * 开关已关闭时收掉本群的讨论：取消判断、去掉讨论标记、丢掉还没发言的候选，当前发言者说完就停
   * （不判断、不收尾）；当前发言者的回复整体按 main 的 onReply 规则处理：@ 照常接力，[skip] 沿用本批
   * allSkipped 计数（本批还没人正常回复才交群主兜底 / 提示无人回复，已有人正常回复则不兜底），这里不重置。
   * 确实中断了讨论（有人在说、在判断或还有候选）时在群里提示一次；讨论已自然结束只清标记。
   * 收尾：群主已在收尾时让 TA 说完（去掉收尾标记，回复按 main 规则处理，回复里的 @ 照常接力，不提示；
   * 讨论里的发言次数清零，只记群主这次收尾，之后的普通接力按全新额度）；
   * 收尾还没投递出去时丢弃收尾并提示一次。
   * 返回是否取消了判断（调用方需要继续派发）。
   */
  private closeDiscussion(chatId: string, round: Round): boolean {
    if (this.discussOn()) return false;
    if (round.state.turns) {
      // 成员自选进行中：当前发言者说完就停，丢掉本轮剩下的人和后面的轮次，回复按 main 规则处理
      round.state = round.state.current ? clearTurns(round.state) : endTurns(round.state);
      this.system(chatId, DISCUSS_CLOSED_NOTICE);
    }
    if (round.state.wrapUp) {
      if (round.wrapUp?.note !== undefined) this.dropWrapUp(chatId, round);
      else round.state = clearWrapUp(round.state);
    }
    if (!round.state.discuss && !round.deciding) return false;
    const deciding = Boolean(round.deciding);
    const interrupted = deciding || round.state.current !== null || round.state.queue.length > 0;
    if (round.state.discuss) this.endDiscussion(round);
    this.cancelDeciding(round);
    if (interrupted) this.system(chatId, DISCUSS_CLOSED_NOTICE);
    return deciding;
  }

  /** 收尾还没投递出去时开关被关闭：丢弃收尾，与讨论被中断一样提示一次 */
  private dropWrapUp(chatId: string, round: Round): void {
    const { wrapUp: _wrapUp, ...rest } = round.state;
    round.state = { ...rest, current: null, queue: [] };
    delete round.wrapUp;
    this.system(chatId, DISCUSS_CLOSED_NOTICE);
  }

  /**
   * 讨论结束（有结论 / 到安全上限 / 没人接话 / 判断不可用）：按有效发言条数与群主是否可用决定
   * 交群主收尾还是只提示；提示先写进时间线，收尾在同一把锁里设为 current，由调用方随后 dispatch。
   * 开关已关闭时不收尾，按关闭处理。
   */
  private finishDiscussion(
    chat: BotChat,
    reason: DiscussEndReason,
    lastBotId: BotId,
    failure?: string
  ): void {
    const round = this.round(chat.id);
    if (!this.discussOn()) {
      this.closeDiscussion(chat.id, round);
      return;
    }
    const state = round.state;
    if (!state.discuss) return;
    const boss = wrapUpOwner(chat, this.members(chat));
    const plan = planWrapUp({
      reason,
      replies: state.discussReplies ?? 0,
      boss,
      cap: discussCap(chat.routing),
      ...(failure !== undefined ? { failure } : {}),
      bossWasLast: boss !== null && boss.id === lastBotId,
      rootSeq: state.rootEntrySeq,
    });
    if (plan.notice) this.system(chat.id, plan.notice);
    delete round.ownerCall;
    if (plan.kind === 'wrap-up') {
      round.state = startWrapUp(state, plan.botId);
      round.wrapUp = { botId: plan.botId, note: plan.note };
      // 收尾不是汇总跳，也不是智能选人的发言
      delete round.summary;
      delete round.buildNote;
      round.smartPicked = round.smartPicked?.filter((id) => id !== plan.botId);
    } else round.state = clearDiscussion({ ...state, current: null });
  }

  /** 讨论中一位成员说完、无人排队：异步判断下一位或结束（不占锁），结果回来在锁内应用 */
  private startJudge(chat: BotChat, candidates: readonly BotId[], lastBotId: BotId): void {
    const responder = this.deps.responder;
    const round = this.round(chat.id);
    if (!responder) return;
    const rootSeq = round.state.rootEntrySeq;
    const entries = this.deps.chats.readAfter(chat.id, Math.max(rootSeq - 1, chat.epochSeq ?? 0));
    const root = entries.find(
      (entry): entry is HumanEntry => entry.seq === rootSeq && entry.kind === 'human'
    );
    if (!root) {
      // 只在时间线损坏或被外部截断时出现；除正常 END 外的结束都要提示
      console.warn('[bots] discuss judge skipped: root message not found');
      this.finishDiscussion(chat, 'judge-failed', lastBotId, '找不到开场消息');
      return;
    }
    const abort = new AbortController();
    round.deciding = { abort };
    const input = buildDiscussNextInput(
      this.members(chat),
      candidates,
      round.state.turnsByBot,
      root,
      entries,
      lastBotId,
      {
        ownerId: chat.bossBotId,
        progress: { used: round.state.discussTurns ?? 0, max: discussCap(chat.routing) },
      }
    );
    void this.judgeNext(chat.id, responder, input, abort, lastBotId);
  }

  private async judgeNext(
    chatId: string,
    responder: GroupResponderSelector,
    input: DiscussNextInput,
    abort: AbortController,
    lastBotId: BotId
  ): Promise<void> {
    const { result, timedOut } = await raceSelector<DiscussNextDecision>(
      responder.timeoutMs(),
      abort,
      (signal) => responder.next(input, signal),
      (error) => {
        if (error === undefined) return { end: true };
        console.warn('[bots] discuss judge failed', error);
        return { failure: briefErrorReason(error) };
      }
    );
    let decision: DiscussNextDecision = isDiscussDecision(result)
      ? result
      : { failure: '判断结果无法识别' };
    if (timedOut && !('next' in decision)) {
      console.warn('[bots] discuss judge timed out');
      decision = { failure: '判断超时' };
    }
    // 先校验是否属于送去判断的名单，再校验当前是否可用：名单外的人即使等待期间变为可选也不接受
    if ('next' in decision) {
      const pickedId = decision.next;
      if (!input.candidates.some((candidate) => candidate.id === pickedId)) {
        console.warn('[bots] discuss judge picked a member outside the roster');
        decision = { failure: '判断结果无法识别' };
      }
    }
    if (abort.signal.aborted) return;
    await this.lock(chatId, async () => {
      const round = this.rounds.get(chatId);
      if (this.disposed || !round || round.deciding?.abort !== abort) return;
      // 第二道拦截：开关已关而同步还没取消这次判断，迟到结果一律丢弃
      if (!this.discussOn()) {
        this.closeDiscussion(chatId, round);
        await this.dispatch(chatId);
        this.persist(chatId);
        this.settleBatch(chatId);
        return;
      }
      delete round.deciding;
      const chat = this.deps.chats.get(chatId);
      if (chat?.kind === 'group' && chat.archivedAt === undefined) {
        if ('failure' in decision)
          this.finishDiscussion(chat, 'judge-failed', lastBotId, decision.failure);
        else if ('next' in decision) {
          // 判断期间成员可能被静音 / 归档 / 移出：按当前群况重新校验
          const members = this.members(chat);
          const picked = discussPick(round.state, chat, members, decision.next, lastBotId);
          if (picked) {
            round.state = picked;
            round.smartPicked = [...(round.smartPicked ?? []), decision.next];
            round.smartIntent = 'discuss';
            if (decision.next === chat.bossBotId) round.ownerCall = decision.next;
            round.judged = { botId: decision.next, lastBotId };
          } else this.repickDiscussion(chat, lastBotId);
        } else this.finishDiscussion(chat, 'concluded', lastBotId);
      }
      await this.dispatch(chatId);
      this.persist(chatId);
      this.settleBatch(chatId);
    }).catch((error) => console.warn('[bots] discuss judge failed', error));
  }

  /**
   * 判断选中的人（已确认在送去判断的名单里）在判断期间失效（静音 / 归档 / 移出 / 上限变化）：
   * 按当前群况重走 discussStep，还有人可选就用新名单再判断一次，到上限或没人可选就按原因结束（收尾或提示）。
   * 讨论已不在进行（无讨论标记或已有人在说话）时不处理。
   */
  private repickDiscussion(chat: BotChat, lastBotId: BotId): void {
    const round = this.round(chat.id);
    if (round.pending.length > 0) return;
    const step = discussStep(round.state, chat, this.members(chat), {
      lastBotId,
      mentioned: false,
      delegated: false,
      pendingHuman: false,
    });
    if (step.kind === 'none') return;
    if (step.kind === 'judge') this.startJudge(chat, step.candidates, lastBotId);
    else this.finishDiscussion(chat, step.reason, lastBotId);
  }

  private clearSmart(round: Round): void {
    delete round.allSkipped;
    delete round.smartPicked;
    delete round.smartIntent;
    delete round.buildNote;
    delete round.summary;
    delete round.wrapUp;
    delete round.ownerCall;
    delete round.solo;
    delete round.judged;
  }

  /**
   * 讨论中途结束（委派 / 开关关闭）：去掉讨论标记与计数，丢掉还没发言的讨论候选，取消进行中的判断；
   * 讨论里的发言次数不带进之后的普通接力。返回是否取消了判断
   */
  private endDiscussion(round: Round): boolean {
    if (!round.state.discuss) return false;
    const dropped = round.state.queue;
    round.state = clearDiscussion(round.state);
    delete round.ownerCall;
    if (round.smartPicked)
      round.smartPicked = round.smartPicked.filter((id) => !dropped.includes(id));
    if (!round.deciding) return false;
    this.cancelDeciding(round);
    return true;
  }

  private advance(
    chat: BotChat,
    text: string,
    delegated?: readonly string[],
    seq?: number,
    /** 回复失败、预算用完或投递失败（成员自选据此不再排 TA；main 规则不区分） */
    failed = false
  ): void {
    const round = this.round(chat.id);
    const members = this.members(chat);
    // 开关已关但还没同步到这个群：当前发言者就是最后一位，按关闭处理
    this.closeDiscussion(chat.id, round);
    const botId = round.state.current!;
    if (round.state.turns) {
      this.advanceTurns(chat, botId, text, delegated, seq, failed);
      return;
    }
    if (round.solo) {
      delete round.solo;
      // 成员自选群的例行任务 / 委派回传：说完即止，回复里的 @ 只是提醒；开关已关则按 main 规则
      if (this.discussOn()) {
        round.state = empty();
        return;
      }
    }
    // 群主收尾：回复里的 @ 只是提醒；开关在收尾中关闭时已去掉标记，回复按 main 规则处理
    const wrapping = round.state.wrapUp === true;
    // 讨论中本回合发起了委派：讨论就此结束，丢掉还没发言的讨论候选；回复里的 @ 仍按普通接力处理
    const delegationEnded = Boolean(round.state.discuss && delegated?.length);
    if (delegationEnded) this.endDiscussion(round);
    const result = onReply(round.state, chat, members, {
      botId,
      text,
      ...(delegated?.length ? { delegated } : {}),
      ...(seq !== undefined ? { seq } : {}),
    });
    round.state = result.state;
    if (result.summary)
      round.summary = {
        botId: result.summary.botId,
        note: buildSummaryNote(members, result.summary.reports),
      };
    for (const notice of result.notices) this.system(chat.id, notice);
    if (round.wrapUp?.botId === botId) delete round.wrapUp;
    if (wrapping) {
      delete round.allSkipped;
      if (result.skipped)
        this.system(
          chat.id,
          `群主「${members.find((m) => m.id === botId)?.name ?? botId}」未给出收尾。`
        );
      return;
    }
    if (delegationEnded) {
      // 委派即结束讨论：即使回的是 [skip] 也不走普通 skip 的群主兜底，委派结果会另行回到群里
      delete round.allSkipped;
      return;
    }
    if (result.skipped) round.allSkipped?.botIds.push(botId);
    else delete round.allSkipped;
    const skipped = round.allSkipped;
    const names = (skipped?.botIds ?? [])
      .map((id) => `「${members.find((m) => m.id === id)?.name ?? id}」`)
      .join('');
    if (round.state.discuss && !round.state.current && round.pending.length === 0) {
      // 讨论中全员 [skip]：直接结束，不交给群主兜底
      if (skipped?.botIds.length) {
        delete round.allSkipped;
        round.state = clearDiscussion(round.state);
        this.system(chat.id, `${names}已跳过，本轮无人回复。`);
        return;
      }
      const step = discussStep(round.state, chat, members, {
        lastBotId: botId,
        mentioned: result.mentioned,
        delegated: Boolean(delegated?.length),
        pendingHuman: false,
      });
      if (step.kind === 'judge') this.startJudge(chat, step.candidates, botId);
      else if (step.kind === 'end') this.finishDiscussion(chat, step.reason, botId);
      return;
    }
    if (!skipped?.botIds.length || round.state.current || round.pending.length > 0) return;
    const boss = members.find((m) => m.id === chat.bossBotId && m.archivedAt === undefined);
    if (
      boss &&
      !skipped.forwarded &&
      !skipped.botIds.includes(boss.id) &&
      round.state.hops < chat.routing.maxHops &&
      (round.state.turnsByBot[boss.id] ?? 0) < chat.routing.maxTurnsPerBot
    ) {
      skipped.forwarded = true;
      round.state = {
        ...round.state,
        current: boss.id,
        hops: round.state.hops + 1,
        turnsByBot: {
          ...round.state.turnsByBot,
          [boss.id]: (round.state.turnsByBot[boss.id] ?? 0) + 1,
        },
      };
      this.system(chat.id, `${names}已跳过，交给群主「${boss.name}」回复。`);
    } else {
      delete round.allSkipped;
      this.system(chat.id, `${names}已跳过，本轮无人回复。`);
    }
  }

  /**
   * 成员自选中一位成员说完：排下一位 / 开下一轮，或结束（一整轮没人发言、到安全上限、有人委派、有新的人类消息）。
   * allSkipped 与 main 同口径维护：开关中途关闭后，当前发言者的 [skip] 按本批计数决定是否交群主兜底
   */
  private advanceTurns(
    chat: BotChat,
    botId: BotId,
    text: string,
    delegated: readonly string[] | undefined,
    seq: number | undefined,
    failed: boolean
  ): void {
    const round = this.round(chat.id);
    const members = this.members(chat);
    const skipped = isSkipReply(text);
    if (skipped) round.allSkipped?.botIds.push(botId);
    else delete round.allSkipped;
    this.applyTurnStep(
      chat,
      onTurnReply(round.state, chat, members, {
        botId,
        ...(seq !== undefined && !skipped && !failed ? { seq } : {}),
        ...(failed ? { failed: true } : {}),
        ...(delegated?.length ? { delegated: true } : {}),
        ...(round.pending.length > 0 ? { pendingHuman: true } : {}),
      })
    );
  }

  /** 应用成员自选的一步：继续就换下一位；结束时按原因停下、提示或交群主收尾 */
  private applyTurnStep(chat: BotChat, step: TurnStep): void {
    const round = this.round(chat.id);
    if (!step.end) {
      round.state = step.state;
      return;
    }
    delete round.allSkipped;
    // 有人委派 / 被新的人类消息打断：不收尾
    if (step.end === 'stop') {
      round.state = endTurns(step.state);
      return;
    }
    const plan = planTurnsEnd(step.state, chat, this.members(chat), step.end, step.quiet);
    if (plan.notice) this.system(chat.id, plan.notice);
    if (plan.kind === 'wrap-up') {
      round.state = turnsWrapUp(step.state, plan.botId);
      round.wrapUp = { botId: plan.botId, note: plan.note };
    } else round.state = endTurns(step.state);
  }

  /** 投递前复核：成员自选按轮到时的口径（点名的人静音照常）；判断选中的人按讨论候选口径（在群、未归档、未静音） */
  private speakerReady(chatId: string, botId: BotId): boolean {
    const chat = this.deps.chats.get(chatId);
    if (!chat || chat.archivedAt !== undefined) return false;
    const { state } = this.round(chatId);
    const members = this.members(chat);
    if (state.turns) return turnsEligible(state, chat, members, botId);
    const bot = members.find((m) => m.id === botId);
    return (
      bot !== undefined &&
      bot.archivedAt === undefined &&
      chat.members.includes(botId) &&
      !(chat.routing.muted ?? []).includes(botId)
    );
  }

  /**
   * 轮到的人在投递前已不能发言（静音 / 归档 / 移出群）：TA 还没收到投递，当作没轮到 TA——不提示、
   * 不算 [skip] 或失败。成员自选接着排下一位；讨论中判断选中的人撤回这次计数，按当前名单重走 discussStep
   * （与判断期间失效同一口径）。开关已关时按关闭处理：没投递出去的人不再发言
   */
  private skipSpeaker(chat: BotChat, botId: BotId, judged?: Round['judged']): void {
    const round = this.round(chat.id);
    if (round.summary?.botId === botId) delete round.summary;
    if (!this.discussOn()) {
      this.closeDiscussion(chat.id, round);
      round.state = { ...round.state, current: null, queue: [] };
      return;
    }
    if (round.state.turns) {
      this.applyTurnStep(chat, skipTurn(round.state, chat, this.members(chat)));
      return;
    }
    const { state } = round;
    round.state = { ...state, current: null };
    if (!judged || !state.discuss) return;
    round.state = {
      ...round.state,
      discussTurns: Math.max(0, (state.discussTurns ?? 0) - 1),
      turnsByBot: { ...state.turnsByBot, [botId]: Math.max(0, (state.turnsByBot[botId] ?? 0) - 1) },
    };
    round.smartPicked = round.smartPicked?.filter((id) => id !== botId);
    this.repickDiscussion(chat, judged.lastBotId);
  }

  private async dispatch(chatId: string): Promise<void> {
    const round = this.round(chatId);
    if (
      this.disposed ||
      round.deciding ||
      (round.routing && round.routing.parallelOptions === undefined)
    )
      return;
    if (!round.state.current) {
      const job = this.autonomous.get(chatId)?.shift();
      if (job) {
        const chat = this.deps.chats.get(chatId);
        const bot = this.deps.bots.get(job.botId);
        if (
          !chat ||
          chat.archivedAt !== undefined ||
          !chat.members.includes(job.botId) ||
          !bot ||
          bot.archivedAt !== undefined
        ) {
          job.resolve({ ok: false, error: 'routine-target-unavailable' });
          return this.dispatch(chatId);
        }
        if (job.title !== undefined) this.system(chatId, `例行任务：${job.title}`);
        this.clearSmart(round);
        if (this.turnsGroup(chat)) round.solo = true;
        round.state = { ...empty(), current: job.botId, turnsByBot: { [job.botId]: 1 } };
        round.options = { ...job.options, queueIfBusy: true };
        round.deliveryId = round.options.deliveryId ?? randomUUID();
        round.generation++;
        // 委派结果 / 例行任务不经路由，也要补上该成员没看过的群消息，否则会基于过时群况回复
        const sent = await this.deliver(
          chat,
          job.botId,
          { ...round.options, deliveryId: round.deliveryId },
          undefined,
          job.text,
          job.hideDelegationIds
        );
        job.resolve(sent);
        round.options = relayOptions(round.options);
        if (sent.ok && !sent.duplicate) {
          this.persist(chatId);
          return;
        }
        if (sent.ok) this.system(chatId, `${bot.name} 的投递已处理过，本次未发出`);
        else if (sent.error === BOT_BUDGET_ERROR) this.system(chatId, budgetNotice(bot.name));
        delete round.solo;
        round.state = empty();
        return this.dispatch(chatId);
      }
    }
    let unavailable = false;
    while (round.state.current) {
      const chat = this.deps.chats.get(chatId);
      if (!chat || chat.archivedAt !== undefined) {
        round.state = empty();
        break;
      }
      const botId = round.state.current;
      const judged = round.judged?.botId === botId ? round.judged : undefined;
      delete round.judged;
      const bot = this.deps.bots.get(botId);
      if (!bot || bot.archivedAt !== undefined || !chat.members.includes(botId)) {
        // 成员自选轮到时已不可用：静默跳过（不算失败），不提示「请先指定群主」
        if (round.state.turns) {
          this.skipSpeaker(chat, botId);
          continue;
        }
        unavailable = true;
        this.advance(chat, '', undefined, undefined, true);
        continue;
      }
      round.generation++;
      this.persist(chatId);
      const summary = round.summary?.botId === botId ? round.summary.note : undefined;
      if (summary !== undefined) round.summary = { botId };
      const discussing = round.state.discuss && this.discussOn();
      const turns = this.discussOn() ? round.state.turns : undefined;
      const wrapNote =
        round.state.wrapUp && round.wrapUp?.botId === botId ? round.wrapUp.note : undefined;
      const note =
        [
          round.buildNote === botId ? SMART_ROUTE_BUILD_NOTE : summary,
          discussing ? DISCUSS_NOTE : undefined,
          discussing && round.ownerCall === botId ? DISCUSS_OWNER_NOTE : undefined,
          turns ? turnsNote(turns.round, turns.named.includes(botId)) : undefined,
          wrapNote,
        ]
          .filter(Boolean)
          .join(' ') || undefined;
      delete round.buildNote;
      if (round.ownerCall === botId) delete round.ownerCall;
      round.deliveryId = round.options?.deliveryId ?? randomUUID();
      const sent = await this.deliver(
        chat,
        botId,
        {
          ...round.options,
          deliveryId: round.deliveryId,
          ...(Array.from(round.parallel.values()).some((delivery) => delivery.botId === botId)
            ? { queueIfBusy: true }
            : {}),
        },
        note,
        undefined,
        undefined,
        // 拼增量 / 附录的 await 期间开关可能被关掉、成员可能被静音 / 归档 / 移出：发给宿主前再确认一次。
        // 只复核收尾、成员自选与判断选中的人；其余投递保持 main 行为
        () => {
          if (wrapNote !== undefined && !this.discussOn()) return WRAP_UP_CANCELLED;
          if ((round.state.turns || judged) && !this.speakerReady(chatId, botId))
            return SPEAKER_UNAVAILABLE;
          return undefined;
        }
      );
      round.options = relayOptions(round.options);
      if (!sent.ok && sent.error === WRAP_UP_CANCELLED) {
        this.dropWrapUp(chatId, round);
        break;
      }
      if (!sent.ok && sent.error === SPEAKER_UNAVAILABLE) {
        const fresh = this.deps.chats.get(chatId);
        if (!fresh || fresh.archivedAt !== undefined) {
          round.state = empty();
          break;
        }
        this.skipSpeaker(fresh, botId, judged);
        continue;
      }
      if (wrapNote !== undefined && round.wrapUp?.botId === botId) round.wrapUp = { botId };
      if (sent.ok && !sent.duplicate) return;
      if (round.summary?.botId === botId) delete round.summary;
      this.system(
        chatId,
        sent.ok
          ? `${bot.name} 的投递已处理过，本次未发出`
          : sent.error === BOT_BUDGET_ERROR
            ? budgetNotice(bot.name)
            : `${bot.name} 暂时无法回复${
                sent.error && !/^[a-z0-9-]+$/.test(sent.error) ? `（${sent.error}）` : ''
              }`,
        sent.ok ? undefined : { botId, mode: 'deliver' }
      );
      this.advance(chat, '', undefined, undefined, !sent.ok);
    }
    if (unavailable) this.system(chatId, '请先指定群主');
    if (this.autonomous.get(chatId)?.length) await this.dispatch(chatId);
  }

  /** 成员会话压缩成功：仅群聊里该成员的当前会话生效 */
  markCompacted(chatId: string, botId: string, conversationId: string): void {
    const chat = this.deps.chats.get(chatId);
    if (chat?.kind === 'group' && chat.sessions[botId]?.conversationId === conversationId)
      this.compacted.set(conversationId, { chatId, botId });
  }

  clearCompacted(scope: { chatId?: string; botId?: string; conversationId?: string }): void {
    if (scope.conversationId) this.compacted.delete(scope.conversationId);
    for (const [id, mark] of this.compacted)
      if (mark.chatId === scope.chatId || mark.botId === scope.botId) this.compacted.delete(id);
  }

  private stateBlock(chat: BotChat, botId: string): string {
    const extra = this.deps.groupState?.(chat.id);
    const { state } = this.round(chat.id);
    return buildGroupStateBlock({
      chatTitle: chat.title,
      selfId: botId,
      members: this.members(chat),
      bossBotId: chat.bossBotId,
      routing: { current: state.current, queue: state.queue },
      delegations: extra?.delegations ?? [],
      tasks: extra?.tasks ?? [],
      lastSeq: this.deps.chats.lastSeq(chat.id),
    });
  }

  private async deliver(
    chat: BotChat,
    botId: string,
    options?: BotDeliverOptions,
    note?: string,
    lead?: string,
    hideDelegationIds?: readonly string[],
    /** 发给宿主前的最后确认；返回错误码时不投递、不动水位，按该错误码返回失败 */
    proceed?: () => string | undefined
  ) {
    const cursor = chat.sessions[botId]?.cursor ?? 0;
    // 排队尚未提交水位，但后续投递不能再次携带已排队的消息。
    let queuedCursor = cursor;
    for (const pending of this.cursors.values())
      if (pending.chatId === chat.id && pending.botId === botId)
        queuedCursor = Math.max(queuedCursor, pending.cursor);
    const floor = chat.epochSeq ?? 0;
    const entries = this.deps.chats.readAfter(chat.id, Math.max(queuedCursor, floor));
    const delta = buildGroupDelta({
      entries,
      botId,
      cursor: queuedCursor,
      floor,
      members: this.members(chat),
      chatTitle: chat.title,
      ...(hideDelegationIds?.length ? { hideDelegationIds } : {}),
    });
    const sessionId = chat.sessions[botId]?.conversationId;
    const compacted = sessionId !== undefined && this.compacted.has(sessionId);
    const appendix = this.deps.refsAppendix
      ? await this.deps.refsAppendix(chat, botId, entries).catch(() => '')
      : '';
    const cancelled = proceed?.();
    if (cancelled !== undefined) return { ok: false as const, error: cancelled };
    const text = [
      // lead 必须在最前：委派结果靠开头的 <delegation-result id> 判断是否已投递
      lead,
      compacted ? this.stateBlock(chat, botId) : '',
      delta.text,
      appendix,
      note ? `<routing-note>${note}</routing-note>` : '',
    ]
      .filter(Boolean)
      .join('\n');
    let result: BotDeliverResult;
    const deliveryId = options?.deliveryId ?? randomUUID();
    const pending: { chatId: string; botId: string; cursor: number; steered?: true } = {
      chatId: chat.id,
      botId,
      cursor: delta.cursor,
    };
    this.cursors.set(deliveryId, pending);
    try {
      result = await this.deps.host.deliver(chat.id, botId, text, { ...options, deliveryId });
    } catch (error) {
      result = {
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // ensureSession 首建会话会设到末尾；失败也要恢复投递前水位。
    this.deps.chats.update(chat.id, (draft) => {
      const session = draft.sessions[botId];
      if (session)
        session.cursor = Math.max(
          session.conversationId === sessionId ? session.cursor : cursor,
          result.ok && !result.queued && !result.duplicate ? delta.cursor : cursor
        );
      return draft;
    });
    if (!result.ok || !result.queued) this.cursors.delete(deliveryId);
    if (compacted && result.ok && !result.duplicate) this.compacted.delete(sessionId);
    // 排队任务可能在 deliver 返回前已被 pump 转为 steer。
    return result.ok && pending.steered ? { ...result, steered: true } : result;
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribeSent();
    for (const id of this.rounds.keys()) {
      for (const job of this.autonomous.get(id) ?? [])
        job.resolve({ ok: false, error: 'canceled' });
      this.cancelRouting(this.round(id));
      this.cancelDeciding(this.round(id));
      this.rounds.set(id, { state: empty(), pending: [], generation: 0, parallel: new Map() });
      this.persist(id);
    }
    this.rounds.clear();
    this.autonomous.clear();
    this.cursors.clear();
    this.compacted.clear();
  }

  discard(chatId: string): void {
    for (const job of this.autonomous.get(chatId) ?? [])
      job.resolve({ ok: false, error: 'canceled' });
    this.autonomous.delete(chatId);
    const round = this.rounds.get(chatId);
    if (round) {
      this.cancelRouting(round);
      this.cancelDeciding(round);
    }
    this.rounds.delete(chatId);
    for (const [id, cursor] of this.cursors) if (cursor.chatId === chatId) this.cursors.delete(id);
    this.clearCompacted({ chatId });
  }

  private members(chat: BotChat) {
    return chat.members.flatMap((id) => {
      const bot = this.deps.bots.get(id);
      return bot ? [bot] : [];
    });
  }
  private round(id: string): Round {
    let round = this.rounds.get(id);
    if (!round) {
      round = { state: empty(), pending: [], generation: 0, parallel: new Map() };
      this.rounds.set(id, round);
    }
    return round;
  }
  private file(id: string) {
    return join(dirname(this.deps.chats.workspaceDir(id)), 'router.json');
  }
  private persist(id: string): void {
    if (!this.deps.chats.get(id)) return;
    const { state, pending, parallel } = this.round(id);
    writeJsonAtomic(this.file(id), {
      version: 1,
      state,
      pending,
      parallel: [...new Set(Array.from(parallel.values(), (delivery) => delivery.botId))],
    });
    this.deps.emit({ kind: 'chat', chatId: id });
  }
  private append(id: string, entry: GroupEntryInput) {
    const saved = this.deps.chats.appendEntry(id, entry);
    if (saved) this.deps.emit({ kind: 'timeline', chatId: id, seq: saved.seq });
    return saved;
  }
  private system(
    id: string,
    text: string,
    failure?: Extract<GroupEntry, { kind: 'system' }>['failure']
  ): void {
    this.append(id, {
      kind: 'system',
      id: randomUUID(),
      at: Date.now(),
      text,
      ...(failure ? { failure } : {}),
    });
  }
  private lock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).then(task, task);
    const settled = run.catch(() => {});
    this.locks.set(id, settled);
    void settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    });
    return run;
  }
}
