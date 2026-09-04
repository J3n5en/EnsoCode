import { describe, expect, it } from 'vitest';
import { agentCommandDispatch } from './agentCommandDispatch';

describe('agentCommandDispatch', () => {
  it('worker 已就绪 → 立刻下发', () => {
    expect(agentCommandDispatch({ hasWorker: true, workerReady: true, workerExited: false })).toBe(
      'post'
    );
  });

  it('已 fork 未 spawn → 入队，等 spawn 后补发', () => {
    expect(agentCommandDispatch({ hasWorker: true, workerReady: false, workerExited: false })).toBe(
      'queue'
    );
  });

  it('冷启动尚未 fork → 入队，不报 worker not running', () => {
    expect(
      agentCommandDispatch({ hasWorker: false, workerReady: false, workerExited: false })
    ).toBe('queue');
  });

  it('worker 崩过 → 先重建再入队', () => {
    expect(agentCommandDispatch({ hasWorker: false, workerReady: false, workerExited: true })).toBe(
      'restart-then-queue'
    );
  });
});
