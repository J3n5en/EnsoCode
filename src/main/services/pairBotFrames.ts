import type {
  HostToPhone,
  PairBotActivity,
  PairBotChatSummary,
  PairBotMember,
  PairBotRunState,
  PairGroupEntry,
} from '@enso/pair';
import type { LiveActivity } from '@shared/bots/liveActivity';
import type { BotChat, BotProfile, GroupEntry } from '@shared/types/bot';
import type { BotQueueItem } from '@shared/types/botIpc';

/** Bot 模式下行帧的纯投影：只放展示字段，人设/模型/权限配置不出 Main */

const LAST_TEXT_MAX = 120;
export const GROUP_TIMELINE_MAX_JSON_BYTES = 850_000;

type GroupTimelineFrame = Extract<HostToPhone, { type: 'group-timeline' }>;

export function toPairBotMember(bot: BotProfile, status: PairBotRunState): PairBotMember {
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    avatarColor: bot.avatar.color,
    ...(bot.archivedAt !== undefined ? { archived: true as const } : {}),
    status,
  };
}

function entryText(entry: GroupEntry): string {
  if (entry.kind === 'delegation') return entry.summary ?? '';
  return entry.text;
}

export function summarizeBotChat(
  chat: BotChat,
  last: GroupEntry | undefined,
  lastSeq: number,
  status: PairBotRunState
): PairBotChatSummary {
  const sessions: PairBotChatSummary['sessions'] = {};
  for (const [botId, session] of Object.entries(chat.sessions)) {
    sessions[botId] = { conversationId: session.conversationId };
  }
  const botId =
    last?.kind === 'bot' ? last.botId : last?.kind === 'delegation' ? last.from : undefined;
  return {
    id: chat.id,
    kind: chat.kind,
    title: chat.title,
    members: [...chat.members],
    bossBotId: chat.bossBotId,
    ...(chat.pinned ? { pinned: true as const } : {}),
    ...(chat.archivedAt !== undefined ? { archived: true as const } : {}),
    updatedAt: Math.max(chat.updatedAt, last?.at ?? 0),
    lastSeq,
    ...(chat.epochSeq !== undefined ? { epochSeq: chat.epochSeq } : {}),
    ...(last
      ? {
          last: {
            kind: last.kind,
            text: entryText(last).replace(/\s+/g, ' ').trim().slice(0, LAST_TEXT_MAX),
            ...(botId ? { botId } : {}),
            at: last.at,
          },
        }
      : {}),
    sessions,
    status,
  };
}

const frameBytes = (frame: GroupTimelineFrame): number =>
  Buffer.byteLength(JSON.stringify(frame), 'utf8');

function truncateEntry(entry: PairGroupEntry, chars: number): PairGroupEntry {
  if (entry.kind === 'delegation') {
    return entry.summary === undefined
      ? entry
      : { ...entry, summary: entry.summary.slice(0, chars), truncated: true };
  }
  return { ...entry, text: entry.text.slice(0, chars), truncated: true };
}

/** 单帧须小于中继上限：从最旧一端减条数；只剩一条仍超限则截断其正文 */
export function fitGroupTimelineFrame(
  frame: GroupTimelineFrame,
  maxBytes: number = GROUP_TIMELINE_MAX_JSON_BYTES
): GroupTimelineFrame {
  let next = frame;
  while (next.entries.length > 1 && frameBytes(next) >= maxBytes) {
    next = { ...next, entries: next.entries.slice(1), hasOlder: true };
  }
  if (next.entries.length === 1 && frameBytes(next) >= maxBytes) {
    const [entry] = next.entries;
    const length = entry.kind === 'delegation' ? (entry.summary?.length ?? 0) : entry.text.length;
    let chars = Math.max(0, length - (frameBytes(next) - maxBytes) - 1);
    let fitted = { ...next, entries: [truncateEntry(entry, chars)] };
    while (chars > 0 && frameBytes(fitted) >= maxBytes) {
      chars = Math.floor(chars / 2);
      fitted = { ...next, entries: [truncateEntry(entry, chars)] };
    }
    next = fitted;
  }
  return next;
}

export type BotSessionAccess = 'none' | 'deny' | 'live' | 'cold';

/**
 * 手机订阅某会话时的放行判断：Bot 会话不在 renderer 会话表里，
 * 只在 Bot 模式开启时放行，且由 Bot 层提供快照（worker 有投影走快照，否则读会话文件）。
 */
export function botSessionAccess(
  conversation: { bot?: unknown } | undefined,
  enabled: boolean,
  alive: boolean
): BotSessionAccess {
  if (!conversation?.bot) return 'none';
  if (!enabled) return 'deny';
  return alive ? 'live' : 'cold';
}

export interface ActivityBinding {
  botId: string;
  chatId: string | null;
  ownerBotId?: string;
}

/** 正在跑的会话 + 排队中的会话 → 手机运行态；不是 Bot 会话的丢弃 */
export function pairActivityItems(
  running: ReadonlyArray<{ conversationId: string; activity: LiveActivity }>,
  queue: readonly BotQueueItem[],
  bindingOf: (conversationId: string) => ActivityBinding | undefined
): PairBotActivity[] {
  const items: PairBotActivity[] = [];
  const seen = new Set<string>();
  for (const { conversationId, activity } of running) {
    const binding = bindingOf(conversationId);
    if (!binding) continue;
    seen.add(conversationId);
    items.push({
      conversationId,
      ...binding,
      state: activity.state,
      ...(activity.startedAt !== undefined ? { startedAt: activity.startedAt } : {}),
      steps: activity.steps.map(({ id: _id, ...step }) => step),
      more: activity.more,
    });
  }
  for (const item of queue) {
    if (seen.has(item.conversationId)) continue;
    const binding = bindingOf(item.conversationId);
    if (!binding) continue;
    seen.add(item.conversationId);
    items.push({
      conversationId: item.conversationId,
      ...binding,
      state: 'queued',
      ...(item.reason ? { reason: item.reason } : {}),
      steps: [],
      more: 0,
    });
  }
  return items;
}
