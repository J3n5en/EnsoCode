import { describe, expect, it } from 'vitest';
import { PATROL_IDLE_MS, PATROL_RUNNING_MS, type PatrolFacts, patrolAnomalies } from './patrol';

const facts = (overrides: Partial<PatrolFacts> = {}): PatrolFacts => ({
  conversationId: 'c1',
  state: 'idle',
  goalStatus: 'active',
  pending: 0,
  lastEventAt: 0,
  turn: 0,
  stallReported: false,
  ...overrides,
});

describe('patrolAnomalies', () => {
  it('空闲超过 20 分钟、目标没完成、没有待处理项 → 报一次', () => {
    expect(patrolAnomalies([facts()], PATROL_IDLE_MS + 1)).toEqual([
      { conversationId: 'c1', reason: 'idle-stalled' },
    ]);
  });

  it('正常时什么都不报', () => {
    expect(patrolAnomalies([facts()], PATROL_IDLE_MS - 1)).toEqual([]);
    expect(patrolAnomalies([facts({ state: 'running' })], PATROL_RUNNING_MS - 1)).toEqual([]);
  });

  it('有待处理项、等后台任务、目标已完成或有收口结果都不算异常', () => {
    const now = PATROL_IDLE_MS + 1;
    expect(patrolAnomalies([facts({ pending: 1 })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ backgroundRunning: true })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ goalStatus: 'completed' })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ goalStatus: 'paused' })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ goalStatus: undefined })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ result: 'goal-complete' })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ result: 'failed' })], now)).toEqual([]);
  });

  it('同一会话同一原因一轮只报一次', () => {
    const reported = facts({ patrol: { reason: 'idle-stalled', turn: 0 } });
    expect(patrolAnomalies([reported], PATROL_IDLE_MS + 1)).toEqual([]);
    // 换了一轮就是新问题，照报
    expect(patrolAnomalies([{ ...reported, turn: 1 }], PATROL_IDLE_MS + 1)).toEqual([
      { conversationId: 'c1', reason: 'idle-stalled' },
    ]);
  });

  it('运行超过 30 分钟没有事件才报，且不与现有停滞检测重复', () => {
    const stuck = facts({ state: 'running', lastEventAt: 0 });
    expect(patrolAnomalies([stuck], PATROL_RUNNING_MS + 1)).toEqual([
      { conversationId: 'c1', reason: 'running-stalled' },
    ]);
    expect(patrolAnomalies([{ ...stuck, stallReported: true }], PATROL_RUNNING_MS + 1)).toEqual([]);
  });

  it('等用户、报错、没开始都不算异常', () => {
    const now = PATROL_RUNNING_MS + 1;
    expect(patrolAnomalies([facts({ state: 'waiting' })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ state: 'error' })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ state: 'not-started' })], now)).toEqual([]);
  });
});
