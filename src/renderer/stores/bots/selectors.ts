import { parseBotInjectedMessage } from '@shared/bots/injectedMessage';
import { stripBotNotesUpdate } from '@shared/bots/notes';
import type { ApprovalRequestInfo, AskRequestInfo, ProjectedMessage } from '@shared/types/agent';
import type { BotChat, GroupEntry } from '@shared/types/bot';
import type { BotQueueItem } from '@shared/types/botIpc';
import type { BotSessions } from './projection';
import { directMarker, readKey } from './unread';

export interface SessionOwner {
  chatId: string;
  botId: string;
  /** 委派子会话：botId 替 parentBotId 执行 */
  delegation?: { id: string; parentBotId: string };
}

/** 当前在用的成员会话 → 所属聊天/成员 */
export function sessionOwners(chats: readonly BotChat[]): Record<string, SessionOwner> {
  const owners: Record<string, SessionOwner> = {};
  for (const chat of chats) {
    for (const [botId, session] of Object.entries(chat.sessions)) {
      owners[session.conversationId] = { chatId: chat.id, botId };
    }
  }
  return owners;
}

export type PendingItem =
  | ({ kind: 'approval'; conversationId: string; request: ApprovalRequestInfo } & SessionOwner)
  | ({ kind: 'ask'; conversationId: string; request: AskRequestInfo } & SessionOwner);

export function pendingItems(
  sessions: BotSessions,
  owners: Record<string, SessionOwner>,
  chatId?: string
): PendingItem[] {
  const items: PendingItem[] = [];
  for (const [conversationId, owner] of Object.entries(owners)) {
    if (chatId && owner.chatId !== chatId) continue;
    const session = sessions[conversationId];
    if (!session) continue;
    for (const request of session.pendingApprovals)
      items.push({ kind: 'approval', conversationId, request, ...owner });
    for (const request of session.pendingAsks)
      items.push({ kind: 'ask', conversationId, request, ...owner });
  }
  return items;
}

export interface TimelineSlice {
  entries: GroupEntry[];
  lastSeq: number;
  /** 历史窗口：entries 末尾不是最新，预览用 tail */
  history?: { tail?: GroupEntry };
}

export interface ChatSummary {
  key: string;
  marker: number;
  preview: string;
  activityAt: number;
  running: boolean;
  queued: boolean;
  pending: number;
}

const plain = (text: string) => text.replace(/\s+/gu, ' ').trim();

export function messagePreview(message: ProjectedMessage): string {
  const joined = message.content.map((part) => (part.type === 'text' ? part.text : '')).join(' ');
  const text = message.role === 'user' ? stripBotNotesUpdate(joined) : joined;
  const injected = message.role === 'user' ? parseBotInjectedMessage(text) : null;
  if (!injected) return plain(text);
  switch (injected.kind) {
    case 'routine':
      return plain(`${injected.title} · ${injected.prompt}`);
    case 'group':
      return plain(injected.messages.map((item) => `${item.from}: ${item.text}`).join(' · '));
    case 'delegation-task':
      return plain(`${injected.from}: ${injected.task}`);
    case 'delegation-result':
      return plain(`${injected.from}: ${injected.text}`);
    case 'delegation-results':
      return plain(injected.results.map((item) => `${item.from}: ${item.text}`).join(' · '));
  }
}

function entryPreview(entry: GroupEntry, names: Record<string, string>): string {
  switch (entry.kind) {
    case 'human':
    case 'system':
      return plain(entry.text);
    case 'bot':
      return `${names[entry.botId] ?? '?'}: ${plain(entry.text)}`;
    case 'delegation':
      return `${names[entry.from] ?? '?'} → ${names[entry.to] ?? '?'}${entry.summary ? ` · ${plain(entry.summary)}` : ''}`;
  }
}

export function chatSummary(
  chat: BotChat,
  ctx: {
    sessions: BotSessions;
    timeline?: TimelineSlice;
    queue: readonly BotQueueItem[];
    names: Record<string, string>;
  }
): ChatSummary {
  const conversationIds = Object.values(chat.sessions).map((s) => s.conversationId);
  const projections = conversationIds.map((id) => ctx.sessions[id]).filter(Boolean);
  const running = projections.some((p) => p.status === 'running');
  const pending = projections.reduce(
    (sum, p) => sum + p.pendingApprovals.length + p.pendingAsks.length,
    0
  );
  const queued = ctx.queue.some((item) => item.chatId === chat.id);
  if (chat.kind === 'group') {
    const timeline = ctx.timeline;
    const last = timeline?.history ? timeline.history.tail : timeline?.entries.at(-1);
    return {
      key: readKey(chat),
      marker: ctx.timeline?.lastSeq ?? 0,
      preview: last ? entryPreview(last, ctx.names) : '',
      activityAt: Math.max(last?.at ?? 0, chat.updatedAt),
      running,
      queued,
      pending,
    };
  }
  const conversationId = chat.sessions[chat.members[0]]?.conversationId;
  const projection = conversationId ? ctx.sessions[conversationId] : undefined;
  const messages = projection?.messages ?? [];
  let preview = '';
  let at = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = messagePreview(message);
    if (!text) continue;
    preview = text;
    at = message.timestamp ?? 0;
    break;
  }
  return {
    key: readKey(chat, conversationId),
    marker: directMarker(projection),
    preview,
    activityAt: Math.max(at, chat.updatedAt),
    running,
    queued,
    pending,
  };
}

const pinRank = (chat: BotChat) => chat.pinOrder ?? Number.POSITIVE_INFINITY;

/** 置顶优先（置顶内按手动顺序，未排过的在后），其余按最近活动倒序 */
export function sortChats<T extends { chat: BotChat; summary: ChatSummary }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const pinned = Number(b.chat.pinned) - Number(a.chat.pinned);
    if (pinned || !a.chat.pinned) return pinned || b.summary.activityAt - a.summary.activityAt;
    const ra = pinRank(a.chat);
    const rb = pinRank(b.chat);
    return ra === rb ? b.summary.activityAt - a.summary.activityAt : ra < rb ? -1 : 1;
  });
}

/** 置顶内拖拽 / 上下移动：按新位置重新编号 0..n-1，只返回顺序变化的聊天 */
export function reorderPinned(
  ids: readonly string[],
  chatId: string,
  toIndex: number,
  current: Readonly<Record<string, number | undefined>> = {}
): { chatId: string; pinOrder: number }[] {
  const from = ids.indexOf(chatId);
  if (from < 0) return [];
  const next = ids.filter((id) => id !== chatId);
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, chatId);
  return next.flatMap((id, pinOrder) =>
    current[id] === pinOrder ? [] : [{ chatId: id, pinOrder }]
  );
}

/** 稍后提醒的预设时间 */
export function snoozeTimes(now: number): { hour: number; later: number; tomorrow: number } {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return { hour: now + 3_600_000, later: now + 3 * 3_600_000, tomorrow: tomorrow.getTime() };
}
