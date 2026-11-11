import { emptyHeadlessRuntime, type HeadlessSessionRuntime } from '@shared/pair/headlessQueue';
import { describe, expect, it } from 'vitest';
import { initialPrompt, nextGoalStep } from './goalDrive';

const active = (autoTurns: number) => ({
  ...emptyHeadlessRuntime(),
  started: true,
  status: 'idle',
  goal: { text: 'ship it', status: 'active' as const, autoTurns },
});

describe('goal drive', () => {
  it('builds the first prompt from a goal, a prompt, or both', () => {
    expect(initialPrompt('', 'ship it')).toContain('Session goal: ship it');
    expect(initialPrompt('do this', undefined)).toBe('do this');
    expect(initialPrompt('do this', 'ship it')).toContain('do this');
    expect(initialPrompt('do this', 'ship it')).toContain('Session goal: ship it');
    expect(initialPrompt('ship it', 'ship it')).not.toContain('ship it\n\n');
  });

  it('continues once, then stops at the caller limit', () => {
    const first = nextGoalStep({
      runtime: active(1),
      assistantText: 'working',
      lastOutput: '',
      noProgressRuns: 0,
      autoTurnLimit: 2,
    });
    expect(first.deliver?.text).toContain('Continue working');
    expect(first.runtime.goal?.autoTurns).toBe(2);
    const second = nextGoalStep({
      runtime: first.runtime,
      assistantText: 'still working',
      lastOutput: first.lastOutput,
      noProgressRuns: first.noProgressRuns,
      autoTurnLimit: 2,
    });
    expect(second.deliver).toBeUndefined();
    expect(second.runtime.goal).toMatchObject({
      status: 'paused',
      note: 'automatic-turn limit (2) reached',
    });
  });

  it('pauses after three identical assistant replies and ignores a finished goal', () => {
    let runtime: HeadlessSessionRuntime = active(1);
    let lastOutput = '';
    let noProgressRuns = 0;
    for (let i = 0; i < 4; i++) {
      const step = nextGoalStep({
        runtime,
        assistantText: 'same',
        lastOutput,
        noProgressRuns,
        autoTurnLimit: 25,
      });
      runtime = step.runtime;
      lastOutput = step.lastOutput;
      noProgressRuns = step.noProgressRuns;
    }
    expect(runtime.goal?.status).toBe('paused');
    expect(runtime.goal?.note).toBe('no progress in 3 consecutive runs');
    const done = nextGoalStep({
      runtime: { ...active(1), goal: { text: 'ship it', status: 'completed', autoTurns: 1 } },
      assistantText: '',
      lastOutput: '',
      noProgressRuns: 0,
      autoTurnLimit: 25,
    });
    expect(done.deliver).toBeUndefined();
    expect(done.runtime.goal?.status).toBe('completed');
  });
});
