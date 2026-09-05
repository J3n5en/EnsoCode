import { describe, expect, it } from 'vitest';
import { conversationDotTone, conversationHasRunningChild } from './conversationDotTone';

describe('conversationHasRunningChild', () => {
  const parent = { status: 'idle', subagents: [], coworkerIds: ['child'] };

  it('subagent 运行时有活跃子任务', () => {
    expect(
      conversationHasRunningChild(
        { ...parent, subagents: [{ status: 'done' }, { status: 'running' }] },
        {}
      )
    ).toBe(true);
  });

  it.each(['spawning', 'running'] as const)('coworker %s 时有活跃子任务', (state) => {
    expect(
      conversationHasRunningChild(parent, {
        child: { status: state === 'running' ? 'running' : 'idle', spawning: state === 'spawning' },
      })
    ).toBe(true);
  });

  it('子任务均结束时没有活跃子任务', () => {
    expect(
      conversationHasRunningChild(
        { ...parent, subagents: [{ status: 'done' }, { status: 'failed' }] },
        { child: { status: 'failed' } }
      )
    ).toBe(false);
  });

  it('coworker 投影缺失时没有活跃子任务', () => {
    expect(conversationHasRunningChild(parent, {})).toBe(false);
  });
});

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

  it('父会话 idle 但有运行中的子任务时是 running', () => {
    expect(conversationDotTone({ status: 'idle', hasRunningChild: true })).toBe('running');
  });

  it('父会话无运行中的子任务时仍是 idle', () => {
    expect(conversationDotTone({ status: 'idle', hasRunningChild: false })).toBe('idle');
  });

  it('父会话失败时优先于运行中的子任务', () => {
    expect(conversationDotTone({ status: 'failed', hasRunningChild: true })).toBe('failed');
  });

  it('父会话等待 ask 时优先于运行中的子任务', () => {
    expect(conversationDotTone({ status: 'idle', pendingAskCount: 1, hasRunningChild: true })).toBe(
      'waiting'
    );
  });

  it('ask 已清空后回到 running', () => {
    expect(conversationDotTone({ status: 'running', spawning: false, pendingAskCount: 0 })).toBe(
      'running'
    );
  });
});
