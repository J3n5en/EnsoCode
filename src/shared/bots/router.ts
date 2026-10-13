import type { BotChat, BotId, BotProfile, GroupEntry } from '../types/bot';
import { type DiscussEndReason, discussCap, hasNewContent } from './discussWrapUp';
import { namedMentions, parseMentions } from './mentions';

export type RouterMember = Pick<BotProfile, 'id' | 'name'> & { archivedAt?: number };
export type HumanEntry = Extract<GroupEntry, { kind: 'human' }>;
type RouterChat = Pick<BotChat, 'members' | 'bossBotId' | 'routing'>;

/** 一条人类消息引发的一轮回复；current 是正在回复的成员 */
export interface RouterState {
  rootEntrySeq: number;
  queue: BotId[];
  current: BotId | null;
  /** 成员之间 @ 接力的次数（人类直接 @ 的不计） */
  hops: number;
  /** 本轮每个成员已开始回复的次数 */
  turnsByBot: Record<BotId, number>;
  /** 已发过的上限提示：'hops' 或 'turns:<botId>'，每种只提示一次 */
  noticed: string[];
  /** 群主本轮 @ 派出、尚未回复的成员；清空时提醒群主汇总 */
  waiting?: BotId[];
  /** 已回复的派单成员；[skip] / 未能回复的没有 seq */
  reports?: SummaryReport[];
  /** 讨论模式（仅 smart 群）：成员说完且没 @ 人时，由判断模型决定下一位或结束 */
  discuss?: true;
  /**
   * 以下讨论计数只在 discuss 时存在（#33）；router.json 里只用于崩溃恢复，重启不重放讨论或收尾。
   * discussTurns：讨论主链已开始的成员回合（含 [skip] 与失败，不含并行投递与收尾），对比安全上限。
   */
  discussTurns?: number;
  /** 讨论主链的有效发言条数（非 [skip]、非失败），决定结束时是否收尾 */
  discussReplies?: number;
  /** 讨论主链最新一条有效发言的 seq */
  discussLastSeq?: number;
  /** 各成员上次发言（含 [skip] 与失败）时看到的最新有效发言 seq：之后没有新发言就不进候选 */
  discussSeen?: Record<BotId, number>;
  /** 讨论结束后群主正在收尾：回复里的 @ 只是提醒，不接力 */
  wrapUp?: true;
  /**
   * 成员自选（turns，#22）进行中：成员按顺序多轮发言，每人自己判断说不说。
   * 与 discuss 互斥；安全上限、有效发言与「有新内容才发言」复用上面的 discussTurns / discussReplies /
   * discussLastSeq / discussSeen。router.json 里只用于崩溃恢复，重启不续跑
   */
  turns?: TurnsProgress;
}

export interface TurnsProgress {
  /** 当前第几轮，从 1 开始 */
  round: number;
  /** 参与者的基础顺序：群主第一，其余按群成员顺序；第 r 轮按 (r-1) 轮换 */
  order: BotId[];
  /** 人类点名 @ 的成员（@所有人 不展开）：静音成员只有被点名才参与 */
  named: BotId[];
  /** 本轮有效发言条数 */
  spoke: number;
  /** 本轮失败（回复失败、预算用完、投递失败）的人数 */
  failed: number;
  /** 本条消息内失败过的成员：后面的轮次不再排 */
  out?: BotId[];
  /** 本轮有人发起了委派：本轮说完就结束，不开下一轮、不收尾 */
  last?: true;
  /** 最近一条有效发言的成员 */
  lastBy?: BotId;
}

export interface SummaryReport {
  botId: BotId;
  seq?: number;
}

export interface ReplyResult {
  state: RouterState;
  /** 现在应当回复的成员（= state.current） */
  next: BotId | null;
  skipped: boolean;
  /** 需写入时间线的 system 提示 */
  notices: string[];
  /** 本次追加了一跳群主汇总提醒 */
  summary?: { botId: BotId; reports: SummaryReport[] };
  /** 回复里解析出了别的成员的 @（含被上限拦下的）；讨论模式据此不再判断 */
  mentioned: boolean;
}

