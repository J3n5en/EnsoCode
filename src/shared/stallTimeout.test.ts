import { describe, expect, it } from 'vitest';
import {
  hasLiveGenerationWork,
  MAX_STALL_RETRIES,
  nextStallWatchAction,
  shiftHeartbeatsAfterResume,
  shouldAbortStalledGeneration,
  stallHeartbeatAt,
  stallLiveWorkFlags,
} from './stallTimeout';

describe('shouldAbortStalledGeneration', () => {
  it('超时关闭或未 running 不中止', () => {
    expect(
      shouldAbortStalledGeneration({
        status: 'running',
        lastOutputAt: 0,
        now: 60_000,
        timeoutMs: 0,
      })
    ).toBe(false);
    expect(
      shouldAbortStalledGeneration({
        status: 'idle',
        lastOutputAt: 0,
        now: 60_000,
        timeoutMs: 5_000,
      })
    ).toBe(false);
    expect(
      shouldAbortStalledGeneration({
        status: 'running',
        spawning: true,
        runStartedAt: 0,
        now: 60_000,
        timeoutMs: 5_000,
      })
    ).toBe(false);
  });

  it('无输出超过阈值则中止', () => {
    expect(
      shouldAbortStalledGeneration({
        status: 'running',
        lastOutputAt: 1_000,
        now: 11_000,
        timeoutMs: 10_000,
      })
    ).toBe(true);
    expect(
      shouldAbortStalledGeneration({
        status: 'running',
        lastOutputAt: 1_000,
        now: 10_999,
        timeoutMs: 10_000,
      })
    ).toBe(false);
  });

  it('没有 lastOutputAt 时用 runStartedAt', () => {
    expect(
      shouldAbortStalledGeneration({
        status: 'running',
        runStartedAt: 0,
        now: 5_000,
        timeoutMs: 4_000,
      })
    ).toBe(true);
    expect(
      shouldAbortStalledGeneration({
        status: 'running',
        now: 5_000,
        timeoutMs: 4_000,
      })
    ).toBe(false);
  });

  it('等人时不算卡住，即使最近一条消息已超时', () => {
    expect(
      shouldAbortStalledGeneration({
        status: 'running',
        lastOutputAt: 0,
        now: 10_000,
        timeoutMs: 5_000,
        hasLiveWork: true,
      })
    ).toBe(false);
  });
});

describe('nextStallWatchAction', () => {
  it('先 abort，idle 后再 retry', () => {
    expect(
      nextStallWatchAction({
        shouldAbort: true,
        status: 'running',
        pendingRetry: false,
        attempts: 0,
      })
    ).toBe('abort');
    expect(
      nextStallWatchAction({
        shouldAbort: false,
        status: 'idle',
        pendingRetry: true,
        attempts: 0,
      })
    ).toBe('retry');
  });

  it(`连续空等满 ${MAX_STALL_RETRIES} 次放弃`, () => {
    expect(
      nextStallWatchAction({
        shouldAbort: false,
        status: 'idle',
        pendingRetry: true,
        attempts: MAX_STALL_RETRIES,
      })
    ).toBe('give-up');
  });
});

describe('hasLiveGenerationWork', () => {
  const idle = {
    pendingApprovals: 0,
    pendingAsks: 0,
  };

  it('默认为空等', () => {
    expect(hasLiveGenerationWork(idle)).toBe(false);
  });

  it('等人审批或提问时不算卡住', () => {
    expect(hasLiveGenerationWork({ ...idle, pendingApprovals: 1 })).toBe(true);
    expect(hasLiveGenerationWork({ ...idle, pendingAsks: 1 })).toBe(true);
  });

  it('coworker 还在 spawning 时不算卡住', () => {
    expect(hasLiveGenerationWork({ ...idle, spawningCoworker: true })).toBe(true);
  });
});

