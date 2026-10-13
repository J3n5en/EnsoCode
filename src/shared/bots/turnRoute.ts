import type { BotChat, BotId } from '../types/bot';
import {
  DISCUSS_WRAP_UP_MIN_REPLIES,
  discussCap,
  hasNewContent,
  planWrapUp,
  type WrapUpPlan,
  wrapUpOwner,
} from './discussWrapUp';
import { namedMentions, parseMentions } from './mentions';
import {
  type HumanEntry,
  humanTargets,
  type RouterMember,
  type RouterState,
  startWrapUp,
  type TurnsProgress,
} from './router';

/**
 * 成员自选（turns，#22）：一条人类消息后，参与者按顺序多轮发言，每人按人设和职责自己判断说不说（[skip]）。
 * 第 1 轮所有参与者都跑；之后自上次发言以来没有新的有效发言的人直接算 [skip]，不调模型。
 * 一整轮没人发言就结束；安全上限（discussMaxTurns，含 [skip] 与失败）兜底；结束后的收尾复用 #33。
 * 只在讨论模式开关打开时由 GroupChatService 调用，这里不看开关。
 */

type TurnsChat = Pick<BotChat, 'members' | 'bossBotId' | 'routing'>;

/** 有效发言为 0（第 1 轮全员 [skip]）时的结束提示 */
export const TURNS_ALL_SKIPPED_NOTICE = '成员都选择不回复';
/** 人类 @ 的成员都不在群 / 已归档 / 静音时的提示（不交群主） */
export const TURNS_UNAVAILABLE_NOTICE = '被 @ 的成员都不能发言';
/** 不 @ 时也没有可发言的成员（群主缺失且其余成员都静音或归档）：与 main 的提示一致 */
const NO_SPEAKER_NOTICE = '请先指定群主';

/** 成员自选投递附的 routing-note：轮次不带安全上限，上限只是兜底，不是让成员凑数的目标 */
export function turnsNote(round: number, named: boolean): string {
  return [
    `成员自选发言（第 ${round} 轮）：大家按顺序依次发言，你能看到前面的人刚说的话。`,
    '按你的人设和职责判断，与你无关、或者别人已经说到了，就只回 [skip]；要说的话只补充新内容，这一轮只说一条。',
    round > 1 ? '前几轮已经说过的不要重复。' : '',
    '@ 别人只是提醒，不会让 TA 接着回复。',
    '需要长时间执行的工作可以委派，或者在任务看板安排；别人已经委派或安排了的，不要重复去做。',
    named && round === 1 ? '人类点名了你，尽量回复。' : '',
  ]
    .filter(Boolean)
    .join('');
}

const validMembers = (members: readonly RouterMember[]): RouterMember[] =>
  Array.isArray(members) ? members.filter((m) => m && typeof m.id === 'string') : [];

const mutedOf = (chat: TurnsChat): BotId[] =>
  Array.isArray(chat.routing.muted) ? chat.routing.muted : [];

/** 群成员（含已归档），按群成员顺序 */
function inChat(chat: TurnsChat, members: readonly RouterMember[]): RouterMember[] {
  const list = validMembers(members);
  return chat.members.flatMap((id) => {
    const member = list.find((m) => m.id === id);
    return member ? [member] : [];
  });
}

/** 群主第一，其余按群成员顺序 */
function baseOrder(chat: TurnsChat, ids: readonly BotId[]): BotId[] {
  const set = new Set(ids);
  const boss = chat.bossBotId && set.has(chat.bossBotId) ? [chat.bossBotId] : [];
  return [...boss, ...chat.members.filter((id) => set.has(id) && id !== chat.bossBotId)];
}

/** 轮到时才判断：在群、未归档、本条消息内没失败过、未静音（或被点名），第 2 轮起还要有新内容 */
function eligible(
  state: RouterState,
  chat: TurnsChat,
  members: readonly RouterMember[],
  id: BotId
): boolean {
  const turns = state.turns;
  if (!turns) return false;
  const member = validMembers(members).find((m) => m.id === id);
  if (!member || member.archivedAt !== undefined || !chat.members.includes(id)) return false;
  if (turns.out?.includes(id)) return false;
  if (mutedOf(chat).includes(id) && !turns.named.includes(id)) return false;
  if (turns.round === 1) return true;
  return hasNewContent(state.discussSeen?.[id], state.discussLastSeq ?? state.rootEntrySeq);
}

/**
 * 投递前复核（拼增量 / 附录的 await 之后、真正发给宿主之前）：当前发言者是否仍可发言，口径与轮到时一致；
 * 静音只对未被点名的人生效，归档 / 移出群一律不能发言
 */
export function turnsEligible(
  state: RouterState,
  chat: TurnsChat,
  members: readonly RouterMember[],
  id: BotId
): boolean {
  return eligible(state, chat, members, id);
}

