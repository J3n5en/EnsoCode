import { MISSED_RUNS_MAX, parseCron } from '../bots/cron';
import { isMediaId } from '../bots/sendImage';
import { APPROVAL_MODES, type ApprovalMode, THINKING_LEVELS, type ThinkingLevel } from './agent';

export type BotId = string;
export type BotChatId = string;
export type BotList = 'any' | BotId[];

export interface BotEngine {
  providerId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

/** 本地时区自然日的用量上限；缺省字段 = 不限 */
export interface BotBudget {
  dailyCostUsd?: number;
  dailyTokens?: number;
}

export interface BotProfile {
  id: BotId;
  /** 群内 @ 用，唯一（大小写不敏感） */
  name: string;
  title: string;
  /** 一句话职责：路由提示与委派目录 */
  scope: string;
  /** image：avatar.png 写入时的 version（有图标记 + 缓存版本）；color 恒为兜底 */
  avatar: { color: string; image?: number };
  /** 缺省跟随全局默认模型 */
  engine?: BotEngine;
  approvalMode: ApprovalMode;
  tools: 'all' | 'readonly';
  skillIds: string[];
  mcpServerIds: string[];
  delegation: { canDelegateTo: BotList; acceptFrom: BotList };
  memory: { enabled: boolean };
  budget?: BotBudget;
  /** 作为被委派方时单次委派的时限（分钟），缺省 DELEGATION_TIMEOUT_MINUTES */
  delegationTimeoutMinutes?: number;
  /** 单回合 token 上限（流式用量超过即停止该回合）；缺省不限 */
  maxTokensPerTurn?: number;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export type BotChatWorkspace =
  | { kind: 'member-home' }
  | { kind: 'chat-home'; projectId: string }
  | { kind: 'project'; projectId: string };

/**
 * 人类消息不 @ 任何人时：boss 群主回复；smart 由便宜模型/分类器选一位成员；
 * turns 成员自选（#22，仅讨论模式开关打开时生效，关闭时按 smart）：成员按顺序多轮发言，各自判断说不说
 */
export const BOT_ROUTING_MODES = ['boss', 'smart', 'turns'] as const;
export type BotRoutingMode = (typeof BOT_ROUTING_MODES)[number];
/** 新建群（含内置团队模板建群）的默认路由模式；验收成员自选后再决定是否改为 turns */
export const NEW_GROUP_ROUTING_MODE: BotRoutingMode = 'smart';

export interface BotChatRouting {
  mode: BotRoutingMode;
  maxHops: number;
  maxTurnsPerBot: number;
  /**
   * 讨论安全上限（讨论模式开关打开时生效）：讨论主链里成员发言（含 [skip] 与失败）达到这个次数时交群主收尾。
   * 缺省按 BOT_DISCUSS_MAX_TURNS.default 算，旧数据不迁移；只存群内，不随团队导出。
   */
  discussMaxTurns?: number;
  /** 静音成员：只在被点名 @ 时发言（@所有人、智能选人、群主兜底都跳过）；群主不可静音 */
  muted?: BotId[];
}

export interface BotChatSession {
  conversationId: string;
  /** 已投递给该成员的最后一条时间线 seq */
  cursor: number;
  distilledTo?: string;
}

export interface BotChat {
  id: BotChatId;
  kind: 'direct' | 'group';
  title: string;
  members: BotId[];
  bossBotId: BotId | null;
  workspace: BotChatWorkspace;
  routing: BotChatRouting;
  pinned: boolean;
  archivedAt?: number;
  /** 搁置 / 结案：侧栏移到「已搁置」，有新消息时自动取消 */
  settledAt?: number;
  /** 稍后提醒：到点 Main 取消搁置并提醒；设置时一并搁置 */
  snoozedUntil?: number;
  /** 置顶内的手动顺序（小的在前）；只在 pinned 时有效 */
  pinOrder?: number;
  /** 群最近一次「新对话」分隔线的 seq：成员上下文与后台读取从这里之后开始 */
  epochSeq?: number;
  /** 群话题：所属根群（话题是根群下的隐藏子群，群配置由根群级联） */
  parentId?: BotChatId;
  threadTitle?: string;
  /**
   * 仅群（根群 / 话题）：参与 AI 自动命名。新建时写入 { seq: 0 }，功能上线前的旧数据没有此字段、不参与；
   * 手动改名时删除（锁定，进行中的结果也随之作废）。seq = 已总结到的时间线位置，0 表示尚未命名。
   */
  autoTitle?: { seq: number };
  /** 仅根群：当前话题，缺省或失效时为根群自身 */
  activeThreadId?: BotChatId;
  sessions: Record<BotId, BotChatSession>;
  createdAt: number;
  updatedAt: number;
  version: number;
}

/** blocked：执行人用 report_blocked 登记缺信息后结束本轮（schemaVersion 2） */
export const DELEGATION_STATES = [
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
  'blocked',
] as const;
/** 一次执行的来源；缺省按 delegate */
export const DELEGATION_TRIGGERS = ['delegate', 'append', 'reply', 'rework', 'retry'] as const;
export type DelegationTrigger = (typeof DELEGATION_TRIGGERS)[number];
export const DELEGATION_FAILURES = ['interrupted', 'timeout', 'denied', 'error', 'check'] as const;
export const DELEGATION_TIMEOUT_MINUTES = 240;
export const DELEGATION_TIMEOUT_MAX_MINUTES = 1440;
/** 一次执行最多并入的追加 */
export const DELEGATION_APPENDS_MAX = 20;
export const DELEGATION_BLOCKED_NEED_MAX = 300;
/** 登记卡住后这么久本轮还没收尾，就只中止当前回合（软停止） */
export const DELEGATION_BLOCKED_STOP_MINUTES = 5;

/** 执行人登记的卡住：缺什么、等谁（parent = 发起方成员，human = 人） */
export interface DelegationBlocked {
  need: string;
  waitFor: 'human' | 'parent';
  at: number;
}

/** 并入执行中的追加；ok 缺省 = 还没跑完，true = 已在本次执行里处理，false = 未送达或执行结束前没跑完 */
export interface DelegationAppend {
  at: number;
  text: string;
  deliveryId: string;
  ok?: boolean;
}
export const DELEGATION_RETRY_BY = ['auto', 'delegator', 'human'] as const;
export type DelegationRetryBy = (typeof DELEGATION_RETRY_BY)[number];
/** retry_delegation 补充说明的长度上限 */
export const DELEGATION_NOTE_MAX = 2000;

export function isDelegationTimeoutMinutes(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= DELEGATION_TIMEOUT_MAX_MINUTES
  );
}

export function isTokenCap(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
export type DelegationState = (typeof DELEGATION_STATES)[number];
export type BotPermissions = Pick<
  BotProfile,
  'tools' | 'approvalMode' | 'skillIds' | 'mcpServerIds'
>;

export interface Delegation {
  id: string;
  parentConversationId: string;
  parentBotId: BotId;
  targetBotId: BotId;
  chatId: BotChatId | null;
  task: string;
  context: string;
  childConversationId: string;
  state: DelegationState;
  failure?: (typeof DELEGATION_FAILURES)[number];
  error?: string;
  result?: string;
  deliveredAt?: number;
  depth: number;
  createdAt: number;
  finishedAt?: number;
  effectivePermissions?: BotPermissions;
  /** 发起时父会话所在轮次的键；同父会话同 batchId 的委派结果合并回传 */
  batchId?: string;
  /** 关联的群任务看板任务 id；委派终态时同步任务状态 */
  taskId?: string;
  /** 由哪条委派重试而来；被指向的记录视为已重试，不能再次重试 */
  retryOf?: string;
  /** 这次重试由谁发起：auto 自动重试 / delegator 委派人用 retry_delegation / human 界面上点的；旧数据缺省视为 human */
  retryBy?: DelegationRetryBy;
  /** 委派人重试时附的补充说明（从头重发时一并带上） */
  retryNote?: string;
  /** 失败后已排定自动重试的时刻（等待期间不唤醒委派人）；接替记录出现前持久化，重启后据此重排 */
  autoRetryAt?: number;
  /** failure 为 error 时：pi 回合内自动重试已用尽的瞬态错误（网络 / 限流 / 5xx） */
  transient?: true;
  /** 本次委派的时限（分钟）：发起方 deadlineMinutes 与目标上限取小 */
  timeoutMinutes?: number;
  /** 发起方要求父回合被停止 / 中断后仍继续 */
  keep?: true;
  /** 验收条件；终态时记 passed，未通过为 failed + failure:'check' */
  check?: TaskCheck;
  trigger?: DelegationTrigger;
  /** queued → running 的时刻 */
  startedAt?: number;
  /** 同一发起会话对执行中的本任务追加的要求（不另开执行） */
  appends?: DelegationAppend[];
  /** report_blocked 登记；本轮结束时执行记为 blocked */
  blocked?: DelegationBlocked;
  /** 结果写进群时间线的那条成员消息的 seq（仅 completed 且发起方是成员当前群会话的第一层委派） */
  resultSeq?: number;
  /**
   * 结果待写进群时间线：finish 时与 completed 终态同一行落盘，写入（或确认不写）后清除。
   * 重启时据此补写 / 回填 resultSeq；功能上线前完成的记录没有此标记，不补发。turnId 为产出结果的子会话回合
   */
  pendingResultEntry?: { turnId?: string };
  /**
   * 子会话这一轮已结束，但它发起的下层委派还没结束（排队 / 运行 / 等待自动重试 / 结果还没送回）：
   * 委派保持 running、不交回，等下层结果送回子会话、被唤醒的那一轮结束后再判定。
   * text / turnId 为这一轮的输出。只有一种情况拿它当完成时的回退文本：仍在等待、子会话空闲，
   * 而下层全部被外部作废（群开新对话 / 回退 / 停止等，结果不会再送回子会话）。
   * 下层结果一旦送进子会话（含重启后从 jsonl 认出）即清除：整合轮在跑就等它结束判定，
   * 没在跑（崩溃 / 重启）则标 interrupted 按自动重试续跑整合轮，不用暂存文本；进入终态时同样清除。
   */
  waiting?: { since: number; text: string; turnId?: string };
  /**
   * 已作为只读背景送进子会话的群消息水位（群 / 话题时间线 seq；群里还没消息时为 0）。
   * 同一子会话上的续跑 / 重试 / 被下层结果唤醒只补此后的新增；换新子会话从头再给最近的。
   * 功能上线前的记录没有此字段：下次往原子会话补背景时按首次处理（给最近的），之后照常增量。
   */
  groupContextSeq?: number;
}

export function parseDelegation(value: unknown): Delegation | undefined {
  if (
    !isObject(value) ||
    !isBotId(value.id) ||
    !isBotId(value.parentBotId) ||
    !isBotId(value.targetBotId) ||
    !isText(value.parentConversationId) ||
    !isText(value.childConversationId) ||
    (value.chatId !== null && !isBotChatId(value.chatId)) ||
    !isText(value.task) ||
    typeof value.context !== 'string' ||
    value.context.length > 8000 ||
    !DELEGATION_STATES.includes(value.state as DelegationState) ||
    !Number.isInteger(value.depth) ||
    Number(value.depth) < 1 ||
    Number(value.depth) > 2 ||
    !isTime(value.createdAt) ||
    (value.deliveredAt !== undefined && !isTime(value.deliveredAt)) ||
    (value.finishedAt !== undefined && !isTime(value.finishedAt))
  )
    return undefined;
  const record: Delegation = {
    id: value.id,
    parentConversationId: value.parentConversationId,
    parentBotId: value.parentBotId,
    targetBotId: value.targetBotId,
    chatId: value.chatId,
    task: value.task,
    context: value.context,
    childConversationId: value.childConversationId,
    state: value.state as DelegationState,
    depth: Number(value.depth),
    createdAt: value.createdAt,
  };
  if (DELEGATION_FAILURES.includes(value.failure as never))
    record.failure = value.failure as Delegation['failure'];
  if (typeof value.error === 'string') record.error = value.error;
  if (typeof value.result === 'string') record.result = value.result;
  if (isTime(value.deliveredAt)) record.deliveredAt = value.deliveredAt;
  if (isTime(value.finishedAt)) record.finishedAt = value.finishedAt;
  if (isText(value.batchId)) record.batchId = value.batchId;
  if (isBotId(value.taskId)) record.taskId = value.taskId;
  if (isText(value.retryOf)) record.retryOf = value.retryOf;
  if (DELEGATION_RETRY_BY.includes(value.retryBy as DelegationRetryBy))
    record.retryBy = value.retryBy as DelegationRetryBy;
  if (isText(value.retryNote)) record.retryNote = value.retryNote.slice(0, DELEGATION_NOTE_MAX);
  if (isTime(value.autoRetryAt)) record.autoRetryAt = value.autoRetryAt;
  if (value.transient === true) record.transient = true;
  if (typeof value.timeoutMinutes === 'number' && value.timeoutMinutes > 0)
    record.timeoutMinutes = value.timeoutMinutes;
  if (value.keep === true) record.keep = true;
  if (isSeq(value.resultSeq) && value.resultSeq > 0) record.resultSeq = value.resultSeq;
  if (isSeq(value.groupContextSeq)) record.groupContextSeq = value.groupContextSeq;
  if (isObject(value.pendingResultEntry))
    record.pendingResultEntry = isText(value.pendingResultEntry.turnId)
      ? { turnId: value.pendingResultEntry.turnId }
      : {};
  if (
    isObject(value.waiting) &&
    isTime(value.waiting.since) &&
    typeof value.waiting.text === 'string'
  )
    record.waiting = {
      since: value.waiting.since,
      text: value.waiting.text,
      ...(isText(value.waiting.turnId) ? { turnId: value.waiting.turnId } : {}),
    };
  const check = parseTaskCheck(value.check);
  if (check) record.check = check;
  if (DELEGATION_TRIGGERS.includes(value.trigger as never))
    record.trigger = value.trigger as DelegationTrigger;
  if (isTime(value.startedAt)) record.startedAt = value.startedAt;
  if (Array.isArray(value.appends)) {
    const appends = value.appends.flatMap((item): DelegationAppend[] =>
      isObject(item) && isTime(item.at) && typeof item.text === 'string' && isText(item.deliveryId)
        ? [
            {
              at: item.at,
              text: item.text,
              deliveryId: item.deliveryId,
              ...(typeof item.ok === 'boolean' ? { ok: item.ok } : {}),
            },
          ]
        : []
    );
    if (appends.length) record.appends = appends.slice(-DELEGATION_APPENDS_MAX);
  }
  if (
    isObject(value.blocked) &&
    isText(value.blocked.need) &&
    (value.blocked.waitFor === 'human' || value.blocked.waitFor === 'parent') &&
    isTime(value.blocked.at)
  )
    record.blocked = {
      need: value.blocked.need.slice(0, DELEGATION_BLOCKED_NEED_MAX),
      waitFor: value.blocked.waitFor,
      at: value.blocked.at,
    };
  if (value.effectivePermissions !== undefined) {
    const permissions = value.effectivePermissions;
    if (
      !isObject(permissions) ||
      (permissions.tools !== 'all' && permissions.tools !== 'readonly') ||
      !APPROVAL_MODES.includes(permissions.approvalMode as ApprovalMode) ||
      !Array.isArray(permissions.skillIds) ||
      !permissions.skillIds.every(isText) ||
      !Array.isArray(permissions.mcpServerIds) ||
      !permissions.mcpServerIds.every(isText)
    )
      return undefined;
    record.effectivePermissions = {
      tools: permissions.tools,
      approvalMode: permissions.approvalMode as ApprovalMode,
      skillIds: [...permissions.skillIds],
      mcpServerIds: [...permissions.mcpServerIds],
    };
  }
  return record;
}

interface GroupEntryBase {
  seq: number;
  id: string;
  at: number;
}

export interface HumanEntryRefs {
  chats?: BotId[];
  skill?: string;
  /** 看板指派的任务 id：投给被 @ 的成员时附上该任务的历次执行 */
  task?: string;
}

function parseHumanRefs(value: unknown): { refs?: HumanEntryRefs } {
  if (!isObject(value)) return {};
  const chats = strings(value.chats).filter(isBotId).slice(0, 3);
  const refs: HumanEntryRefs = {
    ...(chats.length ? { chats } : {}),
    ...(isText(value.skill) ? { skill: value.skill } : {}),
    ...(isText(value.task) ? { task: value.task } : {}),
  };
  return refs.chats || refs.skill || refs.task ? { refs } : {};
}

function parseHumanImages(value: unknown): { images?: string[] } {
  const images = Array.isArray(value) ? value.filter(isMediaId).slice(0, 20) : [];
  return images.length ? { images } : {};
}

export const GROUP_PROGRESS_PHASES = ['started', 'blocked', 'delivered'] as const;
export type GroupProgressPhase = (typeof GROUP_PROGRESS_PHASES)[number];

export type GroupEntry =
  | (GroupEntryBase & {
      kind: 'human';
      text: string;
      mentions: BotId[];
      /** 输入框 @聊天（chatId）与 $技能（技能 id）；Main 投递时按成员展开 */
      refs?: HumanEntryRefs;
      /** 随消息发的图：聊天 media 目录里的副本 id */
      images?: string[];
    })
  | (GroupEntryBase & {
      kind: 'bot';
      botId: BotId;
      text: string;
      conversationId: string;
      turnId: string;
      /**
       * 该轮回复人由智能选人选出（群主兜底不标）；带意图时为 smart:<intent>；summary 为派单后的群主汇总；
       * wrap-up 为讨论结束后的群主收尾
       */
      routedBy?: BotRoutedBy;
      /** 产出该回复的模型 id（虚拟模型为实际路由到的真实模型） */
      model?: string;
      /** 委派结果：系统以被委派成员名义写入，conversationId 为委派子会话；不参与群路由 */
      delegationId?: string;
      /** 不进该成员的群增量：重启补写的委派结果，发起人此前已随委派回传收到过全文 */
      hiddenFrom?: BotId;
    })
  | (GroupEntryBase & {
      kind: 'delegation';
      delegationId: string;
      from: BotId;
      to: BotId;
      state: DelegationState;
      summary?: string;
      /** 挂了看板任务：群里已有「交付」进度，结果卡默认折叠 */
      taskId?: string;
    })
  | (GroupEntryBase & {
      /** Main 在执行状态转换时按模板以执行人名义写；不路由、不选人、不解析 @ */
      kind: 'progress';
      botId: BotId;
      taskId: string;
      taskSeq: number;
      delegationId: string;
      phase: GroupProgressPhase;
      text: string;
    })
  | (GroupEntryBase & {
      kind: 'system';
      text: string;
      /** 成员提议 / 改动例行任务：时间线据此渲染批准 / 拒绝卡片 */
      routine?: { botId: BotId; id: string };
      /** 群「新对话」分隔线 */
      newConversation?: true;
      failure?: { botId: BotId; conversationId?: string; mode: 'resume' | 'deliver' };
      retryOf?: string;
    });

export type GroupEntryInput = GroupEntry extends infer E
  ? E extends GroupEntry
    ? Omit<E, 'seq'>
    : never
  : never;

export const BOT_ROUTING_DEFAULTS: BotChatRouting = { mode: 'boss', maxHops: 4, maxTurnsPerBot: 2 };
export const BOT_ROUTED_BY = [
  'smart',
  'smart:build',
  'smart:answer',
  'smart:discuss',
  'summary',
  'wrap-up',
] as const;
export type BotRoutedBy = (typeof BOT_ROUTED_BY)[number];
const ROUTING_LIMITS = { maxHops: 20, maxTurnsPerBot: 10 } as const;
/** 讨论安全上限的取值范围与缺省值 */
export const BOT_DISCUSS_MAX_TURNS = { min: 5, max: 200, default: 50 } as const;

export const BOT_NAME_MAX = 24;
/** 群聊里 @ 全体的保留写法 */
export const BOT_MENTION_ALL = ['所有人', 'everyone', 'all'] as const;
export const BOT_THREAD_TITLE_MAX = 80;
const BOT_NAME_RE = /^[\p{L}\p{N}_-]+$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const COLOR_RE = /^#[0-9a-f]{6}$/iu;
const AVATAR_COLORS = ['#7c5cff', '#0ea5e9', '#f97316', '#22c55e', '#ec4899', '#eab308'];

export const isBotId = (value: unknown): value is BotId =>
  typeof value === 'string' && UUID_RE.test(value);
export const isBotChatId = isBotId;
export const botNameKey = (name: string): string => name.normalize('NFC').toLowerCase();

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isSeq = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => isText(item)) : [];
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function botList(value: unknown): BotList {
  return Array.isArray(value) ? value.filter(isBotId) : 'any';
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value as number));
}

function defaultColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function normalizeName(raw: string): string | undefined {
  const name = raw.trim().normalize('NFC');
  return name && [...name].length <= BOT_NAME_MAX && BOT_NAME_RE.test(name) ? name : undefined;
}

export type BotNameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: 'invalid' | 'reserved' | 'duplicate' };

/** reserved：内置 agent 类型名等不可占用的名字 */
export function checkBotName(
  raw: string,
  others: readonly Pick<BotProfile, 'id' | 'name'>[],
  reserved: readonly string[],
  selfId?: BotId
): BotNameCheck {
  const name = normalizeName(raw);
  if (!name) return { ok: false, reason: 'invalid' };
  const key = botNameKey(name);
  if ([...BOT_MENTION_ALL, ...reserved].some((item) => botNameKey(item) === key)) {
    return { ok: false, reason: 'reserved' };
  }
  if (others.some((other) => other.id !== selfId && botNameKey(other.name) === key)) {
    return { ok: false, reason: 'duplicate' };
  }
  return { ok: true, name };
}

function parseEngine(value: unknown): BotEngine | undefined {
  if (!isObject(value) || !isText(value.providerId) || !isText(value.modelId)) return undefined;
  const engine: BotEngine = { providerId: value.providerId, modelId: value.modelId };
  if (THINKING_LEVELS.includes(value.thinkingLevel as ThinkingLevel)) {
    engine.thinkingLevel = value.thinkingLevel as ThinkingLevel;
  }
  return engine;
}