export type HumanDecision =
  | { action: 'start'; state: RouterState }
  | { action: 'steer' }
  | { action: 'parallel'; targets: BotId[] }
  | { action: 'route-parallel' }
  | { action: 'restart-after-current' };

/** 群内且未归档的成员，按群成员顺序；speaking 时再去掉静音成员 */
function activeMembers(
  chat: RouterChat,
  members: readonly RouterMember[],
  speaking = false
): RouterMember[] {
  const list = Array.isArray(members) ? members.filter((m) => m && typeof m.id === 'string') : [];
  const muted = speaking ? mutedOf(chat) : [];
  return chat.members.flatMap((id) => {
    const member = list.find((m) => m.id === id);
    return member && member.archivedAt === undefined && !muted.includes(id) ? [member] : [];
  });
}

const mutedOf = (chat: RouterChat): BotId[] =>
  Array.isArray(chat.routing.muted) ? chat.routing.muted : [];

function inChatMembers(chat: RouterChat, members: readonly RouterMember[]): RouterMember[] {
  const inChat = (Array.isArray(members) ? members : []).filter(
    (m) => m && chat.members.includes(m.id)
  );
  return chat.members.flatMap((id) => inChat.filter((m) => m.id === id));
}

/** 正文含 @所有人 时，静音成员只有被点名 @ 才保留 */
function dropMuted(
  chat: RouterChat,
  members: readonly RouterMember[],
  text: string,
  ids: BotId[]
): BotId[] {
  const muted = mutedOf(chat);
  if (!ids.some((id) => muted.includes(id))) return ids;
  const inChat = inChatMembers(chat, members);
  if (!parseMentions(text, inChat).all) return ids;
  const named = namedMentions(text, inChat);
  return ids.filter((id) => !muted.includes(id) || named.includes(id));
}

/** 群成员（含已归档）都参与名字匹配，避免 @归档者 被误配到更短的名字 */
function mentionedActive(
  chat: RouterChat,
  members: readonly RouterMember[],
  ids: BotId[]
): BotId[] {
  const active = new Set(activeMembers(chat, members).map((m) => m.id));
  return [...new Set(ids)].filter((id) => active.has(id));
}

function parseActive(chat: RouterChat, members: readonly RouterMember[], text: string): BotId[] {
  const ids = parseMentions(text, inChatMembers(chat, members)).ids;
  return dropMuted(chat, members, text, mentionedActive(chat, members, ids));
}

/** entry.mentions 为权威（Main 写入时计算）；为空时回退解析正文 */
export function humanTargets(
  chat: RouterChat,
  members: readonly RouterMember[],
  entry: HumanEntry
): BotId[] {
  const stored = Array.isArray(entry.mentions) ? entry.mentions : [];
  return stored.length > 0
    ? dropMuted(chat, members, entry.text, mentionedActive(chat, members, stored))
    : parseActive(chat, members, entry.text);
}

function advance(state: RouterState): RouterState {
  const [next = null, ...queue] = state.queue;
  if (next === null) return { ...state, queue, current: null };
  return {
    ...state,
    queue,
    current: next,
    turnsByBot: { ...state.turnsByBot, [next]: (state.turnsByBot[next] ?? 0) + 1 },
    ...(state.discuss ? { discussTurns: (state.discussTurns ?? 0) + 1 } : {}),
  };
}

/** 进入讨论：首位发言人（已开始）计一次，排队的首轮名单在开始时各计一次 */
export function startDiscussion(state: RouterState): RouterState {
  return {
    ...state,
    discuss: true,
    discussTurns: state.current ? 1 : 0,
    discussReplies: 0,
  };
}

