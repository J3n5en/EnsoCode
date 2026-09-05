import { describe, expect, it } from 'vitest';
import {
  hasInFlightToolCalls,
  hasLiveGenerationWork,
  MAX_STALL_RETRIES,
  nextStallWatchAction,
  shouldAbortStalledGeneration,
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

  it('工具还在跑时不算卡住，即使最近一条消息已超时', () => {
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
    runningBackgroundTasks: false,
    runningSubagents: false,
    hasToolOutput: false,
    liveCoworker: false,
    inFlightTools: false,
  };

  it('默认为空等', () => {
    expect(hasLiveGenerationWork(idle)).toBe(false);
  });

  it('父会话还在等活着的 coworker 时算有输出', () => {
    expect(hasLiveGenerationWork({ ...idle, liveCoworker: true })).toBe(true);
  });

  it('工具增量或后台任务在跑时算有输出', () => {
    expect(hasLiveGenerationWork({ ...idle, hasToolOutput: true })).toBe(true);
    expect(hasLiveGenerationWork({ ...idle, runningBackgroundTasks: true })).toBe(true);
  });

  it('主会话还在等 bash / coworker 工具返回时算有输出', () => {
    expect(hasLiveGenerationWork({ ...idle, inFlightTools: true })).toBe(true);
  });
});

describe('hasInFlightToolCalls', () => {
  const bashCall = { type: 'toolCall', id: 't1', name: 'bash' };
  const coworkerCall = { type: 'toolCall', id: 't1', name: 'coworker' };
  it('末轮 assistant 有未完成的 bash / coworker 调用', () => {
    expect(
      hasInFlightToolCalls([
        {
          role: 'assistant',
          content: [bashCall],
        },
      ])
    ).toBe(true);
    expect(
      hasInFlightToolCalls([
        {
          role: 'assistant',
          content: [coworkerCall],
        },
      ])
    ).toBe(true);
  });

  it('对应 toolResult 已到则不算进行中', () => {
    expect(
      hasInFlightToolCalls([
        {
          role: 'assistant',
          content: [bashCall],
        },
        { role: 'toolResult', toolCallId: 't1' },
      ])
    ).toBe(false);
  });

  it('历史轮次缺结果不算进行中', () => {
    expect(
      hasInFlightToolCalls([
        {
          role: 'assistant',
          content: [bashCall],
        },
        { role: 'user' },
        {
          role: 'assistant',
          content: [{ type: 'text' }],
        },
      ])
    ).toBe(false);
  });
});