export function parseBotProfile(value: unknown): BotProfile | undefined {
  if (!isObject(value) || !isBotId(value.id) || typeof value.name !== 'string') return undefined;
  const name = normalizeName(value.name);
  if (!name || !isTime(value.createdAt) || !isTime(value.updatedAt)) return undefined;
  const avatar = isObject(value.avatar) ? value.avatar : {};
  const delegation = isObject(value.delegation) ? value.delegation : {};
  const memory = isObject(value.memory) ? value.memory : {};
  const profile: BotProfile = {
    id: value.id,
    name,
    title: str(value.title),
    scope: str(value.scope),
    avatar: {
      color:
        typeof avatar.color === 'string' && COLOR_RE.test(avatar.color)
          ? avatar.color
          : defaultColor(value.id),
      ...(Number.isSafeInteger(avatar.image) && (avatar.image as number) > 0
        ? { image: avatar.image as number }
        : {}),
    },
    approvalMode: APPROVAL_MODES.includes(value.approvalMode as ApprovalMode)
      ? (value.approvalMode as ApprovalMode)
      : 'full',
    tools: value.tools === 'readonly' ? 'readonly' : 'all',
    skillIds: strings(value.skillIds),
    mcpServerIds: strings(value.mcpServerIds),
    delegation: {
      canDelegateTo: botList(delegation.canDelegateTo),
      acceptFrom: botList(delegation.acceptFrom),
    },
    memory: { enabled: memory.enabled !== false },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: Number.isSafeInteger(value.version) ? (value.version as number) : 0,
  };
  const engine = parseEngine(value.engine);
  if (engine) profile.engine = engine;
  const budget = parseBotBudget(value.budget);
  if (budget) profile.budget = budget;
  if (isDelegationTimeoutMinutes(value.delegationTimeoutMinutes))
    profile.delegationTimeoutMinutes = value.delegationTimeoutMinutes;
  if (isTokenCap(value.maxTokensPerTurn)) profile.maxTokensPerTurn = value.maxTokensPerTurn;
  if (isTime(value.archivedAt)) profile.archivedAt = value.archivedAt;
  return profile;
}