function withoutDiscussion(state: RouterState): RouterState {
  const {
    discuss: _discuss,
    discussTurns: _turns,
    discussReplies: _replies,
    discussLastSeq: _lastSeq,
    discussSeen: _seen,
    ...rest
  } = state;
  return rest;
}

/**
 * 讨论中途结束（委派 / 开关关闭）：去掉讨论标记与计数，丢掉还没发言的候选；
 * 讨论里的发言次数不带进之后的普通接力（只记当前发言者这一次），maxTurnsPerBot 按全新额度算
 */
export function clearDiscussion(state: RouterState): RouterState {
  return {
    ...withoutDiscussion(state),
    queue: [],
    turnsByBot: state.current ? { [state.current]: 1 } : {},
  };
}

/** 讨论结束后由群主收尾：不再是讨论，派单名单作废（收尾不追加汇总跳） */
export function startWrapUp(state: RouterState, bossId: BotId): RouterState {
  const { waiting: _waiting, reports: _reports, ...rest } = withoutDiscussion(state);
  return {
    ...rest,
    queue: [],
    current: bossId,
    wrapUp: true,
    turnsByBot: { ...state.turnsByBot, [bossId]: (state.turnsByBot[bossId] ?? 0) + 1 },
  };
}

/**
 * 收尾中途转回普通接力（开关关闭时群主已在收尾）：去掉收尾标记，与 clearDiscussion 同一口径——
 * 讨论里的发言次数不带进之后的普通接力，只记当前发言者（群主）这一次，maxTurnsPerBot 按全新额度算
 */
export function clearWrapUp(state: RouterState): RouterState {
  const { wrapUp: _wrapUp, ...rest } = state;
  return {
    ...rest,
    queue: [],
    turnsByBot: state.current ? { [state.current]: 1 } : {},
  };
}

export function startRound(
  chat: RouterChat,
  members: readonly RouterMember[],
  humanEntry: HumanEntry,
  /** 智能选人名单（顺序即回复顺序）；去重并滤掉不在群、已归档或静音的，为空时退回群主 */
  picked: readonly BotId[] = []
): RouterState {
  let targets = humanTargets(chat, members, humanEntry);
  if (targets.length === 0 && Array.isArray(picked)) {
    const speaking = new Set(activeMembers(chat, members, true).map((m) => m.id));
    targets = [...new Set(picked)].filter((id) => speaking.has(id));
  }
  if (targets.length === 0 && chat.bossBotId)
    targets = mentionedActive(chat, members, [chat.bossBotId]);
  return advance({
    rootEntrySeq: humanEntry.seq,
    queue: targets,
    current: null,
    hops: 0,
    turnsByBot: {},
    noticed: [],
  });
}

/** 智能选人只接管：smart 模式、人类消息没有任何 @（含 @所有人、@已归档成员），且至少两位未静音成员 */
export function needsSmartRoute(
  chat: RouterChat,
  members: readonly RouterMember[],
  humanEntry: HumanEntry
): boolean {
  if (chat.routing.mode !== 'smart') return false;
  if (Array.isArray(humanEntry.mentions) && humanEntry.mentions.length > 0) return false;
  const inChat = (Array.isArray(members) ? members : []).filter(
    (m) => m && chat.members.includes(m.id)
  );
  const parsed = parseMentions(humanEntry.text, inChat);
  if (parsed.all || parsed.ids.length > 0) return false;
  return activeMembers(chat, members, true).length >= 2;
}

export const isSkipReply = (text: string): boolean =>
  typeof text === 'string' && text.trim().toLowerCase() === '[skip]';

/** 去掉空白与不可见格式字符（零宽空格/连接符、词连接符、BOM）后为空；只用于判定，不改正文 */
export const isBlankReply = (text: string): boolean =>
  typeof text !== 'string' || /^(?:\s|\u200b|\u200c|\u200d|\u2060|\ufeff)*$/.test(text);

function nameOf(members: readonly RouterMember[], id: BotId): string {
  return members.find((m) => m?.id === id)?.name ?? id;
}

