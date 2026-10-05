import type { BotChat, BotId, BotProfile, GroupEntry } from '../types/bot';
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
}

export type HumanDecision =
  | { action: 'start'; state: RouterState }
  | { action: 'steer' }
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
function humanTargets(
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

function nameOf(members: readonly RouterMember[], id: BotId): string {
  return members.find((m) => m?.id === id)?.name ?? id;
}

/**
 * 当前回复人说完：解析其回复里的 @ 接力，超出上限的拦下并提示。
 * delegated：本轮刚委派出去的成员，结果会经委派回传，正文 @ 他们不再接力。
 * 群主 @ 派出的成员都回复后（最后一条没 @ 群主），给群主追加一跳汇总提醒。
 */
export function onReply(
  state: RouterState,
  chat: RouterChat,
  members: readonly RouterMember[],
  reply: { botId: BotId; text: string; delegated?: readonly BotId[]; seq?: number }
): ReplyResult {
  if (state.current === null || reply.botId !== state.current) {
    return { state, next: state.current, skipped: false, notices: [] };
  }
  const skipped = isSkipReply(reply.text);
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
  if (waiting.includes(reply.botId)) {
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
  if (reply.botId === boss) waiting = [...waiting, ...relayed];
  const { waiting: _w, reports: _r, ...rest } = state;
  const next = advance({
    ...rest,
    queue,
    hops,
    noticed,
    turnsByBot,
    ...(waiting.length > 0 ? { waiting, reports } : {}),
  });
  return { state: next, next: next.current, skipped, notices, ...(summary ? { summary } : {}) };
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
 * 有成员在回复时来了新人类消息：只 @ 当前回复人 → steer；
 * 否则等当前说完，丢弃剩余队列，用 mergePending(这段时间的人类消息) 重新 startRound。
 */
export function onHumanMessage(
  state: RouterState,
  chat: RouterChat,
  members: readonly RouterMember[],
  humanEntry: HumanEntry
): HumanDecision {
  if (state.current === null)
    return { action: 'start', state: startRound(chat, members, humanEntry) };
  const targets = humanTargets(chat, members, humanEntry);
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