/** 正数才算上限，tokens 须为整数；一个都不合法返回 undefined（= 不限） */
export function parseBotBudget(value: unknown): BotBudget | undefined {
  if (!isObject(value)) return undefined;
  const budget: BotBudget = {};
  const cost = value.dailyCostUsd;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) budget.dailyCostUsd = cost;
  const tokens = value.dailyTokens;
  if (Number.isSafeInteger(tokens) && (tokens as number) > 0) budget.dailyTokens = tokens as number;
  return budget.dailyCostUsd === undefined && budget.dailyTokens === undefined ? undefined : budget;
}

function parseWorkspace(value: unknown): BotChatWorkspace | undefined {
  if (!isObject(value)) return undefined;
  if (value.kind === 'member-home') return { kind: 'member-home' };
  if ((value.kind === 'chat-home' || value.kind === 'project') && isText(value.projectId)) {
    return { kind: value.kind, projectId: value.projectId };
  }
  return undefined;
}

export function parseBotChat(value: unknown): BotChat | undefined {
  if (!isObject(value) || !isBotChatId(value.id)) return undefined;
  if (value.kind !== 'direct' && value.kind !== 'group') return undefined;
  if (!Array.isArray(value.members) || !value.members.every(isBotId)) return undefined;
  const members = value.members as BotId[];
  if (new Set(members).size !== members.length) return undefined;
  const workspace = parseWorkspace(value.workspace);
  if (!workspace || !isTime(value.createdAt) || !isTime(value.updatedAt)) return undefined;
  const bossBotId = value.bossBotId ?? null;
  if (value.kind === 'direct') {
    if (members.length !== 1 || bossBotId !== null || workspace.kind === 'chat-home')
      return undefined;
  } else if (
    members.length < 2 ||
    !isBotId(bossBotId) ||
    !members.includes(bossBotId) ||
    workspace.kind === 'member-home'
  ) {
    return undefined;
  }
  const routing = isObject(value.routing) ? value.routing : {};
  const muted = [...new Set(strings(routing.muted))].filter(
    (id) => members.includes(id) && id !== bossBotId
  );
  const sessions: Record<BotId, BotChatSession> = {};
  if (isObject(value.sessions)) {
    for (const [botId, session] of Object.entries(value.sessions)) {
      if (!members.includes(botId) || !isObject(session) || !isText(session.conversationId))
        continue;
      sessions[botId] = {
        conversationId: session.conversationId,
        cursor: intIn(session.cursor, 0, Number.MAX_SAFE_INTEGER, 0),
        ...(isText(session.distilledTo) ? { distilledTo: session.distilledTo } : {}),
      };
    }
  }
  const chat: BotChat = {
    id: value.id,
    kind: value.kind,
    title: str(value.title),
    members,
    bossBotId: bossBotId as BotId | null,
    workspace,
    routing: {
      mode: BOT_ROUTING_MODES.includes(routing.mode as BotRoutingMode)
        ? (routing.mode as BotRoutingMode)
        : BOT_ROUTING_DEFAULTS.mode,
      maxHops: intIn(routing.maxHops, 1, ROUTING_LIMITS.maxHops, BOT_ROUTING_DEFAULTS.maxHops),
      maxTurnsPerBot: intIn(
        routing.maxTurnsPerBot,
        1,
        ROUTING_LIMITS.maxTurnsPerBot,
        BOT_ROUTING_DEFAULTS.maxTurnsPerBot
      ),
      ...(Number.isSafeInteger(routing.discussMaxTurns)
        ? {
            discussMaxTurns: intIn(
              routing.discussMaxTurns,
              BOT_DISCUSS_MAX_TURNS.min,
              BOT_DISCUSS_MAX_TURNS.max,
              BOT_DISCUSS_MAX_TURNS.default
            ),
          }
        : {}),
      ...(muted.length > 0 ? { muted } : {}),
    },
    pinned: value.pinned === true,
    sessions,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: Number.isSafeInteger(value.version) ? (value.version as number) : 0,
  };
  if (isTime(value.archivedAt)) chat.archivedAt = value.archivedAt;
  if (isTime(value.settledAt)) chat.settledAt = value.settledAt;
  if (isTime(value.snoozedUntil)) chat.snoozedUntil = value.snoozedUntil;
  if (chat.pinned && isSeq(value.pinOrder)) chat.pinOrder = value.pinOrder;
  if (isSeq(value.epochSeq)) chat.epochSeq = value.epochSeq;
  if (chat.kind === 'group') {
    if (isBotChatId(value.parentId) && value.parentId !== chat.id) chat.parentId = value.parentId;
    else if (isBotChatId(value.activeThreadId)) chat.activeThreadId = value.activeThreadId;
    const threadTitle = str(value.threadTitle).trim().slice(0, BOT_THREAD_TITLE_MAX);
    if (threadTitle) chat.threadTitle = threadTitle;
    if (isObject(value.autoTitle) && isSeq(value.autoTitle.seq))
      chat.autoTitle = { seq: value.autoTitle.seq };
  }
  return chat;
}

