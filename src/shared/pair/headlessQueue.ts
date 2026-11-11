import type { PairQueueAction } from '@shared/types/pair';

export const GOAL_AUTO_TURN_LIMIT = 25;

export interface HeadlessQueuedMessage {
  id: string;
  text: string;
  images?: { data: string; mimeType: string }[];
}

export interface HeadlessGoal {
  text: string;
  status: 'active' | 'paused' | 'completed' | 'blocked' | 'waiting';
  note?: string;
  autoTurns: number;
}

export interface HeadlessSessionRuntime {
  status: string;
  started: boolean;
  queued: HeadlessQueuedMessage[];
  goal?: HeadlessGoal;
  pendingApprovals: number;
  pendingAsks: number;
  compaction: boolean;
  abortRequested: boolean;
}

export interface HeadlessDelivery {
  kind: 'prompt' | 'steer';
  text: string;
  images?: HeadlessQueuedMessage['images'];
}

export function emptyHeadlessRuntime(): HeadlessSessionRuntime {
  return {
    status: 'idle',
    started: false,
    queued: [],
    pendingApprovals: 0,
    pendingAsks: 0,
    compaction: false,
    abortRequested: false,
  };
}

function canFlush(runtime: HeadlessSessionRuntime): boolean {
  return (
    runtime.started &&
    runtime.status === 'idle' &&
    !runtime.compaction &&
    runtime.pendingApprovals === 0 &&
    runtime.pendingAsks === 0 &&
    !runtime.abortRequested
  );
}

function takeQueued(
  runtime: HeadlessSessionRuntime,
  messageId?: string
): { runtime: HeadlessSessionRuntime; item: HeadlessQueuedMessage } | null {
  const index = messageId
    ? runtime.queued.findIndex((item) => item.id === messageId)
    : runtime.queued.length > 0
      ? 0
      : -1;
  if (index < 0) return null;
  const item = runtime.queued[index];
  return {
    runtime: { ...runtime, queued: runtime.queued.filter((_, i) => i !== index) },
    item,
  };
}

export function goalKickoffText(objective: string): string {
  return (
    `<goal-continuation>\nSession goal: ${objective}\n` +
    'Work toward this goal autonomously. When done call goal_complete with evidence; ' +
    'if blocked call goal_blocked; if waiting on something external call goal_wait.\n</goal-continuation>'
  );
}

export function goalContinueText(objective: string): string {
  return (
    `<goal-continuation>\nSession goal: ${objective}\n` +
    'Continue working toward it. If it is genuinely done, call goal_complete with evidence; ' +
    'if you cannot proceed without the user, call goal_blocked; if waiting on something ' +
    'external, call goal_wait. Otherwise take the next concrete step now.\n</goal-continuation>'
  );
}

function flushQueue(runtime: HeadlessSessionRuntime): {
  runtime: HeadlessSessionRuntime;
  deliver?: HeadlessDelivery;
} {
  if (!canFlush(runtime)) return { runtime };
  const taken = takeQueued(runtime);
  if (!taken) return { runtime };
  return {
    runtime: { ...taken.runtime, status: 'running' },
    deliver: { kind: 'prompt', text: taken.item.text, images: taken.item.images },
  };
}

function continueGoal(
  runtime: HeadlessSessionRuntime,
  autoTurnLimit = GOAL_AUTO_TURN_LIMIT
): {
  runtime: HeadlessSessionRuntime;
  deliver?: HeadlessDelivery;
} {
  const goal = runtime.goal;
  if (!canFlush(runtime) || goal?.status !== 'active' || runtime.queued.length > 0) {
    return { runtime };
  }
  if (goal.autoTurns >= autoTurnLimit) {
    return {
      runtime: {
        ...runtime,
        goal: {
          ...goal,
          status: 'paused',
          note: `automatic-turn limit (${autoTurnLimit}) reached`,
        },
      },
    };
  }
  return {
    runtime: {
      ...runtime,
      status: 'running',
      goal: { ...goal, autoTurns: goal.autoTurns + 1 },
    },
    deliver: { kind: 'prompt', text: goalContinueText(goal.text) },
  };
}