/**
 * 当前回复人说完：解析其回复里的 @ 接力，超出上限的拦下并提示。
 * delegated：本轮刚委派出去的成员，结果会经委派回传，正文 @ 他们不再接力。
 * 群主 @ 派出的成员都回复后（最后一条没 @ 群主），给群主追加一跳汇总提醒。
 * 讨论中（discuss）：@ 接力不看 maxHops / maxTurnsPerBot，只受安全上限（已用 + 排队）限制，拦下不提示；
 * 不记派单名单、不追加汇总跳；记录有效发言与各人看到的位置。
 * 收尾中（wrapUp）：不解析 @、不计次数、不入队，说完本轮即结束。
 */
export function onReply(
  state: RouterState,
  chat: RouterChat,
  members: readonly RouterMember[],
  reply: { botId: BotId; text: string; delegated?: readonly BotId[]; seq?: number }
): ReplyResult {
  if (state.current === null || reply.botId !== state.current) {
    return { state, next: state.current, skipped: false, notices: [], mentioned: false };
  }
  const skipped = isSkipReply(reply.text);
  if (state.wrapUp) {
    const { wrapUp: _wrapUp, waiting: _w, reports: _r, ...rest } = state;
    return {
      state: { ...rest, queue: [], current: null },
      next: null,
      skipped,
      notices: [],
      mentioned: false,
    };
  }
  const discuss = state.discuss === true;
  const cap = discuss ? discussCap(chat.routing) : 0;
  const queue = [...state.queue];
  const noticed = [...state.noticed];
  const notices: string[] = [];
  const hopBlocked: string[] = [];
  const relayed: BotId[] = [];
  let hops = state.hops;
  // [skip] 不算一次回复，不占 maxTurnsPerBot
  const turnsByBot = skipped
    ? { ...state.turnsByBot, [reply.botId]: Math.max(0, (state.turnsByBot[reply.botId] ?? 0) - 1) }
    : state.turnsByBot;
  const targets = skipped ? [] : parseActive(chat, members, reply.text);
  const delegated = Array.isArray(reply.delegated) ? reply.delegated : [];
  for (const id of targets) {
    if (id === reply.botId || queue.includes(id) || delegated.includes(id)) continue;
    if (discuss) {
      // 已用 + 排队到安全上限时静默拦下，由 discussStep 统一按 cap 结束并提示
      if ((state.discussTurns ?? 0) + queue.length < cap) {
        queue.push(id);
        relayed.push(id);
      }
      continue;
    }
    const turns = turnsByBot[id] ?? 0;
    if (turns >= chat.routing.maxTurnsPerBot) {
      if (!noticed.includes(`turns:${id}`)) {
        noticed.push(`turns:${id}`);
        notices.push(`「${nameOf(members, id)}」本轮已回复 ${turns} 次，达到上限，不再接力给 TA。`);
      }
    } else if (hops >= chat.routing.maxHops) {
      hopBlocked.push(nameOf(members, id));
    } else {
      hops += 1;
      queue.push(id);
      relayed.push(id);
    }
  }
  if (hopBlocked.length > 0 && !noticed.includes('hops')) {
    noticed.push('hops');
    notices.push(
      `本轮接力已达上限（${chat.routing.maxHops} 次），未再交给「${hopBlocked.join('」「')}」。`
    );
  }
  let waiting = Array.isArray(state.waiting) ? state.waiting : [];
  let reports = Array.isArray(state.reports) ? state.reports : [];
  let summary: ReplyResult['summary'];
  const boss = chat.bossBotId;
  if (!discuss && waiting.includes(reply.botId)) {
    waiting = waiting.filter((id) => id !== reply.botId);
    const seq = skipped || typeof reply.seq !== 'number' ? {} : { seq: reply.seq };
    reports = [...reports, { botId: reply.botId, ...seq }];
    if (
      waiting.length === 0 &&
      boss &&
      reports.some((r) => typeof r.seq === 'number') &&
      !targets.includes(boss) &&
      !queue.includes(boss) &&
      mentionedActive(chat, members, [boss]).length > 0
    ) {
      const turns = turnsByBot[boss] ?? 0;
      const name = nameOf(members, boss);
      if (turns >= chat.routing.maxTurnsPerBot) {
        if (!noticed.includes(`turns:${boss}`)) {
          noticed.push(`turns:${boss}`);
          notices.push(`「${name}」本轮已回复 ${turns} 次，达到上限，未再请 TA 汇总。`);
        }
      } else if (hops >= chat.routing.maxHops) {
        if (!noticed.includes('hops')) {
          noticed.push('hops');
          notices.push(`本轮接力已达上限（${chat.routing.maxHops} 次），未再请「${name}」汇总。`);
        }
      } else {
        hops += 1;
        queue.push(boss);
        summary = { botId: boss, reports };
      }
    }
  }
  if (!discuss && reply.botId === boss) waiting = [...waiting, ...relayed];
  const progress: Partial<RouterState> = {};
  if (discuss) {
    const valid = !skipped && typeof reply.seq === 'number';
    const lastSeq = valid
      ? Math.max(state.discussLastSeq ?? 0, reply.seq as number)
      : state.discussLastSeq;
    progress.discussReplies = (state.discussReplies ?? 0) + (valid ? 1 : 0);
    if (lastSeq !== undefined) progress.discussLastSeq = lastSeq;
    progress.discussSeen = {
      ...(state.discussSeen ?? {}),
      [reply.botId]: lastSeq ?? state.rootEntrySeq,
    };
  }
  const { waiting: _w, reports: _r, ...rest } = state;
  const next = advance({
    ...rest,
    ...progress,
    queue,
    hops,
    noticed,
    turnsByBot,
    ...(waiting.length > 0 ? { waiting, reports } : {}),
  });
  return {
    state: next,
    next: next.current,
    skipped,
    notices,
    mentioned: targets.some((id) => id !== reply.botId),
    ...(summary ? { summary } : {}),
  };
}

