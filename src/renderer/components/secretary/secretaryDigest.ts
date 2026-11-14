import type {
  SecretaryBoard,
  SecretaryCard,
  SecretaryProposal,
  SecretaryResultKind,
} from '@shared/types/secretary';

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

export interface SecretaryDigest {
  /** i18n key：Good morning / Good afternoon / Good evening */
  greeting: string;
  today: { dispatched: number; completed: number; failed: number };
  counts: { needsYou: number; running: number; todos: number };
  events: FeedEvent[];
}

type Feed = { tone: FeedTone; label: string };

export type SecretarySessionCard = Extract<SecretaryCard, { kind: 'session' }>;

type SessionCard = SecretarySessionCard;

/** 结果类型决定动态条目的颜色与说明；新增结果类型时只补这张表 */
const RESULT_FEED: Record<SecretaryResultKind, Feed> = {
  'goal-complete': { tone: 'ok', label: 'Goal complete' },
  'turn-ended': { tone: 'ok', label: 'Turn ended' },
  'goal-blocked': { tone: 'warn', label: 'Goal blocked' },
  'needs-user': { tone: 'warn', label: 'Waiting for you' },
  stalled: { tone: 'warn', label: 'Stalled' },
  interrupted: { tone: 'warn', label: 'Interrupted' },
  failed: { tone: 'bad', label: 'Failed' },
};

/** 还没有结果时按会话状态说明：只有真正在跑的那条算「开始执行」 */
const STATE_FEED: Record<SessionCard['state'], Feed> = {
  running: { tone: 'run', label: 'Started' },
  idle: { tone: 'idle', label: 'Idle' },
  waiting: { tone: 'idle', label: 'Waiting for you' },
  error: { tone: 'idle', label: 'Failed' },
  'not-started': { tone: 'idle', label: 'Not started' },
};

const COMPLETED_RESULTS: ReadonlySet<SecretaryResultKind> = new Set([
  'goal-complete',
  'turn-ended',
]);

const EVENT_LIMIT = 20;

function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function greetingAt(now: number): string {
  const hour = new Date(now).getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** 会话卡片对应的动态说明：在跑时上一轮的结果已过时，看状态；否则有结果看结果 */
export function sessionFeed(card: SessionCard): Feed {
  return card.result && card.state !== 'running'
    ? RESULT_FEED[card.result]
    : STATE_FEED[card.state];
}

function sessionEvent(card: SessionCard): FeedEvent {
  const feed = sessionFeed(card);
  return {
    id: `session:${card.conversationId}`,
    at: card.updatedAt,
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

/** 工作台首屏与侧栏摘要共用的纯投影：问候、今日战报、计数与动态时间线 */
export function secretaryDigest(board: SecretaryBoard, now: number): SecretaryDigest {
  const sessions = [...board.needsYou, ...board.running, ...board.done].filter(
    (card): card is SessionCard => card.kind === 'session'
  );
  const dayStart = startOfDay(now);
  const today = sessions.filter((card) => card.updatedAt >= dayStart);
  const events = [...board.needsYou, ...board.running, ...board.done]
    .map((card) => (card.kind === 'proposal' ? proposalEvent(card) : sessionEvent(card)))
    .sort((left, right) => right.at - left.at);

  return {
    greeting: greetingAt(now),
    today: {
      dispatched: sessions.filter((card) => card.startedAt >= dayStart).length,
      completed: today.filter(
        (card) => card.result !== undefined && COMPLETED_RESULTS.has(card.result)
      ).length,
      failed: today.filter((card) => card.result === 'failed').length,
    },
    counts: {
      needsYou: board.needsYou.length,
      running: board.running.length,
      todos: board.todos.length,
    },
    events: events.slice(0, EVENT_LIMIT),
  };
}