/** 从本轮队列里取下一位可发言的人（跳过的直接丢掉），计一次讨论发言；没有返回 null */
function take(
  state: RouterState,
  chat: TurnsChat,
  members: readonly RouterMember[]
): RouterState | null {
  const index = state.queue.findIndex((id) => eligible(state, chat, members, id));
  if (index < 0) return null;
  const id = state.queue[index];
  return {
    ...state,
    queue: state.queue.slice(index + 1),
    current: id,
    discussTurns: (state.discussTurns ?? 0) + 1,
    turnsByBot: { ...state.turnsByBot, [id]: (state.turnsByBot[id] ?? 0) + 1 },
  };
}

/**
 * 开始成员自选：有 @ 时只有被 @ 的成员参与（@所有人 等同全员，静音成员只有被点名才参与），
 * 不 @ 时群内未归档、未静音的成员全员参与；被 @ 的都不能发言时只返回提示，不交群主。
 */
export function startTurns(
  chat: TurnsChat,
  members: readonly RouterMember[],
  entry: HumanEntry
): { state: RouterState } | { notice: string } {
  const present = inChat(chat, members);
  const parsed = parseMentions(entry.text, present);
  const mentioned =
    (Array.isArray(entry.mentions) && entry.mentions.length > 0) ||
    parsed.all ||
    parsed.ids.length > 0;
  const muted = mutedOf(chat);
  const targets = mentioned
    ? humanTargets(chat, members, entry)
    : present.filter((m) => m.archivedAt === undefined && !muted.includes(m.id)).map((m) => m.id);
  const order = baseOrder(chat, targets);
  if (order.length === 0)
    return { notice: mentioned ? TURNS_UNAVAILABLE_NOTICE : NO_SPEAKER_NOTICE };
  const named = !mentioned ? [] : parsed.all ? namedMentions(entry.text, present) : targets;
  const first = take(
    {
      rootEntrySeq: entry.seq,
      queue: order,
      current: null,
      hops: 0,
      turnsByBot: {},
      noticed: [],
      discussTurns: 0,
      discussReplies: 0,
      turns: { round: 1, order, named, spoke: 0, failed: 0 },
    },
    chat,
    members
  );
  return first
    ? { state: first }
    : { notice: mentioned ? TURNS_UNAVAILABLE_NOTICE : NO_SPEAKER_NOTICE };
}

export interface TurnReply {
  botId: BotId;
  /** 有效发言写入时间线的 seq；[skip]、空回复、失败没有 */
  seq?: number;
  /** 回复失败、预算用完或投递失败 */
  failed?: boolean;
  /** 本回合发起了委派 */
  delegated?: boolean;
  /** 有待处理的人类消息：说完就停，由调用方按新消息重开 */
  pendingHuman?: boolean;
}

export interface TurnStep {
  state: RouterState;
  /**
   * 结束原因：cap 到安全上限（还有人要说时）；idle 一整轮没人发言；
   * stop 有人委派或有待处理的人类消息（不收尾）。结束时 state.current 为 null，计数保留供 planTurnsEnd 使用
   */
  end?: 'cap' | 'idle' | 'stop';
  /** idle 且本条消息有效发言为 0、第 1 轮无人失败：提示「成员都选择不回复」 */
  quiet?: true;
}

/** 当前发言者说完：记有效发言与各人看到的位置，排本轮下一位；本轮说完按轮换开下一轮或结束 */
export function onTurnReply(
  state: RouterState,
  chat: TurnsChat,
  members: readonly RouterMember[],
  reply: TurnReply
): TurnStep {
  const progress = state.turns;
  if (!progress || state.current === null || reply.botId !== state.current) return { state };
  const { botId } = reply;
  const failed = reply.failed === true;
  const valid = !failed && typeof reply.seq === 'number';
  const lastSeq = valid
    ? Math.max(state.discussLastSeq ?? 0, reply.seq as number)
    : state.discussLastSeq;
  const turns: TurnsProgress = {
    ...progress,
    spoke: progress.spoke + (valid ? 1 : 0),
    failed: progress.failed + (failed ? 1 : 0),
    ...(failed ? { out: [...new Set([...(progress.out ?? []), botId])] } : {}),
    ...(reply.delegated ? { last: true as const } : {}),
    ...(valid ? { lastBy: botId } : {}),
  };
  const after: RouterState = {
    ...state,
    current: null,
    // [skip] 与失败不算一次回复
    turnsByBot: valid
      ? state.turnsByBot
      : { ...state.turnsByBot, [botId]: Math.max(0, (state.turnsByBot[botId] ?? 0) - 1) },
    turns,
    discussReplies: (state.discussReplies ?? 0) + (valid ? 1 : 0),
    ...(lastSeq !== undefined ? { discussLastSeq: lastSeq } : {}),
    discussSeen: { ...(state.discussSeen ?? {}), [botId]: lastSeq ?? state.rootEntrySeq },
  };
  if (reply.pendingHuman) return { state: { ...after, queue: [] }, end: 'stop' };
  return nextTurn(after, turns, chat, members);
}

