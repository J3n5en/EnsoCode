import { detailOf } from '@shared/bots/liveActivity';
import type { ProjectedMessage } from '@shared/types/agent';
import type { Delegation, GroupEntry } from '@shared/types/bot';

const CONTINUE_WINDOW_MS = 5 * 60_000;
/** 渲染上限：群时间线不虚拟化，已加载条目超过即从远离视口的一端裁掉 */
export const TIMELINE_MAX = 400;

function uniqueSorted(entries: GroupEntry[]): GroupEntry[] {
  const bySeq = new Map<number, GroupEntry>();
  for (const entry of entries) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** 最新一页并入：与已有尾部重叠或相接则合并，否则（中间有空洞）整体替换 */
export function mergeLatest(
  existing: GroupEntry[],
  page: GroupEntry[]
): { entries: GroupEntry[]; gap: boolean } {
  if (page.length === 0) return { entries: existing, gap: false };
  const last = existing.at(-1)?.seq;
  if (last !== undefined && page[0].seq > last + 1) return { entries: page, gap: true };
  return { entries: uniqueSorted([...existing, ...page]), gap: false };
}

export function mergeOlder(existing: GroupEntry[], page: GroupEntry[]): GroupEntry[] {
  return page.length === 0 ? existing : uniqueSorted([...page, ...existing]);
}

/** 向后翻页并入：只追加已有末尾之后的条目 */
export function mergeNewer(existing: GroupEntry[], page: GroupEntry[]): GroupEntry[] {
  const last = existing.at(-1)?.seq ?? Number.NEGATIVE_INFINITY;
  const fresh = page.filter((entry) => entry.seq > last);
  return fresh.length === 0 ? existing : uniqueSorted([...existing, ...fresh]);
}

export function trimTimeline(
  entries: GroupEntry[],
  max: number,
  drop: 'start' | 'end'
): { entries: GroupEntry[]; trimmed: boolean } {
  if (entries.length <= max) return { entries, trimmed: false };
  return {
    entries: drop === 'start' ? entries.slice(entries.length - max) : entries.slice(0, max),
    trimmed: true,
  };
}

export type TimelineRow =
  | { kind: 'day'; key: string; at: number }
  | { kind: 'entry'; key: string; entry: GroupEntry; continued: boolean };

const dayOf = (at: number) => new Date(at).toDateString();
const authorOf = (entry: GroupEntry): string | null =>
  entry.kind === 'human' ? 'human' : entry.kind === 'bot' ? `bot:${entry.botId}` : null;

/** 日期分隔 + 同一作者 5 分钟内连续消息合并头像 */
export function buildRows(entries: readonly GroupEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let previous: GroupEntry | undefined;
  for (const entry of entries) {
    const newDay = !previous || dayOf(previous.at) !== dayOf(entry.at);
    if (newDay) rows.push({ kind: 'day', key: `day:${entry.seq}`, at: entry.at });
    const author = authorOf(entry);
    const continued = Boolean(
      !newDay &&
        previous &&
        author &&
        authorOf(previous) === author &&
        entry.at - previous.at <= CONTINUE_WINDOW_MS
    );
    rows.push({ kind: 'entry', key: entry.id, entry, continued });
    previous = entry;
  }
  return rows;
}

/** 进行中的委派按时间插进时间线：优先挂在发起者那一轮的群回复后，其次挂在创建前最后一条后 */
export function anchorDelegations(
  entries: readonly GroupEntry[],
  active: readonly Delegation[]
): { head: Delegation[]; after: Map<string, Delegation[]> } {
  const head: Delegation[] = [];
  const after = new Map<string, Delegation[]>();
  for (const item of [...active].sort((a, b) => a.createdAt - b.createdAt)) {
    const anchor =
      entries.find(
        (entry) =>
          entry.kind === 'bot' &&
          entry.conversationId === item.parentConversationId &&
          entry.at >= item.createdAt
      ) ?? entries.findLast((entry) => entry.at <= item.createdAt);
    if (!anchor) head.push(item);
    else after.set(anchor.id, [...(after.get(anchor.id) ?? []), item]);
  }
  return { head, after };
}

const textOf = (message: ProjectedMessage): string =>
  message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();

/** 群里一条 bot 消息 = 该成员会话一轮的最终回复；按文本定位该轮，定位不到给最近一轮 */
export function locateTurn(
  messages: readonly ProjectedMessage[],
  finalText: string
): { start: number; end: number; exact: boolean } | null {
  if (messages.length === 0) return null;
  const target = finalText.trim();
  const startOf = (index: number) => {
    for (let i = index; i >= 0; i--) if (messages[i].role === 'user') return i;
    return 0;
  };
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && target && textOf(messages[i]) === target) {
      return { start: startOf(i), end: i + 1, exact: true };
    }
  }
  return { start: startOf(messages.length - 1), end: messages.length, exact: false };
}

export interface TurnStep {
  id: string;
  name: string;
  detail: string;
  error: boolean;
}

export function turnSteps(messages: readonly ProjectedMessage[]): TurnStep[] {
  const failed = new Set(
    messages
      .filter((message) => message.role === 'toolResult' && message.isError)
      .map((message) => message.toolCallId)
  );
  const steps: TurnStep[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall') continue;
      steps.push({
        id: part.id,
        name: part.name,
        detail: detailOf(part.arguments),
        error: failed.has(part.id),
      });
    }
  }
  return steps;
}
