import { describe, expect, it } from 'vitest';
import { buildPushPayload } from './pushNotifier';

describe('buildPushPayload', () => {
  const identity = { sessionId: 's1', generation: 'g1' };

  it('审批/提问/回合结束映射为通用文案（不带消息内容）', () => {
    expect(buildPushPayload({ type: 'approval-request', identity }, '修复登录')).toEqual({
      title: '需要审批',
      body: '修复登录',
      sessionId: 's1',
    });
    expect(buildPushPayload({ type: 'ask-request', identity }, '修复登录')?.title).toBe(
      '等待你的回答'
    );
    expect(buildPushPayload({ type: 'turn-completed', identity }, '修复登录')?.title).toBe(
      '回合已完成'
    );
    expect(buildPushPayload({ type: 'turn-failed', identity }, '修复登录')?.title).toBe('回合失败');
  });

  it('无关事件与缺 sessionId 的事件返回 null', () => {
    expect(buildPushPayload({ type: 'message-upsert', identity }, 't')).toBeNull();
    expect(buildPushPayload({ type: 'turn-completed' }, 't')).toBeNull();
  });

  it('旧格式扁平 sessionId 兜底；无标题用默认文案', () => {
    expect(buildPushPayload({ type: 'turn-completed', sessionId: 's2' }, undefined)).toEqual({
      title: '回合已完成',
      body: '会话',
      sessionId: 's2',
    });
  });
});