export function parseGroupEntry(value: unknown): GroupEntry | undefined {
  if (!isObject(value) || !isSeq(value.seq) || !isText(value.id) || !isTime(value.at))
    return undefined;
  const base = { seq: value.seq, id: value.id, at: value.at };
  switch (value.kind) {
    case 'human':
      return typeof value.text === 'string'
        ? {
            ...base,
            kind: 'human',
            text: value.text,
            mentions: strings(value.mentions),
            ...parseHumanRefs(value.refs),
            ...parseHumanImages(value.images),
          }
        : undefined;
    case 'bot':
      return isBotId(value.botId) &&
        typeof value.text === 'string' &&
        isText(value.conversationId) &&
        isText(value.turnId)
        ? {
            ...base,
            kind: 'bot',
            botId: value.botId,
            text: value.text,
            conversationId: value.conversationId,
            turnId: value.turnId,
            ...(BOT_ROUTED_BY.includes(value.routedBy as BotRoutedBy)
              ? { routedBy: value.routedBy as BotRoutedBy }
              : {}),
            ...(typeof value.model === 'string' && value.model ? { model: value.model } : {}),
            ...(isText(value.delegationId) ? { delegationId: value.delegationId } : {}),
            ...(isBotId(value.hiddenFrom) ? { hiddenFrom: value.hiddenFrom } : {}),
          }
        : undefined;
    case 'delegation': {
      if (
        !isText(value.delegationId) ||
        !isBotId(value.from) ||
        !isBotId(value.to) ||
        !DELEGATION_STATES.includes(value.state as DelegationState)
      ) {
        return undefined;
      }
      const entry: GroupEntry = {
        ...base,
        kind: 'delegation',
        delegationId: value.delegationId,
        from: value.from,
        to: value.to,
        state: value.state as DelegationState,
      };
      if (typeof value.summary === 'string') entry.summary = value.summary;
      if (isText(value.taskId)) entry.taskId = value.taskId;
      return entry;
    }
    case 'progress':
      return isBotId(value.botId) &&
        isText(value.taskId) &&
        isSeq(value.taskSeq) &&
        isText(value.delegationId) &&
        GROUP_PROGRESS_PHASES.includes(value.phase as GroupProgressPhase) &&
        typeof value.text === 'string'
        ? {
            ...base,
            kind: 'progress',
            botId: value.botId,
            taskId: value.taskId,
            taskSeq: value.taskSeq,
            delegationId: value.delegationId,
            phase: value.phase as GroupProgressPhase,
            text: value.text,
          }
        : undefined;
    case 'system':
      if (typeof value.text !== 'string') return undefined;
      return isObject(value.routine) && isBotId(value.routine.botId) && isBotId(value.routine.id)
        ? {
            ...base,
            kind: 'system',
            text: value.text,
            routine: { botId: value.routine.botId, id: value.routine.id },
          }
        : {
            ...base,
            kind: 'system',
            text: value.text,
            ...(value.newConversation === true ? { newConversation: true as const } : {}),
            ...(isObject(value.failure) &&
            isBotId(value.failure.botId) &&
            (value.failure.mode === 'deliver' ||
              (value.failure.mode === 'resume' && typeof value.failure.conversationId === 'string'))
              ? {
                  failure: {
                    botId: value.failure.botId,
                    mode: value.failure.mode as 'resume' | 'deliver',
                    ...(typeof value.failure.conversationId === 'string'
                      ? { conversationId: value.failure.conversationId }
                      : {}),
                  },
                }
              : {}),
            ...(typeof value.retryOf === 'string' ? { retryOf: value.retryOf } : {}),
          };
    default:
      return undefined;
  }
}