describe('stallLiveWorkFlags', () => {
  it('缺字段或 null 集合视为无 live work，且不抛', () => {
    expect(() => stallLiveWorkFlags({})).not.toThrow();
    expect(() =>
      stallLiveWorkFlags({
        toolOutputs: null,
        pendingApprovals: null,
        pendingAsks: null,
        backgroundTasks: null,
        subagents: null,
      })
    ).not.toThrow();
    expect(stallLiveWorkFlags({})).toEqual({
      pendingApprovals: 0,
      pendingAsks: 0,
    });
    expect(hasLiveGenerationWork(stallLiveWorkFlags({}))).toBe(false);
  });

  it('已有审批集合按实际内容计数；静默工具/子代理不构成豁免', () => {
    expect(
      stallLiveWorkFlags({
        toolOutputs: { t1: 'x' },
        pendingApprovals: [{}],
        pendingAsks: [],
        backgroundTasks: [{ status: 'running' }],
        subagents: [{ status: 'running' }],
      })
    ).toEqual({
      pendingApprovals: 1,
      pendingAsks: 0,
    });
    expect(
      hasLiveGenerationWork(
        stallLiveWorkFlags({
          toolOutputs: { t1: '' },
          backgroundTasks: [{ status: 'running' }],
          subagents: [{ status: 'running' }],
        })
      )
    ).toBe(false);
  });
});

describe('stallHeartbeatAt', () => {
  it('无子会话时用自身 lastOutputAt / runStartedAt', () => {
    expect(stallHeartbeatAt({ lastOutputAt: 3_000, runStartedAt: 1_000 }, {})).toBe(3_000);
    expect(stallHeartbeatAt({ runStartedAt: 1_000 }, {})).toBe(1_000);
    expect(stallHeartbeatAt({}, {})).toBeUndefined();
  });

  it('父会话等 coworker 时沿用子会话心跳，子也静默才算空等', () => {
    const parent = { lastOutputAt: 1_000, coworkerIds: ['kid'] };
    expect(
      stallHeartbeatAt(parent, {
        kid: { status: 'running', lastOutputAt: 8_000 },
      })
    ).toBe(8_000);
    expect(
      stallHeartbeatAt(parent, {
        kid: { status: 'running', lastOutputAt: 1_000 },
      })
    ).toBe(1_000);
    expect(
      stallHeartbeatAt(parent, {
        kid: { status: 'idle', lastOutputAt: 9_000 },
      })
    ).toBe(1_000);
  });

  it('运行中的前台命令有截止时间时，按截止时间计时，过期后照常中止', () => {
    const conversation = { lastOutputAt: 1_000, toolDeadlineAt: { t1: 601_000 } };
    const at = stallHeartbeatAt(conversation, {});
    expect(at).toBe(601_000);
    const stalled = (now: number) =>
      shouldAbortStalledGeneration({
        status: 'running',
        lastOutputAt: at,
        now,
        timeoutMs: 300_000,
      });
    expect(stalled(400_000)).toBe(false);
    expect(stalled(900_000)).toBe(false);
    expect(stalled(901_000)).toBe(true);
    expect(
      stallHeartbeatAt(
        { lastOutputAt: 1_000, coworkerIds: ['kid'] },
        { kid: { status: 'running', lastOutputAt: 2_000, toolDeadlineAt: { t: 700_000 } } }
      )
    ).toBe(700_000);
  });
});

describe('shiftHeartbeatsAfterResume', () => {
  // 真实场景：用户睡前有会话在跑，机器睡了一夜；醒来 lastOutputAt 是 8 小时前，
  // 看门狗第一轮 tick 就会误判卡死。唤醒时把心跳重置到唤醒时刻重新计时
  it('运行中会话的心跳重置到唤醒时刻', () => {
    const now = 1_000_000;
    const shifted = shiftHeartbeatsAfterResume(
      {
        a: { status: 'running', lastOutputAt: now - 8 * 60 * 60 * 1000 },
      },
      now
    );
    expect(shifted.a).toEqual({ lastOutputAt: now });
  });

  it('非 running 或无心跳的会话不动', () => {
    const now = 1_000_000;
    const shifted = shiftHeartbeatsAfterResume(
      {
        idle: { status: 'idle', lastOutputAt: 1 },
        noBeat: { status: 'running' },
      },
      now
    );
    expect(shifted.idle).toBeUndefined();
    expect(shifted.noBeat).toBeUndefined();
  });
});