export function applyHeadlessGoalSignal(
  runtime: HeadlessSessionRuntime,
  kind: 'complete' | 'blocked' | 'wait',
  note: string
): HeadlessSessionRuntime {
  if (!runtime.goal) return runtime;
  const status = kind === 'complete' ? 'completed' : kind === 'blocked' ? 'blocked' : 'waiting';
  return { ...runtime, goal: { ...runtime.goal, status, note } };
}

/** 轮次收束：先清中断标记，再投队列，最后续跑 goal。 */
export function onHeadlessIdle(
  runtime: HeadlessSessionRuntime,
  options?: { autoTurnLimit?: number }
): {
  runtime: HeadlessSessionRuntime;
  deliver?: HeadlessDelivery;
} {
  const next = {
    ...runtime,
    status: 'idle',
    compaction: false,
    abortRequested: false,
  };
  if (runtime.abortRequested) return { runtime: next };
  const queued = flushQueue(next);
  if (queued.deliver) return queued;
  return continueGoal(queued.runtime, options?.autoTurnLimit);
}

export function applyHeadlessQueueAction(
  runtime: HeadlessSessionRuntime,
  action: PairQueueAction,
  newId: () => string
): { runtime: HeadlessSessionRuntime; deliver?: HeadlessDelivery; abort?: boolean } {
  switch (action.type) {
    case 'enqueue': {
      if (!action.text && !action.images?.length) return { runtime };
      const item: HeadlessQueuedMessage = {
        id: newId(),
        text: action.text,
        ...(action.images?.length ? { images: action.images } : {}),
      };
      return flushQueue({ ...runtime, queued: [...runtime.queued, item] });
    }
    case 'queue-remove':
      return {
        runtime: {
          ...runtime,
          queued: runtime.queued.filter((item) => item.id !== action.messageId),
        },
      };
    case 'queue-update':
      return {
        runtime: {
          ...runtime,
          queued: runtime.queued.map((item) =>
            item.id === action.messageId ? { ...item, text: action.text } : item
          ),
        },
      };
    case 'queue-send-now': {
      const taken = takeQueued(runtime, action.messageId);
      if (!taken || runtime.compaction) return { runtime };
      const running = runtime.status === 'running';
      return {
        runtime: { ...taken.runtime, status: 'running' },
        deliver: {
          kind: running ? 'steer' : 'prompt',
          text: taken.item.text,
          images: taken.item.images,
        },
      };
    }
    case 'queue-interrupt-send': {
      const item = runtime.queued.find((candidate) => candidate.id === action.messageId);
      if (!item) return { runtime };
      if (runtime.status !== 'running') {
        return applyHeadlessQueueAction(runtime, { ...action, type: 'queue-send-now' }, newId);
      }
      const goal =
        runtime.goal?.status === 'active'
          ? { ...runtime.goal, status: 'paused' as const, note: 'stopped by user' }
          : runtime.goal;
      return { runtime: { ...runtime, abortRequested: true, goal }, abort: true };
    }
    case 'goal-pause':
      return runtime.goal
        ? { runtime: { ...runtime, goal: { ...runtime.goal, status: 'paused' } } }
        : { runtime };
    case 'goal-resume': {
      if (!runtime.goal) return { runtime };
      return continueGoal({ ...runtime, goal: { ...runtime.goal, status: 'active' } });
    }
    case 'goal-clear':
      return { runtime: { ...runtime, goal: undefined } };
    case 'goal-set': {
      const goal: HeadlessGoal = {
        text: action.text,
        status: 'active',
        autoTurns: runtime.started ? 1 : 0,
      };
      const next = { ...runtime, goal };
      if (!canFlush(next)) return { runtime: next };
      return {
        runtime: { ...next, status: 'running', goal: { ...goal, autoTurns: 1 } },
        deliver: { kind: 'prompt', text: goalKickoffText(action.text) },
      };
    }
    default:
      return { runtime };
  }
}
