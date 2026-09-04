import { describe, expect, it } from 'vitest';
import {
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
