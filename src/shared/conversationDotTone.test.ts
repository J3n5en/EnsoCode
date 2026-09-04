import { describe, expect, it } from 'vitest';
import { conversationDotTone } from './conversationDotTone';

describe('conversationDotTone', () => {
  it('ask 挂起时即使仍 running 也标 waiting（绿灯）', () => {
    expect(conversationDotTone({ status: 'running', spawning: false, pendingAskCount: 1 })).toBe(
      'waiting'
    );
  });

  it('running 无 ask 仍是 running（蓝灯）', () => {
    expect(conversationDotTone({ status: 'running', spawning: false })).toBe('running');
  });

  it('spawning 无 ask 是 running', () => {
    expect(conversationDotTone({ status: 'idle', spawning: true })).toBe('running');
  });

  it('失败优先于 ask', () => {
    expect(conversationDotTone({ status: 'failed', spawning: false, pendingAskCount: 1 })).toBe(
      'failed'
    );
  });

  it('idle 未读是 unread', () => {
    expect(conversationDotTone({ status: 'idle', unread: true })).toBe('unread');
  });

  it('idle 默认 idle', () => {
    expect(conversationDotTone({ status: 'idle' })).toBe('idle');
  });

  it('ask 已清空后回到 running', () => {
    expect(conversationDotTone({ status: 'running', spawning: false, pendingAskCount: 0 })).toBe(
      'running'
    );
  });
});
