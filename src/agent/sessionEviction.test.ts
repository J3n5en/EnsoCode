import { describe, expect, it } from 'vitest';
import { type EvictionCandidate, IDLE_SESSION_TTL_MS, selectEvictable } from './sessionEviction';

const now = 10_000_000;
const stale = now - IDLE_SESSION_TTL_MS;

function candidate(overrides: Partial<EvictionCandidate> = {}): EvictionCandidate {
  return {
    sessionId: 'p1',
    isChild: false,
    status: 'idle',
    lastActivityAt: stale,
    hasPendingWork: false,
    hasChildren: false,
    ...overrides,
  };
}

describe('selectEvictable', () => {
  it('回收到期且完全空闲的父会话', () => {
    expect(selectEvictable([candidate()], new Set(), now)).toEqual(['p1']);
  });

  it('未到期不回收（刚好到期才回收）', () => {
    expect(selectEvictable([candidate({ lastActivityAt: stale + 1 })], new Set(), now)).toEqual([]);
    expect(selectEvictable([candidate({ lastActivityAt: stale })], new Set(), now)).toEqual(['p1']);
  });

  it('pinned（正在查看/手机订阅）不回收', () => {
    expect(selectEvictable([candidate()], new Set(['p1']), now)).toEqual([]);
  });

  it('非 idle 不回收', () => {
    expect(selectEvictable([candidate({ status: 'running' })], new Set(), now)).toEqual([]);
    expect(selectEvictable([candidate({ status: 'failed' })], new Set(), now)).toEqual([]);
  });

  it('有挂起工作（ask/approval/后台任务/提醒）或有子会话不回收', () => {
    expect(selectEvictable([candidate({ hasPendingWork: true })], new Set(), now)).toEqual([]);
    expect(selectEvictable([candidate({ hasChildren: true })], new Set(), now)).toEqual([]);
  });

  it('子会话本身从不单独回收（随父会话 release）', () => {
    expect(
      selectEvictable([candidate({ sessionId: 'p1::cw-a', isChild: true })], new Set(), now)
    ).toEqual([]);
  });

  it('多会话只挑出满足条件的', () => {
    const result = selectEvictable(
      [
        candidate({ sessionId: 'a' }),
        candidate({ sessionId: 'b', status: 'running' }),
        candidate({ sessionId: 'c', lastActivityAt: now }),
        candidate({ sessionId: 'd' }),
      ],
      new Set(['d']),
      now
    );
    expect(result).toEqual(['a']);
  });
});