export const BOT_ROUTINE_RESULTS = [
  'ok',
  'error',
  'skipped',
  'budget',
  /** 上一次还在跑时到点 */
  'skipped-busy',
  /** 应用退出时仍未结算，启动对账标记 */
  'interrupted',
  /** 运行前依赖检查不通过 */
  'blocked',
] as const;
export type BotRoutineResult = (typeof BOT_ROUTINE_RESULTS)[number];
export const BOT_ROUTINE_STATUSES = ['draft', 'enabled', 'paused', 'blocked'] as const;
export type BotRoutineStatus = (typeof BOT_ROUTINE_STATUSES)[number];
export const BOT_ROUTINE_TRIGGERS = ['scheduled', 'manual', 'catchup', 'dry-run'] as const;
export type BotRoutineTrigger = (typeof BOT_ROUTINE_TRIGGERS)[number];
export const BOT_ROUTINE_BLOCKS = [
  'executor-missing',
  'executor-archived',
  'chat-missing',
  'chat-archived',
  'not-in-chat',
  'acl',
] as const;
export type BotRoutineBlock = (typeof BOT_ROUTINE_BLOCKS)[number];

/** userData/bots/<botId>/routines.json 的一条；触发后作为系统消息投进 chatId */
export interface BotRoutine {
  id: string;
  /** 归属成员（按它存放）；未指定 doneBy 时也是执行者 */
  botId: BotId;
  title: string;
  prompt: string;
  /** 5 段 cron，本地时区 */
  schedule: string;
  chatId: BotChatId;
  status: BotRoutineStatus;
  /** 标题 / 提示词 / 执行者 / 调度 / 目标聊天变更 +1 */
  procedureVersion: number;
  /** 用户批准的版本；与 procedureVersion 相等才会按调度或手动运行 */
  approvedVersion?: number;
  /** 由另一位成员执行（受委派 ACL 约束） */
  doneBy?: BotId;
  /** 应用关闭期间错过时，启动后补跑最近一次 */
  catchUp: boolean;
  /** 成员经 routine_propose 提议 / 改动 */
  proposedBy?: BotId;
  blockedReason?: BotRoutineBlock;
  /** 已处理到的调度时刻；之后、当前之前的时刻视为错过 */
  cursor?: number;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastResult?: BotRoutineResult;
  /** 应用未运行期间错过、未补跑的次数，截断到 99 */
  missed?: number;
}

export const isRoutineApproved = (routine: BotRoutine): boolean =>
  routine.approvedVersion === routine.procedureVersion;
export const routineExecutor = (routine: BotRoutine): BotId => routine.doneBy ?? routine.botId;
/** 执行占用与投递去重的键：同一例程同一调度时刻只跑一次 */
export const routineDeliveryId = (routineId: string, scheduledFor: number): string =>
  `routine:${routineId}:${scheduledFor}`;

const isVersion = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;

