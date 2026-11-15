import type { InterruptedTurn } from '@shared/exitInterrupt';
import { describe, expect, it } from 'vitest';
import { interruptedStateOf, shouldMarkInterrupted } from './interrupted';

const turn: InterruptedTurn = {
  conversationId: 'c1',
  turnId: 't1',
  startedAt: 100,
  exitAt: 200,
  kind: 'update',
  lastMessageIndex: 3,
  unfinishedTools: ['bash'],
  suppressedError: 'socket hang up',
};

describe('interruptedStateOf', () => {
  it('把退出记录收成会话上持久化的中断事实', () => {
    expect(interruptedStateOf(turn)).toEqual({
      at: 200,
      kind: 'update',
      unfinishedTools: ['bash'],
      suppressedError: 'socket hang up',
    });
  });

  it('没有误导性错误时不留空字段', () => {
    const state = interruptedStateOf({ ...turn, suppressedError: undefined });
    expect(state).not.toHaveProperty('suppressedError');
  });
});

describe('shouldMarkInterrupted', () => {
  it('已知且空闲的会话才标中断', () => {
    expect(shouldMarkInterrupted({ status: 'idle' })).toBe(true);
    expect(shouldMarkInterrupted({ status: 'failed' })).toBe(true);
    expect(shouldMarkInterrupted({ status: 'interrupted' })).toBe(true);
  });

  it('正在跑的会话不能被旧记录盖掉，陌生会话不改', () => {
    expect(shouldMarkInterrupted({ status: 'running' })).toBe(false);
    expect(shouldMarkInterrupted(undefined)).toBe(false);
  });
});
