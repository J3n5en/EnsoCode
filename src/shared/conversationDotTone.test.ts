import { describe, expect, it } from 'vitest';
import {
  conversationDotTone,
  conversationHasRunningChild,
  coworkerTabTone,
} from './conversationDotTone';

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

  it('会话投影缺失时没有活跃子任务', () => {
    expect(conversationHasRunningChild(undefined, { child: { status: 'running' } })).toBe(false);
  });

  it('coworker 自身 idle 但其 subagent 运行时父会话仍有活跃子任务', () => {
    expect(
      conversationHasRunningChild(parent, {
        child: { status: 'idle', subagents: [{ status: 'running' }] },
      })
    ).toBe(true);
  });

  it('嵌套 coworker 运行时父会话仍有活跃子任务', () => {
    expect(
      conversationHasRunningChild(parent, {
        child: { status: 'idle', coworkerIds: ['grand'] },
        grand: { status: 'running' },
      })
    ).toBe(true);
  });

  it('自身有 running 后台任务时有活跃子任务', () => {
    expect(
      conversationHasRunningChild({ status: 'idle', backgroundTasks: [{ status: 'running' }] }, {})
    ).toBe(true);
  });

  it('后台任务均已结束时没有活跃子任务', () => {
    expect(
      conversationHasRunningChild(
        { status: 'idle', backgroundTasks: [{ status: 'done' }, { status: 'failed' }] },
        {}
      )
    ).toBe(false);
  });

  it('子会话 idle 但其后台任务 running 时父会话仍有活跃子任务', () => {
    expect(
      conversationHasRunningChild(parent, {
        child: { status: 'idle', backgroundTasks: [{ status: 'running' }] },
      })
    ).toBe(true);
  });
});

describe('conversationDotTone', () => {
  it('ask 挂起时即使仍 running 也标 waiting（问号等待态）', () => {
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

describe('coworkerTabTone', () => {
  it('coworker 等待 ask_user 回答时是 waiting，而不是红色 attention', () => {
    expect(coworkerTabTone({ status: 'running', pendingAskCount: 1 })).toBe('waiting');
  });

  it('待审批仍按原语义显示 attention', () => {
    expect(coworkerTabTone({ status: 'running', pendingApprovalCount: 1 })).toBe('attention');
  });

  it('待能力确认仍按原语义显示 attention', () => {
    expect(coworkerTabTone({ status: 'running', pendingCapabilityAskCount: 1 })).toBe('attention');
  });

  it('审批与提问同时挂起时审批优先', () => {
    expect(
      coworkerTabTone({ status: 'running', pendingApprovalCount: 1, pendingAskCount: 1 })
    ).toBe('attention');
  });

  it('失败优先于 ask，与其它指示器一致', () => {
    expect(coworkerTabTone({ status: 'failed', pendingAskCount: 1 })).toBe('failed');
  });

  it('待审批时即使 failed 也保持 attention（原有审批语义不变）', () => {
    expect(coworkerTabTone({ status: 'failed', pendingApprovalCount: 1 })).toBe('attention');
  });

  it('spawning 无挂起项是 running', () => {
    expect(coworkerTabTone({ status: 'idle', spawning: true })).toBe('running');
  });

  it('ask 全部解除后回到 running', () => {
    expect(coworkerTabTone({ status: 'running', pendingAskCount: 0 })).toBe('running');
  });

  it('idle 无挂起项是 idle', () => {
    expect(coworkerTabTone({ status: 'idle' })).toBe('idle');
  });
});
