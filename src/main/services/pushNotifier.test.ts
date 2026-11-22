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
    expect(buildPushPayload({ type: 'ask-request', identity }, '修复登录')?.body).toBe('修复登录');
    expect(buildPushPayload({ type: 'turn-completed', identity }, '修复登录')?.title).toBe(
      '回合已完成'
    );
    expect(buildPushPayload({ type: 'turn-failed', identity }, '修复登录')?.title).toBe('回合失败');
  });

  it('正文带上要处理的内容：审批命令、提问原文，超长截断', () => {
    expect(
      buildPushPayload(
        { type: 'approval-request', identity, request: { summary: 'rm -rf dist' } },
        '修复登录'
      )?.body
    ).toBe('rm -rf dist');
    expect(
      buildPushPayload(
        { type: 'ask-request', identity, ask: { question: '用哪个端口' } },
        '修复登录'
      )?.body
    ).toBe('用哪个端口');
    const long = buildPushPayload(
      { type: 'ask-request', identity, ask: { question: `为什么${'长'.repeat(200)}` } },
      '修复登录'
    );
    expect(long?.body).toHaveLength(100);
    expect(long?.body.startsWith('为什么')).toBe(true);
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

  it('代审中（phase: reviewing）的审批不推送——代审模型可能放行', () => {
    const reviewing = {
      type: 'approval-request',
      identity,
      request: {
        requestId: 'apr-1',
        tool: 'bash',
        kind: 'command' as const,
        summary: 'ls',
        phase: 'reviewing' as const,
      },
    };
    expect(buildPushPayload(reviewing, '修复登录')).toBeNull();
    // 评审升级/直接进入真人阶段（无 phase）仍推送
    const waiting = {
      type: 'approval-request',
      identity,
      request: { requestId: 'apr-2', tool: 'bash', kind: 'command' as const, summary: 'ls' },
    };
    expect(buildPushPayload(waiting, '修复登录')?.title).toBe('需要审批');
  });

  it('默认静音 coworker 完成/失败，提问仍推送', () => {
    const coworker = { sessionId: 's1::cw-bob', generation: 'g1' };
    expect(buildPushPayload({ type: 'turn-completed', identity: coworker }, '修复登录')).toBeNull();
    expect(buildPushPayload({ type: 'turn-failed', identity: coworker }, '修复登录')).toBeNull();
    expect(buildPushPayload({ type: 'ask-request', identity: coworker }, '修复登录')?.title).toBe(
      '等待你的回答'
    );
  });

  it('关闭「仅主 agent」后 coworker 完成会推送', () => {
    const coworker = { sessionId: 's1::cw-bob', generation: 'g1' };
    expect(
      buildPushPayload({ type: 'turn-completed', identity: coworker }, '修复登录', false)
    ).toEqual({
      title: '回合已完成',
      body: '修复登录',
      sessionId: 's1::cw-bob',
    });
  });

  it('静音会话不推送，取消静音后提问和完成都恢复', () => {
    expect(buildPushPayload({ type: 'ask-request', identity }, '修复登录', true, true)).toBeNull();
    expect(
      buildPushPayload({ type: 'turn-completed', identity }, '修复登录', true, true)
    ).toBeNull();
    expect(buildPushPayload({ type: 'turn-failed', identity }, '修复登录', true, true)).toBeNull();
    expect(
      buildPushPayload({ type: 'ask-request', identity }, '修复登录', true, false)?.title
    ).toBe('等待你的回答');
  });
});
