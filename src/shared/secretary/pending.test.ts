import { describe, expect, it } from 'vitest';
import { type DependencyFacts, dependencyState, pendingOutcome } from './pending';

const facts = (overrides: Partial<DependencyFacts> = {}): DependencyFacts => ({
  conversationId: 'c1',
  present: true,
  state: 'idle',
  stopped: false,
  tracked: true,
  ...overrides,
});

describe('dependencyState', () => {
  it('有目标的会话要 goal-complete 且已空闲才算真正结束', () => {
    expect(dependencyState(facts({ goalStatus: 'active', result: 'goal-complete' }))).toBe('done');
    expect(dependencyState(facts({ goalStatus: 'completed' }))).toBe('done');
    expect(dependencyState(facts({ goalStatus: 'active', result: 'turn-ended' }))).toBe('waiting');
    expect(dependencyState(facts({ goalStatus: 'active', state: 'running' }))).toBe('waiting');
  });

  it('没有目标的会话要回合结束且已空闲', () => {
    expect(dependencyState(facts({ result: 'turn-ended' }))).toBe('done');
    expect(dependencyState(facts({ result: 'stalled' }))).toBe('waiting');
    expect(dependencyState(facts({ result: 'turn-ended', state: 'running' }))).toBe('waiting');
  });

  it('没跟踪的会话只看会话行：空闲且没有目标就算结束', () => {
    expect(dependencyState(facts({ tracked: false }))).toBe('done');
    expect(dependencyState(facts({ tracked: false, goalStatus: 'active' }))).toBe('waiting');
  });

  it('等后台任务时空闲不算结束', () => {
    expect(dependencyState(facts({ result: 'turn-ended', backgroundRunning: true }))).toBe(
      'waiting'
    );
  });

  it('失败、被停止、被删除都算不会再开始', () => {
    expect(dependencyState(facts({ result: 'failed' }))).toBe('failed');
    expect(dependencyState(facts({ state: 'error' }))).toBe('failed');
    expect(dependencyState(facts({ stopped: true }))).toBe('stopped');
    expect(dependencyState(facts({ result: 'interrupted' }))).toBe('stopped');
    expect(dependencyState(facts({ present: false }))).toBe('deleted');
  });
});

describe('pendingOutcome', () => {
  it('全部结束才开始，还在等就继续等', () => {
    expect(pendingOutcome([facts({ result: 'turn-ended' })])).toEqual({ kind: 'start' });
    expect(
      pendingOutcome([facts({ result: 'turn-ended' }), facts({ conversationId: 'c2' })])
    ).toEqual({ kind: 'wait' });
  });

  it('任何一个出问题就整条不启动，按 after 的顺序报第一个', () => {
    expect(
      pendingOutcome([
        facts({ conversationId: 'c1', result: 'turn-ended' }),
        facts({ conversationId: 'c2', result: 'failed' }),
      ])
    ).toEqual({ kind: 'failed', problem: 'dependency-failed', conversationId: 'c2' });
    expect(pendingOutcome([facts({ present: false })])).toEqual({
      kind: 'failed',
      problem: 'dependency-deleted',
      conversationId: 'c1',
    });
  });
});
