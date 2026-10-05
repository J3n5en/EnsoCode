import type {
  HostToPhone,
  PairBotActivity,
  PairBotChatSummary,
  PairBotInboxItem,
  PairBotMember,
  PairGroupEntry,
} from '@enso/pair';
import { mentionCandidates } from '@shared/bots/mentions';
import { BOT_MENTION_ALL, botNameKey } from '@shared/types/bot';

/** 手机 Bot 模式的纯逻辑：抽屉排序、群时间线分页合并、@ 补全 */

const byRecent = (a: PairBotChatSummary, b: PairBotChatSummary): number =>
  Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt;

export function botChatSections(
  chats: readonly PairBotChatSummary[],
  bots: readonly PairBotMember[]
): { groups: PairBotChatSummary[]; directs: PairBotChatSummary[] } {
  const active = new Set(bots.filter((bot) => !bot.archived).map((bot) => bot.id));
  return {
    groups: chats.filter((chat) => chat.kind === 'group').sort(byRecent),
    directs: chats
      .filter((chat) => chat.kind === 'direct' && active.has(chat.members[0]))
      .sort(byRecent),
  };
}

export interface GroupTimelineState {
  entries: PairGroupEntry[];
  lastSeq: number;
  hasOlder: boolean;
  /** 达到窗口上限后向上翻页，暂不被最新页覆盖；用户可点「回到最新」。 */
  history?: true;
  epochSeq?: number;
}

const GROUP_WINDOW = 400;
function boundGroupTimeline(state: GroupTimelineState, older = false): GroupTimelineState {
  if (state.entries.length <= GROUP_WINDOW) return state;
  return {
    ...state,
    entries: older ? state.entries.slice(0, GROUP_WINDOW) : state.entries.slice(-GROUP_WINDOW),
    hasOlder: older ? state.hasOlder : true,
    ...(older ? { history: true as const } : {}),
  };
}

export function visibleGroupEntries(
  entries: readonly PairGroupEntry[],
  epoch: number,
  expanded: boolean
): readonly PairGroupEntry[] {
  return expanded || epoch === 0 ? entries : entries.filter((entry) => entry.seq >= epoch);
}

type GroupTimelineFrame = Extract<HostToPhone, { type: 'group-timeline' }>;

export function mergeGroupTimeline(
  current: GroupTimelineState | undefined,
  frame: GroupTimelineFrame
): GroupTimelineState {
  const incoming: GroupTimelineState = {
    entries: [...frame.entries].sort((a, b) => a.seq - b.seq),
    lastSeq: frame.lastSeq,
    hasOlder: frame.hasOlder,
    ...(frame.epochSeq !== undefined ? { epochSeq: frame.epochSeq } : {}),
  };
  if (current && frame.epochSeq !== undefined) {
    if (frame.epochSeq < (current.epochSeq ?? 0)) return current;
    if (frame.epochSeq > (current.epochSeq ?? 0) && frame.beforeSeq === undefined)
      return boundGroupTimeline(incoming);
  }
  if (!current || current.entries.length === 0)
    return boundGroupTimeline(incoming, frame.beforeSeq !== undefined);
  if (frame.beforeSeq === undefined && current.history)
    return { ...current, lastSeq: Math.max(current.lastSeq, frame.lastSeq) };
  if (frame.beforeSeq === undefined && frame.lastSeq < current.lastSeq) return current;
  const first = current.entries[0].seq;
  if (frame.beforeSeq !== undefined) {
    // 换过最新页或重复请求的迟到应答：与当前最早条目不衔接就丢弃
    if (frame.beforeSeq !== first) return current;
  } else {
    const last = current.entries.at(-1)?.seq ?? 0;
    if ((incoming.entries[0]?.seq ?? last + 1) > last + 1) return boundGroupTimeline(incoming);
  }
  const bySeq = new Map(current.entries.map((entry) => [entry.seq, entry]));
  for (const entry of incoming.entries) {
    const previous = bySeq.get(entry.seq);
    if (entry.truncated && previous && !previous.truncated) continue;
    bySeq.set(entry.seq, entry);
  }
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const olderFromIncoming = (incoming.entries[0]?.seq ?? Number.POSITIVE_INFINITY) < first;
  return boundGroupTimeline(
    {
      entries,
      lastSeq: Math.max(current.lastSeq, incoming.lastSeq),
      hasOlder:
        frame.beforeSeq !== undefined || olderFromIncoming ? incoming.hasOlder : current.hasOlder,
      ...(current.history ? { history: true as const } : {}),
      ...(incoming.epochSeq !== undefined
        ? { epochSeq: incoming.epochSeq }
        : current.epochSeq !== undefined
          ? { epochSeq: current.epochSeq }
          : {}),
    },
    frame.beforeSeq !== undefined
  );
}