export type DiscussStep =
  | { kind: 'none' }
  | { kind: 'judge'; candidates: BotId[] }
  | { kind: 'end'; reason: Extract<DiscussEndReason, 'cap' | 'idle'> };

/**
 * 讨论中可接话的成员：在群、未归档、未静音、不是刚说完的那位，且自上次发言以来有新的有效发言
 * （不看 maxTurnsPerBot，总量由安全上限兜底）
 */
function discussCandidates(
  state: RouterState,
  chat: RouterChat,
  members: readonly RouterMember[],
  lastBotId: BotId
): BotId[] {
  const latest = state.discussLastSeq ?? state.rootEntrySeq;
  const seen = state.discussSeen ?? {};
  return activeMembers(chat, members, true)
    .filter((m) => m.id !== lastBotId && hasNewContent(seen[m.id], latest))
    .map((m) => m.id);
}

/**
 * 讨论中一位成员说完、接力队列已空：回复里 @ 了人 / 本回合委派了 / 有待处理的人类消息时不判断；
 * 到安全上限（优先于 @：@ 被上限拦下也要结束）或没人可选时结束并给出原因，
 * 否则交给判断模型从 candidates 里选下一位或结束。
 */
export function discussStep(
  state: RouterState,
  chat: RouterChat,
  members: readonly RouterMember[],
  input: { lastBotId: BotId; mentioned: boolean; delegated: boolean; pendingHuman: boolean }
): DiscussStep {
  if (!state.discuss || state.current !== null || state.queue.length > 0) return { kind: 'none' };
  if (input.delegated || input.pendingHuman) return { kind: 'none' };
  if ((state.discussTurns ?? 0) >= discussCap(chat.routing)) return { kind: 'end', reason: 'cap' };
  if (input.mentioned) return { kind: 'none' };
  const candidates = discussCandidates(state, chat, members, input.lastBotId);
  if (candidates.length > 0) return { kind: 'judge', candidates };
  return { kind: 'end', reason: 'idle' };
}

