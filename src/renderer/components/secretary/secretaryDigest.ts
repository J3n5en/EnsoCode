import { type FeedEvent, feedEvents, sessionFeed } from '@shared/secretary/feed';
import type { SecretaryBoard, SecretaryCard, SecretaryResultKind } from '@shared/types/secretary';

export type { FeedEvent, FeedTone } from '@shared/secretary/feed';
export { sessionFeed };

export interface SecretaryDigest {
  /** i18n key：Good morning / Good afternoon / Good evening */
  greeting: string;
  /** 按会话数：completed/failed 是今天派出的会话的最终状态，earlier 是之前派出或接手、今天完成的 */
  today: { dispatched: number; completed: number; failed: number; earlier: number };
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
  // 还在跑的卡带的是上一轮的结果，不是最终状态
  const running = new Set(
    board.running.flatMap((card) => (card.kind === 'session' ? [card.conversationId] : []))
  );
  const finalResult = (card: SessionCard) =>
    running.has(card.conversationId) ? undefined : card.result;
  const completed = (card: SessionCard) => {
    const result = finalResult(card);
    return result !== undefined && COMPLETED_RESULTS.has(result);
  };
  const dispatched = sessions.filter((card) => !card.takeover && card.startedAt >= dayStart);
  const dispatchedIds = new Set(dispatched.map((card) => card.conversationId));
  return {
    greeting: greetingAt(now),
    today: {
      dispatched: dispatched.length,
      completed: dispatched.filter(completed).length,
      failed: dispatched.filter((card) => finalResult(card) === 'failed').length,
      earlier: sessions.filter(
        (card) =>
          !dispatchedIds.has(card.conversationId) &&
          (card.resultAt ?? 0) >= dayStart &&
          completed(card)
      ).length,
    },
    counts: {
      needsYou: board.needsYou.length,
      running: board.running.length,
      todos: board.todos.filter((todo) => (todo.phase ?? 'todo') === 'todo').length,
    },
    events: feedEvents(board),
  };
}