/** @ 前紧挨着这些字符时视为邮箱等，不触发补全（与 parseMentions 同规则） */
const EMAIL_LOCAL_RE = /[A-Za-z0-9._%+-]/;

export function activeMention(
  text: string,
  caret: number
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('@');
  if (start < 0) return null;
  if (start > 0 && EMAIL_LOCAL_RE.test(before[start - 1])) return null;
  const query = before.slice(start + 1);
  return /\s/.test(query) ? null : { start, query };
}

export interface MentionOption {
  id: string;
  name: string;
}

export const MENTION_ALL_ID = '__all__';

export function mentionOptions(query: string, members: readonly MentionOption[]): MentionOption[] {
  const all = BOT_MENTION_ALL[0];
  const key = botNameKey(query.replace(/^@/, ''));
  const everyone = botNameKey(all).startsWith(key) ? [{ id: MENTION_ALL_ID, name: all }] : [];
  return [...everyone, ...mentionCandidates(query, members).map(({ id, name }) => ({ id, name }))];
}

export function insertMention(
  text: string,
  mention: { start: number; query: string },
  caret: number,
  name: string
): { text: string; caret: number } {
  const inserted = `@${name} `;
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(caret),
    caret: mention.start + inserted.length,
  };
}

const INBOX_LABELS: Record<Exclude<PairBotInboxItem['kind'], 'silence'>, string> = {
  approval: '需要审批',
  ask: '等你回答',
  'delegation-interrupted': '委派中断',
  budget: '今日预算已用完',
  'routine-draft': '例行任务待批准',
  'routine-blocked': '例行任务被阻塞',
};

/** 收件箱条目标签；静默按 now 算已安静秒数 */
export function inboxLabel(item: PairBotInboxItem, now: number): string {
  if (item.kind !== 'silence') return INBOX_LABELS[item.kind];
  return `已安静 ${Math.max(0, Math.floor((now - (item.since ?? now)) / 1000))} 秒`;
}

const STATE_TEXT: Record<Exclude<PairBotActivity['state'], 'queued'>, string> = {
  thinking: '思考中',
  typing: '输出中',
  tool: '调用工具',
  retrying: '重试中',
};

export function activityStateText(item: PairBotActivity): string {
  if (item.state !== 'queued') return STATE_TEXT[item.state];
  return item.reason === 'turn'
    ? '排队 · 等上一轮结束'
    : item.reason === 'capacity'
      ? '排队 · 并发已满'
      : '排队中';
}

/** 一行摘要：运行中的工具（名 + 参数）优先，否则状态 */
export function activityLine(item: PairBotActivity): string {
  const step = item.steps.findLast((s) => s.status === 'running');
  return step ? `${step.name} ${step.detail}`.trim() : activityStateText(item);
}

/** 某聊天里成员（含委派子会话）的运行态，运行中在前 */
export function chatActivities(
  items: readonly PairBotActivity[],
  chatId: string
): PairBotActivity[] {
  return items
    .filter((item) => item.chatId === chatId)
    .sort((a, b) => Number(a.state === 'queued') - Number(b.state === 'queued'));
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
