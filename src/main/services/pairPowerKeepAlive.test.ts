import type { SessionIdentity } from '@shared/builtinAgents';
import type { RendererAgentEvent, SessionSnapshot } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { applyPairPowerTaskEvent, shouldHoldPairPowerKeepAlive } from './pairPowerKeepAlive';

const identity = (sessionId: string): SessionIdentity => ({
  sessionId,
  generation: '11111111-1111-4111-8111-111111111111',
});

const snapshot = (sessionId: string, status: SessionSnapshot['status']): SessionSnapshot =>
  ({
    identity: identity(sessionId),
    status,
    messages: [],
    commands: [],
  }) as SessionSnapshot;

describe('shouldHoldPairPowerKeepAlive', () => {
  it('手机在线时持锁', () => {
    expect(shouldHoldPairPowerKeepAlive(true, 0)).toBe(true);
  });

  it('有任务在跑时持锁，即使手机不在线', () => {
    expect(shouldHoldPairPowerKeepAlive(false, 1)).toBe(true);
  });

  it('手机离线且没有任务时放锁', () => {
    expect(shouldHoldPairPowerKeepAlive(false, 0)).toBe(false);
  });
});

describe('applyPairPowerTaskEvent', () => {
  it('status=running 记入任务，idle/failed 清除', () => {
    let running = new Set<string>();
    running = applyPairPowerTaskEvent(running, {
      type: 'status',
      identity: identity('a'),
      seq: 1,
      status: 'running',
    });
    expect([...running]).toEqual(['a']);

    running = applyPairPowerTaskEvent(running, {
      type: 'status',
      identity: identity('a'),
      seq: 2,
      status: 'idle',
    });
    expect(running.size).toBe(0);
  });

  it('全量 snapshot 以 running 会话重置集合', () => {
    let running = new Set(['stale']);
    running = applyPairPowerTaskEvent(running, {
      type: 'snapshot',
      sessions: [snapshot('a', 'running'), snapshot('b', 'idle')],
    });
    expect([...running]).toEqual(['a']);
  });

  it('worker-exited 清空任务', () => {
    const running = applyPairPowerTaskEvent(new Set(['a', 'b']), { type: 'worker-exited' });
    expect(running.size).toBe(0);
  });

  it('无关事件不改集合', () => {
    const prev = new Set(['a']);
    const next = applyPairPowerTaskEvent(prev, {
      type: 'message-upsert',
      identity: identity('a'),
      seq: 1,
      index: 0,
      message: { role: 'assistant', content: [] },
    } as RendererAgentEvent);
    expect(next).toEqual(prev);
  });
});