/** 应用判断结果：按当前群况重新校验选中的人，计一次讨论发言（不计 hop）；到上限或不合法返回 null */
export function discussPick(
  state: RouterState,
  chat: RouterChat,
  members: readonly RouterMember[],
  botId: BotId,
  lastBotId: BotId
): RouterState | null {
  if (!state.discuss || state.current !== null) return null;
  if ((state.discussTurns ?? 0) >= discussCap(chat.routing)) return null;
  if (!discussCandidates(state, chat, members, lastBotId).includes(botId)) return null;
  return {
    ...state,
    queue: [],
    current: botId,
    discussTurns: (state.discussTurns ?? 0) + 1,
    turnsByBot: { ...state.turnsByBot, [botId]: (state.turnsByBot[botId] ?? 0) + 1 },
  };
}

export function buildSummaryNote(
  members: readonly RouterMember[],
  reports: readonly SummaryReport[]
): string {
  const list = reports
    .map(
      (r) =>
        `「${nameOf(members, r.botId)}」${typeof r.seq === 'number' ? `（seq ${r.seq}）` : '（未发言）'}`
    )
    .join('、');
  return `你派出的成员都已回复：${list}。请在群里汇总结论或决定下一步，不要复述他们的原话；需要原文可用 group_history 按 seq 查。`;
}

/**
 * 只 @ 当前回复人 → steer；@ 其他成员 → 独立投递，不改原接力；
 * 无 @ 时独立选人，不替换当前轮次。
 */
export function onHumanMessage(
  state: RouterState,
  chat: RouterChat,
  members: readonly RouterMember[],
  humanEntry: HumanEntry
): HumanDecision {
  if (state.current === null)
    return { action: 'start', state: startRound(chat, members, humanEntry) };
  const parsed = parseMentions(humanEntry.text, inChatMembers(chat, members));
  if (!humanEntry.mentions?.length && !parsed.all && !parsed.ids.length)
    // 讨论 / 收尾中不打断正在说话的成员：等他说完放弃剩下的讨论，按新消息重开（与 Grok 的 epoch 取消一致）
    return state.discuss || state.wrapUp
      ? { action: 'restart-after-current' }
      : { action: 'route-parallel' };
  const targets = humanTargets(chat, members, humanEntry);
  const others = targets.filter((id) => id !== state.current);
  if (others.length) return { action: 'parallel', targets };
  return targets.length === 1 && targets[0] === state.current
    ? { action: 'steer' }
    : { action: 'restart-after-current' };
}

/**
 * 连发合并：取最后一条人类消息（seq/正文/时间以它为准），
 * mentions 为各条 mentions 按时间顺序去重并集；非人类条目忽略。
 */
export function mergePending(entries: readonly GroupEntry[]): HumanEntry | null {
  const humans = (Array.isArray(entries) ? entries : []).filter(
    (e): e is HumanEntry => e?.kind === 'human'
  );
  const last = humans.at(-1);
  if (!last) return null;
  const mentions = [
    ...new Set(humans.flatMap((e) => (Array.isArray(e.mentions) ? e.mentions : []))),
  ];
  return { ...last, mentions };
}

/**
 * 条目能否触发/延续路由：人类消息可以；bot 消息只有来自该成员本群会话时可以
 * （系统以成员名义代写的委派结果来自委派会话，不路由）；delegation/system 不路由。
 */
export function shouldRoute(entry: GroupEntry, chat: Pick<BotChat, 'sessions'>): boolean {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.kind === 'human') return true;
  if (entry.kind !== 'bot') return false;
  const session = chat.sessions[entry.botId];
  return Boolean(session) && session.conversationId === entry.conversationId;
}
