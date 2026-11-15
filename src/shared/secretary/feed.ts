import type {
  SecretaryActivity,
  SecretaryBoard,
  SecretaryCard,
  SecretaryProposal,
  SecretaryResultKind,
} from '../types/secretary';

/** 首屏和每次「更早」都取这么多；侧栏里大约一屏多，滚到底再要下一批 */
export const FEED_PAGE_SIZE = 40;
/** 降噪后的动态会持续追加，留够翻页，仍给磁盘一个上限 */
export const ACTIVITY_LIMIT = 400;

export type FeedTone = 'warn' | 'run' | 'ok' | 'bad' | 'idle';

export interface FeedEvent {
  id: string;
  at: number;
  tone: FeedTone;
  projectName: string;
  title: string;
  label: string;
  detail?: string;
  conversationId?: string;
  /** 会话还在跑：时间线上 hover 出停止 */
  running?: boolean;
}

/** 时间新的在前；同一时刻用 id 升序，保证翻页边界稳定 */
export interface FeedCursor {
  at: number;
  id: string;
}

export interface FeedQuery {
  before?: FeedCursor;
  limit?: number;
}

export interface FeedPage {
  events: FeedEvent[];
  hasMore: boolean;
}

type Feed = { tone: FeedTone; label: string };

type SessionCard = Extract<SecretaryCard, { kind: 'session' }>;

const RESULT_FEED: Record<SecretaryResultKind, Feed> = {
  'goal-complete': { tone: 'ok', label: 'Goal complete' },
  'turn-ended': { tone: 'ok', label: 'Turn ended' },
  'goal-blocked': { tone: 'warn', label: 'Goal blocked' },
  'needs-user': { tone: 'warn', label: 'Waiting for you' },
  stalled: { tone: 'warn', label: 'Stalled' },
  interrupted: { tone: 'warn', label: 'Interrupted' },
  failed: { tone: 'bad', label: 'Failed' },
};

const STATE_FEED: Record<SessionCard['state'], Feed> = {
  running: { tone: 'run', label: 'Started' },
  idle: { tone: 'idle', label: 'Idle' },
  waiting: { tone: 'idle', label: 'Waiting for you' },
  error: { tone: 'idle', label: 'Failed' },
  'not-started': { tone: 'idle', label: 'Not started' },
};

/** 会话卡片对应的动态说明与发生时间：在跑时上一轮的结果已过时，看状态；否则有结果看结果 */
export function sessionFeed(card: SessionCard): Feed & { at: number } {
  if (card.continuing) return { tone: 'run', label: 'In progress', at: card.stateSince };
  return card.result && card.state !== 'running'
    ? { ...RESULT_FEED[card.result], at: card.resultAt ?? card.stateSince }
    : { ...STATE_FEED[card.state], at: card.stateSince };
}

function sessionEvent(card: SessionCard): FeedEvent {
  const feed = sessionFeed(card);
  return {
    id: `session:${card.conversationId}`,
    at: feed.at,
    tone: feed.tone,
    projectName: card.projectName,
    title: card.title,
    label: feed.label,
    ...(card.lastText ? { detail: card.lastText } : {}),
    conversationId: card.conversationId,
    ...(card.state === 'running' ? { running: true } : {}),
  };
}

function proposalTitle(proposal: SecretaryProposal): string {
  if (proposal.kind === 'profile') return 'Update the secretary profile';
  if (proposal.kind === 'skill') return `Skill: ${proposal.draft.name}`;
  if (proposal.kind === 'tool') return `Tool: ${proposal.draft.name}`;
  if (proposal.kind === 'takeover') return proposal.draft.title ?? proposal.draft.conversationId;
  if (proposal.kind === 'cleanup') return `Clean up ${proposal.draft.items.length} items`;
  return proposal.draft.title?.trim() || proposal.draft.prompt.split('\n')[0]?.trim() || '';
}

function proposalEvent(card: Extract<SecretaryCard, { kind: 'proposal' }>): FeedEvent {
  return {
    id: `proposal:${card.proposal.id}`,
    at: card.proposal.createdAt,
    tone: 'warn',
    projectName: card.projectName ?? '',
    title: proposalTitle(card.proposal),
    label: 'Waiting for your confirmation',
  };
}

/** 等依赖的派发：等待中算进行中，出问题算失败，卡片与动态同一口径 */
function pendingEvent(card: Extract<SecretaryCard, { kind: 'pending' }>): FeedEvent {
  const failed = card.pending.status === 'failed';
  return {
    id: `pending:${card.pending.id}`,
    at: card.pending.updatedAt,
    tone: failed ? 'bad' : 'run',
    projectName: card.projectName,
    title:
      card.pending.draft.title?.trim() || card.pending.draft.prompt.split('\n')[0]?.trim() || '',
    label: failed ? 'Dispatch problem' : 'Waiting for dependencies',
  };
}