/**
 * 当前发言者在投递前已不能发言（静音 / 归档 / 移出群）：当作轮到时就跳过了 TA——撤回这次 take 的计数，
 * 不算 [skip] 或失败、不记 TA 看到的位置，接着排本轮下一位；本轮没人了按轮换开下一轮或结束
 */
export function skipTurn(
  state: RouterState,
  chat: TurnsChat,
  members: readonly RouterMember[]
): TurnStep {
  const turns = state.turns;
  if (!turns || state.current === null) return { state };
  const id = state.current;
  return nextTurn(
    {
      ...state,
      current: null,
      discussTurns: Math.max(0, (state.discussTurns ?? 0) - 1),
      turnsByBot: { ...state.turnsByBot, [id]: Math.max(0, (state.turnsByBot[id] ?? 0) - 1) },
    },
    turns,
    chat,
    members
  );
}

/** 当前发言者已结算（after.current 为 null）：排本轮下一位；本轮说完按轮换开下一轮或结束 */
function nextTurn(
  after: RouterState,
  turns: TurnsProgress,
  chat: TurnsChat,
  members: readonly RouterMember[]
): TurnStep {
  const ended = (end: NonNullable<TurnStep['end']>, quiet = false): TurnStep => ({
    state: { ...after, queue: [] },
    end,
    ...(quiet ? { quiet: true as const } : {}),
  });
  let next = take(after, chat, members);
  if (!next) {
    if (turns.last) return ended('stop');
    if (turns.spoke === 0)
      return ended(
        'idle',
        turns.round === 1 && turns.failed === 0 && (after.discussReplies ?? 0) === 0
      );
    const round = turns.round + 1;
    const shift = (round - 1) % turns.order.length;
    next = take(
      {
        ...after,
        queue: [...turns.order.slice(shift), ...turns.order.slice(0, shift)],
        turns: { ...turns, round, spoke: 0, failed: 0 },
      },
      chat,
      members
    );
    if (!next) return ended('idle');
  }
  // 还有人要说但已到安全上限；委派优先（不收尾）
  if ((after.discussTurns ?? 0) >= discussCap(chat.routing))
    return ended(turns.last ? 'stop' : 'cap');
  return { state: next };
}

/**
 * 结束时怎么收：有效发言为 0 只在 quiet 时提示「成员都选择不回复」；有效发言不到 2 条且一整轮没人发言时静默结束；
 * 其余按 #33 的 planWrapUp（有效发言 ≥2 且群主可用才收尾，cap 不到 2 条也提示到上限）
 */
export function planTurnsEnd(
  state: RouterState,
  chat: TurnsChat,
  members: readonly RouterMember[],
  reason: 'cap' | 'idle',
  quiet?: boolean
): WrapUpPlan {
  const replies = state.discussReplies ?? 0;
  if (reason === 'idle' && replies === 0)
    return quiet ? { kind: 'end', notice: TURNS_ALL_SKIPPED_NOTICE } : { kind: 'end' };
  if (reason === 'idle' && replies < DISCUSS_WRAP_UP_MIN_REPLIES) return { kind: 'end' };
  const boss = wrapUpOwner(chat, validMembers(members));
  return planWrapUp({
    reason,
    replies,
    boss,
    cap: discussCap(chat.routing),
    bossWasLast: boss !== null && state.turns?.lastBy === boss.id,
    rootSeq: state.rootEntrySeq,
  });
}

function withoutTurns(state: RouterState): RouterState {
  const {
    turns: _turns,
    discussTurns: _used,
    discussReplies: _replies,
    discussLastSeq: _lastSeq,
    discussSeen: _seen,
    ...rest
  } = state;
  return rest;
}

/** 成员自选结束后交群主收尾 */
export function turnsWrapUp(state: RouterState, bossId: BotId): RouterState {
  return startWrapUp(withoutTurns(state), bossId);
}

/**
 * 中途转回普通接力（讨论模式开关关闭）：丢掉本轮剩下的人和后面的轮次；与 clearDiscussion 同一口径，
 * 成员自选里的发言次数不带进之后的普通接力，只记当前发言者这一次
 */
export function clearTurns(state: RouterState): RouterState {
  return {
    ...withoutTurns(state),
    queue: [],
    turnsByBot: state.current ? { [state.current]: 1 } : {},
  };
}

/** 结束（不收尾）：无人发言、无排队 */
export function endTurns(state: RouterState): RouterState {
  return { ...withoutTurns(state), current: null, queue: [] };
}
