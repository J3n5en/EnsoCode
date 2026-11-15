import { type FeedEvent, feedEvents, sessionFeed } from '@shared/secretary/feed';
import type { SecretaryBoard, SecretaryCard, SecretaryResultKind } from '@shared/types/secretary';

export type { FeedEvent, FeedTone } from '@shared/secretary/feed';
export { sessionFeed };

export interface SecretaryDigest {
  /** i18n key：Good morning / Good afternoon / Good evening */
  greeting: string;
  today: { dispatched: number; completed: number; failed: number };
  counts: { needsYou: number; running: number; todos: number };
  events: FeedEvent[];
}

export type SecretarySessionCard = Extract<SecretaryCard, { kind: 'session' }>;

type SessionCard = SecretarySessionCard;

const COMPLETED_RESULTS: ReadonlySet<SecretaryResultKind> = new Set([
  'goal-complete',
  'turn-ended',
]);

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

/** 工作台首屏与侧栏摘要共用的纯投影：问候、今日战报、计数与动态时间线 */
export function secretaryDigest(board: SecretaryBoard, now: number): SecretaryDigest {
  const sessions = [...board.needsYou, ...board.running, ...board.done].filter(
    (card): card is SessionCard => card.kind === 'session'
  );
  const dayStart = startOfDay(now);
  const today = sessions.filter((card) => (card.resultAt ?? 0) >= dayStart);
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
      todos: board.todos.filter((todo) => (todo.phase ?? 'todo') === 'todo').length,
    },
    events: feedEvents(board),
  };
}
