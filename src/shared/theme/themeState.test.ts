import { describe, expect, it } from 'vitest';
import { appActivityState, conversationThemeState, sessionThemeState } from './themeState';

const idle = { status: 'idle' };

describe('sessionThemeState', () => {
  it('按 error > waiting > running > idle 取值', () => {
    expect(sessionThemeState(idle, {})).toBe('idle');
    expect(sessionThemeState({ status: 'running' }, {})).toBe('running');
    expect(sessionThemeState({ status: 'running', pendingAsks: [{}] }, {})).toBe('waiting');
    expect(sessionThemeState({ status: 'idle', pendingApprovals: [{}] }, {})).toBe('waiting');
    expect(sessionThemeState({ status: 'failed', pendingAsks: [{}] }, {})).toBe('error');
  });

  it('未读不算状态，子代理或 coworker 在跑算 running', () => {
    expect(sessionThemeState({ status: 'idle', unread: true }, {})).toBe('idle');
    expect(sessionThemeState({ status: 'idle', subagents: [{ status: 'running' }] }, {})).toBe(
      'running'
    );
    expect(
      sessionThemeState({ status: 'idle', coworkerIds: ['c'] }, { c: { status: 'running' } })
    ).toBe('running');
  });

  it('没有会话是 idle', () => {
    expect(sessionThemeState(undefined, {})).toBe('idle');
  });
});

describe('appActivityState', () => {
  it('取所有主会话里优先级最高的', () => {
    expect(appActivityState({})).toBe('idle');
    expect(
      appActivityState({
        a: { status: 'running' },
        b: { status: 'idle', pendingAsks: [{}] },
        c: idle,
      })
    ).toBe('waiting');
  });

  it('子会话和 btw 不单独计入', () => {
    expect(
      appActivityState({
        a: idle,
        child: { status: 'failed', parentId: 'a' },
        side: { status: 'failed', btwParentId: 'a' },
      })
    ).toBe('idle');
  });
});

describe('conversationThemeState', () => {
  it('子会话在跑由调用方预先算好，取值与 sessionThemeState 同序', () => {
    expect(conversationThemeState(idle)).toBe('idle');
    expect(conversationThemeState({ status: 'idle', hasRunningChild: true })).toBe('running');
    expect(conversationThemeState({ status: 'idle', spawning: true })).toBe('running');
    expect(conversationThemeState({ status: 'running', pendingApprovals: [{}] })).toBe('waiting');
    expect(conversationThemeState({ status: 'failed', hasRunningChild: true })).toBe('error');
    expect(conversationThemeState({ status: 'idle', unread: true })).toBe('idle');
  });
});
