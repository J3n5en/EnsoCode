import { describe, expect, it } from 'vitest';
import {
  applyHeadlessGoalSignal,
  applyHeadlessQueueAction,
  emptyHeadlessRuntime,
  GOAL_AUTO_TURN_LIMIT,
  onHeadlessIdle,
} from './headlessQueue';

const ids = () => {
  let n = 0;
  return () => `q${++n}`;
};

describe('headless queue', () => {
  it('enqueues while running and flushes the head item on idle', () => {
    const running = { ...emptyHeadlessRuntime(), started: true, status: 'running' };
    const queued = applyHeadlessQueueAction(
      running,
      { type: 'enqueue', sessionId: 's', text: 'later' },
      ids()
    );
    expect(queued.deliver).toBeUndefined();
    expect(queued.runtime.queued).toHaveLength(1);
    const idle = onHeadlessIdle(queued.runtime);
    expect(idle.deliver).toEqual({ kind: 'prompt', text: 'later', images: undefined });
    expect(idle.runtime.queued).toHaveLength(0);
  });

  it('does not auto-deliver after a user abort', () => {
    const runtime = {
      ...emptyHeadlessRuntime(),
      started: true,
      status: 'running',
      abortRequested: true,
      queued: [{ id: 'q1', text: 'nope' }],
    };
    const idle = onHeadlessIdle(runtime);
    expect(idle.deliver).toBeUndefined();
    expect(idle.runtime.abortRequested).toBe(false);
    expect(idle.runtime.queued).toHaveLength(1);
  });

  it('steers a queued item into the current turn', () => {
    const runtime = {
      ...emptyHeadlessRuntime(),
      started: true,
      status: 'running',
      queued: [{ id: 'q1', text: 'now' }],
    };
    const sent = applyHeadlessQueueAction(
      runtime,
      { type: 'queue-send-now', sessionId: 's', messageId: 'q1' },
      ids()
    );
    expect(sent.deliver).toEqual({ kind: 'steer', text: 'now', images: undefined });
  });

  it('pauses goal continuation at the automatic turn cap', () => {
    const runtime = {
      ...emptyHeadlessRuntime(),
      started: true,
      status: 'idle',
      goal: { text: 'ship it', status: 'active' as const, autoTurns: GOAL_AUTO_TURN_LIMIT },
    };
    const idle = onHeadlessIdle(runtime);
    expect(idle.deliver).toBeUndefined();
    expect(idle.runtime.goal?.status).toBe('paused');
    expect(idle.runtime.goal?.note).toBe('automatic-turn limit (25) reached');
  });

  it('stops continuation after a goal signal', () => {
    const runtime = {
      ...emptyHeadlessRuntime(),
      started: true,
      status: 'idle' as const,
      goal: { text: 'ship it', status: 'active' as const, autoTurns: 1 },
    };
    const completed = applyHeadlessGoalSignal(runtime, 'complete', 'shipped');
    expect(completed.goal).toMatchObject({ status: 'completed', note: 'shipped' });
    expect(onHeadlessIdle(completed).deliver).toBeUndefined();

    const blocked = applyHeadlessGoalSignal(runtime, 'blocked', 'need a token');
    expect(blocked.goal?.status).toBe('blocked');
    const waiting = applyHeadlessGoalSignal(runtime, 'wait', 'ci');
    expect(waiting.goal?.status).toBe('waiting');
    expect(applyHeadlessGoalSignal(emptyHeadlessRuntime(), 'complete', 'x').goal).toBeUndefined();
  });

  it('honors a caller-supplied automatic turn limit', () => {
    const runtime = {
      ...emptyHeadlessRuntime(),
      started: true,
      status: 'idle' as const,
      goal: { text: 'ship it', status: 'active' as const, autoTurns: 1 },
    };
    const idle = onHeadlessIdle(runtime, { autoTurnLimit: 1 });
    expect(idle.deliver).toBeUndefined();
    expect(idle.runtime.goal?.note).toBe('automatic-turn limit (1) reached');
  });
});
