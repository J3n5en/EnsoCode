import { describe, expect, it } from 'vitest';
import {
  PATROL_IDLE_GOAL_MS,
  PATROL_IDLE_MS,
  PATROL_RUNNING_MS,
  type PatrolFacts,
  patrolAnomalies,
  patrolStallDetail,
} from './patrol';

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
  it('空闲超过 20 分钟、目标没完成、没有待处理项 → 报一次（有后台任务时的兜底）', () => {
    expect(patrolAnomalies([facts({ backgroundRunning: true })], PATROL_IDLE_MS + 1)).toEqual([
      { conversationId: 'c1', reason: 'idle-stalled' },
    ]);
  });

  it('正常时什么都不报', () => {
    expect(patrolAnomalies([facts()], PATROL_IDLE_GOAL_MS - 1)).toEqual([]);
    expect(patrolAnomalies([facts({ state: 'running' })], PATROL_RUNNING_MS - 1)).toEqual([]);
  });

  it('有待处理项、等后台任务、目标已完成或有收口结果都不算异常', () => {
    const now = PATROL_IDLE_GOAL_MS + 1;
    expect(patrolAnomalies([facts({ pending: 1 })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ backgroundRunning: true })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ goalStatus: 'completed' })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ goalStatus: 'paused' })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ goalStatus: undefined })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ result: 'goal-complete' })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ result: 'failed' })], now)).toEqual([]);
  });

  it('同一会话同一原因一轮只报一次', () => {
    const reported = facts({ patrol: { reason: 'goal-idle-stalled', turn: 0 } });
    expect(patrolAnomalies([reported], PATROL_IDLE_GOAL_MS + 1)).toEqual([]);
    // 换了一轮就是新问题，照报
    expect(patrolAnomalies([{ ...reported, turn: 1 }], PATROL_IDLE_GOAL_MS + 1)).toEqual([
      { conversationId: 'c1', reason: 'goal-idle-stalled' },
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

describe('goal 会话空闲停住', () => {
  it('goal 会话 idle 3 分钟、没有后台任务 → 报停住', () => {
    expect(patrolAnomalies([facts()], PATROL_IDLE_GOAL_MS + 1)).toEqual([
      { conversationId: 'c1', reason: 'goal-idle-stalled' },
    ]);
  });

  it('不到 3 分钟不报', () => {
    expect(patrolAnomalies([facts()], PATROL_IDLE_GOAL_MS - 1)).toEqual([]);
  });

  it('有存活后台任务的 idle 会话不走 3 分钟规则，仍按 20 分钟兜底', () => {
    const waiting = facts({ backgroundRunning: true });
    expect(patrolAnomalies([waiting], PATROL_IDLE_GOAL_MS + 1)).toEqual([]);
    expect(patrolAnomalies([waiting], PATROL_IDLE_MS + 1)).toEqual([
      { conversationId: 'c1', reason: 'idle-stalled' },
    ]);
  });

  it('刚 goal_complete、有终态结果、等用户回答都不算停住', () => {
    const now = PATROL_IDLE_GOAL_MS + 1;
    expect(patrolAnomalies([facts({ goalStatus: 'completed' })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ result: 'goal-complete' })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ result: 'failed' })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ pending: 1 })], now)).toEqual([]);
    // goal 已经不在 active/waiting：有意停下的，不报
    expect(patrolAnomalies([facts({ goalStatus: 'paused' })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ goalStatus: undefined })], now)).toEqual([]);
  });

  it('最后一条是完成汇报的不算停住', () => {
    const now = PATROL_IDLE_GOAL_MS + 1;
    expect(patrolAnomalies([facts({ lastText: '已完成：打包并安装 EnsoCode' })], now)).toEqual([]);
    expect(patrolAnomalies([facts({ lastText: 'All done, pushed to the branch.' })], now)).toEqual(
      []
    );
    // 说的是「还没完成」：仍然算停住
    expect(patrolAnomalies([facts({ lastText: '还没完成，卡在安装脚本' })], now)).toEqual([
      { conversationId: 'c1', reason: 'goal-idle-stalled' },
    ]);
    // 只是提到「完成度」：不是完成汇报
    expect(patrolAnomalies([facts({ lastText: '完成度 60%，还在装依赖' })], now)).toEqual([
      { conversationId: 'c1', reason: 'goal-idle-stalled' },
    ]);
    expect(
      patrolAnomalies([facts({ lastText: '我仍在运行，检查安装脚本是否真的执行了' })], now)
    ).toEqual([{ conversationId: 'c1', reason: 'goal-idle-stalled' }]);
  });

  it('同一次停住只报一次：3 分钟规则报过，20 分钟兜底不再报', () => {
    const reported = facts({ patrol: { reason: 'goal-idle-stalled', turn: 0, at: 0 } });
    expect(patrolAnomalies([reported], PATROL_IDLE_GOAL_MS + 1)).toEqual([]);
    expect(patrolAnomalies([reported], PATROL_IDLE_MS + 1)).toEqual([]);
    // 反过来也一样：兜底报过的，3 分钟规则不重复
    const fallback = facts({ patrol: { reason: 'idle-stalled', turn: 0, at: 0 } });
    expect(patrolAnomalies([fallback], PATROL_IDLE_GOAL_MS + 1)).toEqual([]);
  });

  it('会话有了新活动就重置，再停住会重新报', () => {
    const reported = facts({ patrol: { reason: 'goal-idle-stalled', turn: 0, at: 0 } });
    const resumed = { ...reported, lastEventAt: PATROL_IDLE_GOAL_MS + 1 };
    expect(patrolAnomalies([resumed], PATROL_IDLE_GOAL_MS + 2)).toEqual([]);
    expect(patrolAnomalies([resumed], PATROL_IDLE_GOAL_MS * 2 + 2)).toEqual([
      { conversationId: 'c1', reason: 'goal-idle-stalled' },
    ]);
  });
});

describe('patrolStallDetail', () => {
  it('带停多久、goal 状态、有没有后台任务、最后一条摘要', () => {
    expect(
      patrolStallDetail({
        reason: 'goal-idle-stalled',
        idleMinutes: 3,
        goalStatus: 'active',
        backgroundRunning: false,
        lastText: '我仍在运行，检查安装脚本是否真的执行了',
      })
    ).toBe(
      '自动巡检：目标还没完成，会话却已空闲 3 分钟 · 目标 active · 没有后台任务 · 最后一条：我仍在运行，检查安装脚本是否真的执行了'
    );
    expect(
      patrolStallDetail({
        reason: 'idle-stalled',
        idleMinutes: 20,
        goalStatus: 'active',
        backgroundRunning: true,
      })
    ).toBe('自动巡检：空闲超过 20 分钟，目标还没完成，也没有待处理项 · 目标 active · 有后台任务');
  });

  it('最后一条只取前 100 字', () => {
    const detail = patrolStallDetail({
      reason: 'goal-idle-stalled',
      idleMinutes: 4,
      lastText: 'x'.repeat(150),
    });
    expect(detail).toContain(`最后一条：${'x'.repeat(100)}…`);
    expect(detail).not.toContain('x'.repeat(101));
  });

  it('运行卡住只报时长', () => {
    expect(patrolStallDetail({ reason: 'running-stalled', idleMinutes: 30 })).toBe(
      '自动巡检：运行超过 30 分钟没有任何事件'
    );
  });
});
