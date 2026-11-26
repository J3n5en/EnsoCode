import { describe, expect, it } from 'vitest';
import { initialAgySession, transitionAgySession } from './sessionPhase';

const ready = {
  sessionId: 's1',
  version: '1.5.18',
  canAppendSystemPrompt: true,
  configOptions: [],
  modes: [{ id: 'default' }, { id: 'plan' }],
};

describe('transitionAgySession', () => {
  it('walks spawning, initialized, ready, prompting, and back to ready', () => {
    const spawned = transitionAgySession(initialAgySession(), { type: 'spawn' });
    expect(spawned).toEqual({ phase: 'spawning' });
    const initialized = transitionAgySession(spawned, {
      type: 'initialized',
      version: '1.5.18',
      canAppendSystemPrompt: true,
    });
    const sessionReady = transitionAgySession(initialized, { type: 'session-ready', ...ready });
    const prompting = transitionAgySession(sessionReady, { type: 'prompt-started' });
    expect(prompting.phase).toBe('prompting');
    expect(transitionAgySession(prompting, { type: 'prompt-finished' }).phase).toBe(
      'session-ready'
    );
  });

  it('rejects a prompt before a session exists and treats close as idempotent', () => {
    const spawned = transitionAgySession(initialAgySession(), { type: 'spawn' });
    expect(transitionAgySession(spawned, { type: 'prompt-started' })).toEqual(spawned);
    const closed = transitionAgySession(spawned, { type: 'close' });
    expect(closed).toEqual({ phase: 'closed' });
    expect(transitionAgySession(closed, { type: 'close' })).toEqual({ phase: 'closed' });
  });

  it('records a failure and does not resume from it without a new spawn', () => {
    const failed = transitionAgySession(initialAgySession(), { type: 'fail', message: 'gone' });
    expect(failed).toEqual({ phase: 'failed', message: 'gone' });
    expect(transitionAgySession(failed, { type: 'prompt-started' })).toEqual(failed);
  });
});