function activityEvent(entry: SecretaryActivity, card: SessionCard | undefined): FeedEvent {
  const feed =
    entry.kind === 'seen'
      ? { tone: 'idle' as const, label: 'Secretary saw this' }
      : RESULT_FEED[entry.kind];
  return {
    id: `activity:${entry.conversationId}:${entry.at}:${entry.kind}`,
    at: entry.at,
    tone: feed.tone,
    projectName: card?.projectName ?? '',
    title: card?.title || entry.conversationId,
    label: feed.label,
    ...(entry.text ? { detail: entry.text } : {}),
    conversationId: entry.conversationId,
  };
}

/** 新的在前。同一时刻 id 小的在前，和输入顺序无关 */
export function compareFeed(left: FeedEvent, right: FeedEvent): number {
  return right.at - left.at || left.id.localeCompare(right.id);
}

/** 工作台动态的全量投影。分页在 pageFeed，这里不截断 */
export function feedEvents(board: SecretaryBoard): FeedEvent[] {
  const sessions = [...board.needsYou, ...board.running, ...board.done].filter(
    (card): card is SessionCard => card.kind === 'session'
  );
  const cards = new Map(sessions.map((card) => [card.conversationId, card]));
  return [...board.needsYou, ...board.running, ...board.done]
    .map((card) =>
      card.kind === 'proposal'
        ? proposalEvent(card)
        : card.kind === 'pending'
          ? pendingEvent(card)
          : sessionEvent(card)
    )
    .concat(
      (board.activity ?? []).map((entry) => activityEvent(entry, cards.get(entry.conversationId)))
    )
    .sort(compareFeed);
}

/** cursor 之后（更早）的条目：时间更小，或时间相同且 id 更大 */
export function isOlderThan(event: FeedEvent, cursor: FeedCursor): boolean {
  return event.at < cursor.at || (event.at === cursor.at && event.id.localeCompare(cursor.id) > 0);
}

export function pageFeed(events: readonly FeedEvent[], query: FeedQuery = {}): FeedPage {
  const limit = query.limit ?? FEED_PAGE_SIZE;
  const sorted = [...events].sort(compareFeed);
  const eligible = query.before
    ? sorted.filter((event) => isOlderThan(event, query.before as FeedCursor))
    : sorted;
  return {
    events: eligible.slice(0, limit),
    hasMore: eligible.length > limit,
  };
}

/**
 * 用最新一页对齐已加载的列表。
 * 同 id 原地替换，不改位置；没见过的 id 在贴顶时插到前面，否则先攒着，已加载的更早条目不动。
 */
export function mergeFeedHead(
  loaded: readonly FeedEvent[],
  head: readonly FeedEvent[],
  insertNew: boolean
): { events: FeedEvent[]; pending: FeedEvent[] } {
  const byId = new Map(head.map((event) => [event.id, event]));
  const loadedIds = new Set(loaded.map((event) => event.id));
  const updated = loaded.map((event) => byId.get(event.id) ?? event);
  const pending = head.filter((event) => !loadedIds.has(event.id));
  if (!insertNew) return { events: updated, pending };
  return { events: [...pending, ...updated], pending: [] };
}

/** 接上更早的一页：已有的 id 原地更新，其余按页内顺序接在末尾 */
export function appendFeedPage(
  loaded: readonly FeedEvent[],
  page: readonly FeedEvent[]
): FeedEvent[] {
  const index = new Map(loaded.map((event, at) => [event.id, at]));
  const next = loaded.slice();
  const extra: FeedEvent[] = [];
  for (const event of page) {
    const at = index.get(event.id);
    if (at === undefined) extra.push(event);
    else next[at] = event;
  }
  return [...next, ...extra];
}

/** IPC 入参。null 表示非法，空对象表示要最新一页 */
export function parseFeedQuery(value: unknown): FeedQuery | null {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  const query: FeedQuery = {};
  if (request.before !== undefined) {
    const cursor = request.before;
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
    const raw = cursor as Record<string, unknown>;
    if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null;
    if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
    query.before = { at: raw.at, id: raw.id };
  }
  if (request.limit !== undefined) {
    if (
      typeof request.limit !== 'number' ||
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100
    ) {
      return null;
    }
    query.limit = request.limit;
  }
  return query;
}