export function parseBotRoutine(value: unknown): BotRoutine | undefined {
  if (!isObject(value) || !isBotId(value.id) || !isBotId(value.botId)) return undefined;
  if (!isBotChatId(value.chatId)) return undefined;
  if (!isText(value.title) || !isText(value.prompt) || typeof value.schedule !== 'string') {
    return undefined;
  }
  const cron = parseCron(value.schedule);
  if (!cron || !isTime(value.createdAt) || !isTime(value.updatedAt)) return undefined;
  const legacy = value.status === undefined;
  if (legacy && typeof value.enabled !== 'boolean') return undefined;
  const status = legacy ? (value.enabled ? 'enabled' : 'paused') : value.status;
  if (!BOT_ROUTINE_STATUSES.includes(status as BotRoutineStatus)) return undefined;
  const procedureVersion = legacy ? 1 : value.procedureVersion;
  const approvedVersion = legacy ? 1 : value.approvedVersion;
  if (!isVersion(procedureVersion)) return undefined;
  if (
    approvedVersion !== undefined &&
    (!isVersion(approvedVersion) || approvedVersion > procedureVersion)
  )
    return undefined;
  const routine: BotRoutine = {
    id: value.id,
    botId: value.botId,
    title: value.title,
    prompt: value.prompt,
    schedule: cron.source,
    chatId: value.chatId,
    status: status as BotRoutineStatus,
    procedureVersion,
    ...(approvedVersion !== undefined ? { approvedVersion } : {}),
    catchUp: value.catchUp !== false,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (isBotId(value.doneBy)) routine.doneBy = value.doneBy;
  if (isBotId(value.proposedBy)) routine.proposedBy = value.proposedBy;
  if (BOT_ROUTINE_BLOCKS.includes(value.blockedReason as BotRoutineBlock))
    routine.blockedReason = value.blockedReason as BotRoutineBlock;
  if (isTime(value.cursor)) routine.cursor = value.cursor;
  if (isTime(value.lastRunAt)) routine.lastRunAt = value.lastRunAt;
  if (BOT_ROUTINE_RESULTS.includes(value.lastResult as BotRoutineResult)) {
    routine.lastResult = value.lastResult as BotRoutineResult;
  }
  if (isSeq(value.missed) && value.missed > 0)
    routine.missed = Math.min(MISSED_RUNS_MAX, value.missed);
  return routine;
}

/** userData/bots/<botId>/routine-runs.jsonl 的一条快照（同 runId 后写覆盖）；未结算即占用 */
export interface BotRoutineRun {
  runId: string;
  routineId: string;
  botId: BotId;
  executorId: BotId;
  chatId: BotChatId;
  trigger: BotRoutineTrigger;
  scheduledFor: number;
  startedAt: number;
  finishedAt?: number;
  result?: BotRoutineResult;
  conversationId?: string;
  error?: string;
}

export function parseBotRoutineRun(value: unknown): BotRoutineRun | undefined {
  if (!isObject(value) || !isBotId(value.routineId) || !isBotId(value.botId)) return undefined;
  if (!isBotId(value.executorId) || !isBotChatId(value.chatId)) return undefined;
  if (!BOT_ROUTINE_TRIGGERS.includes(value.trigger as BotRoutineTrigger)) return undefined;
  if (!isSeq(value.scheduledFor) || !isTime(value.startedAt)) return undefined;
  if (value.runId !== routineDeliveryId(value.routineId, value.scheduledFor)) return undefined;
  if (value.result !== undefined && !BOT_ROUTINE_RESULTS.includes(value.result as never))
    return undefined;
  const run: BotRoutineRun = {
    runId: value.runId,
    routineId: value.routineId,
    botId: value.botId,
    executorId: value.executorId,
    chatId: value.chatId,
    trigger: value.trigger as BotRoutineTrigger,
    scheduledFor: value.scheduledFor,
    startedAt: value.startedAt,
  };
  if (isTime(value.finishedAt)) run.finishedAt = value.finishedAt;
  if (value.result !== undefined) run.result = value.result as BotRoutineResult;
  if (isText(value.conversationId)) run.conversationId = value.conversationId;
  if (isText(value.error)) run.error = value.error.slice(0, 2000);
  return run;
}

/** review：委派交付、执行人不是创建人时待创建人或人类验收；blocked：卡住（缺信息 / 执行失败，schemaVersion 2） */
export const GROUP_TASK_STATUSES = [
  'todo',
  'doing',
  'review',
  'done',
  'canceled',
  'blocked',
] as const;
export type GroupTaskStatus = (typeof GROUP_TASK_STATUSES)[number];
export const GROUP_TASK_BLOCKED_REASONS = ['need', 'failed'] as const;
export type GroupTaskBlockedReason = (typeof GROUP_TASK_BLOCKED_REASONS)[number];
/** 同一「任务 × 成员」连续缺信息卡住这么多次后只接受人来解除 */
export const GROUP_TASK_BLOCKED_STREAK_MAX = 3;
export const GROUP_TASK_TITLE_MAX = 200;
export const GROUP_TASK_TEXT_MAX = 4000;
export const GROUP_TASK_RUNS_MAX = 30;

/** 任务的一次执行（委派记录）摘要 */
export interface GroupTaskRun {
  /** 委派记录 id */
  id: string;
  botId: BotId;
  trigger: DelegationTrigger;
  state: DelegationState;
  failure?: Delegation['failure'];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** 执行人转派出去的嵌套执行（深度 2） */
  nested?: true;
  /** 并入这次执行的追加条数 */
  appends?: number;
}

/** userData/bot-chats/<chatId>/tasks.jsonl 的一条快照；seq 群内自增，显示为 #N */
export interface GroupTask {
  id: string;
  seq: number;
  title: string;
  detail?: string;
  status: GroupTaskStatus;
  assigneeBotId?: BotId;
  createdBy: 'human' | BotId;
  delegationId?: string;
  /** 完成说明 */
  result?: string;
  /** 最近一次验收退回的原因；验收通过时清除 */
  returnReason?: string;
  /** 验收条件；passed 为最近一次校验结果 */
  check?: TaskCheck;
  /** 成员认领 / 被指派的时间：complete 验收只看此后的工具结果 */
  claimedAt?: number;
  /** 历次执行摘要，按发起先后，只留最近 GROUP_TASK_RUNS_MAX 条 */
  runs?: GroupTaskRun[];
  /** 成员 → 该任务的委派子会话 */
  sessions?: Record<BotId, string>;
  /** status 为 blocked 时：need = 执行人缺信息，failed = 执行失败（原因见当前执行） */
  blockedReason?: GroupTaskBlockedReason;
  /** 缺什么（blockedReason 为 need 时） */
  blockedNeed?: string;
  /** 成员 → 在本任务上连续缺信息卡住的次数；交付后清零，执行失败不计 */
  blockedStreak?: Record<BotId, number>;
  createdAt: number;
  updatedAt: number;
}

/** 任务卡在执行失败上：仍由执行人负责，只能重试、改派或取消（含 P2 旧数据：doing + 当前执行失败） */
export function stalledTaskRun(task: GroupTask): GroupTaskRun | undefined {
  if (!task.delegationId) return undefined;
  if (task.status === 'blocked' ? task.blockedReason === 'need' : task.status !== 'doing')
    return undefined;
  const run = task.runs?.find((item) => item.id === task.delegationId);
  if (run?.state === 'failed') return run;
  return task.status === 'blocked'
    ? {
        id: task.delegationId,
        botId: task.assigneeBotId ?? '',
        trigger: 'delegate',
        state: 'failed',
        failure: 'error',
        createdAt: task.updatedAt,
      }
    : undefined;
}

/** 任务为什么卡住；没卡住返回 undefined */
export function taskBlock(
  task: GroupTask
):
  | { reason: 'need'; need: string }
  | { reason: 'failed'; failure: NonNullable<Delegation['failure']> }
  | undefined {
  if (task.status === 'blocked' && task.blockedReason === 'need')
    return { reason: 'need', need: task.blockedNeed ?? '' };
  const run = stalledTaskRun(task);
  return run ? { reason: 'failed', failure: run.failure ?? 'error' } : undefined;
}

export const TASK_CHECK_TEXT_MAX = 200;

/** 可验证完成条件：工具最终输出里包含 text */
export interface TaskCheck {
  kind: 'output-contains';
  text: string;
  passed?: boolean;
}

export function parseTaskCheck(value: unknown): TaskCheck | undefined {
  if (!isObject(value) || value.kind !== 'output-contains' || typeof value.text !== 'string')
    return undefined;
  const text = value.text.trim();
  if (!text || text.length > TASK_CHECK_TEXT_MAX) return undefined;
  return {
    kind: 'output-contains',
    text,
    ...(typeof value.passed === 'boolean' ? { passed: value.passed } : {}),
  };
}

export function parseGroupTask(value: unknown): GroupTask | undefined {
  if (
    !isObject(value) ||
    !isBotId(value.id) ||
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 1 ||
    !isText(value.title) ||
    value.title.length > GROUP_TASK_TITLE_MAX ||
    !GROUP_TASK_STATUSES.includes(value.status as GroupTaskStatus) ||
    (value.createdBy !== 'human' && !isBotId(value.createdBy)) ||
    !isTime(value.createdAt) ||
    !isTime(value.updatedAt)
  )
    return undefined;
  const task: GroupTask = {
    id: value.id,
    seq: value.seq as number,
    title: value.title,
    status: value.status as GroupTaskStatus,
    createdBy: value.createdBy as GroupTask['createdBy'],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (isText(value.detail)) task.detail = value.detail.slice(0, GROUP_TASK_TEXT_MAX);
  if (isBotId(value.assigneeBotId)) task.assigneeBotId = value.assigneeBotId;
  if (isBotId(value.delegationId)) task.delegationId = value.delegationId;
  if (isText(value.result)) task.result = value.result.slice(0, GROUP_TASK_TEXT_MAX);
  if (isText(value.returnReason))
    task.returnReason = value.returnReason.slice(0, GROUP_TASK_TEXT_MAX);
  const check = parseTaskCheck(value.check);
  if (check) task.check = check;
  if (isTime(value.claimedAt)) task.claimedAt = value.claimedAt;
  if (Array.isArray(value.runs)) {
    const runs = value.runs.flatMap((item) => parseGroupTaskRun(item) ?? []);
    if (runs.length) task.runs = runs.slice(-GROUP_TASK_RUNS_MAX);
  }
  if (isObject(value.sessions)) {
    const sessions = Object.entries(value.sessions).filter(
      (entry): entry is [BotId, string] => isBotId(entry[0]) && isText(entry[1])
    );
    if (sessions.length) task.sessions = Object.fromEntries(sessions);
  }
  if (GROUP_TASK_BLOCKED_REASONS.includes(value.blockedReason as never))
    task.blockedReason = value.blockedReason as GroupTaskBlockedReason;
  if (isText(value.blockedNeed))
    task.blockedNeed = value.blockedNeed.slice(0, DELEGATION_BLOCKED_NEED_MAX);
  if (isObject(value.blockedStreak)) {
    const streak = Object.entries(value.blockedStreak).filter(
      (entry): entry is [BotId, number] =>
        isBotId(entry[0]) && Number.isSafeInteger(entry[1]) && (entry[1] as number) > 0
    );
    if (streak.length) task.blockedStreak = Object.fromEntries(streak);
  }
  return task;
}

function parseGroupTaskRun(value: unknown): GroupTaskRun | undefined {
  if (
    !isObject(value) ||
    !isBotId(value.id) ||
    !isBotId(value.botId) ||
    !DELEGATION_TRIGGERS.includes(value.trigger as never) ||
    !DELEGATION_STATES.includes(value.state as never) ||
    !isTime(value.createdAt)
  )
    return undefined;
  const run: GroupTaskRun = {
    id: value.id,
    botId: value.botId,
    trigger: value.trigger as DelegationTrigger,
    state: value.state as DelegationState,
    createdAt: value.createdAt,
  };
  if (DELEGATION_FAILURES.includes(value.failure as never))
    run.failure = value.failure as Delegation['failure'];
  if (isTime(value.startedAt)) run.startedAt = value.startedAt;
  if (isTime(value.finishedAt)) run.finishedAt = value.finishedAt;
  if (value.nested === true) run.nested = true;
  if (Number.isSafeInteger(value.appends) && Number(value.appends) > 0)
    run.appends = Number(value.appends);
  return run;
}
