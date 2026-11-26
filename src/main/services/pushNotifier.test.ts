import { describe, expect, it } from 'vitest';
import { buildPushPayload } from './pushNotifier';

describe('buildPushPayload', () => {
  const identity = { sessionId: 's1', generation: 'g1' };

  it('审批/提问/回合结束与桌面共用文案：标题带会话名，pending 标记待处理项', () => {
    expect(
      buildPushPayload(
        { type: 'approval-request', identity, request: { tool: 'bash', summary: 'ls' } },
        '修复登录'
      )
    ).toEqual({
      title: '修复登录 · 需要审批',
      body: 'bash · ls',
      sessionId: 's1',
      pending: true,
    });
    expect(
      buildPushPayload({ type: 'ask-request', identity, ask: { question: '用哪个？' } }, '修复登录')
        ?.title
    ).toBe('修复登录 · 等你回答');
    expect(buildPushPayload({ type: 'turn-completed', identity }, '修复登录')?.title).toBe(
      '修复登录 · 回复完成'
    );
    expect(
      buildPushPayload({ type: 'turn-failed', identity, error: 'boom' }, '修复登录')?.title
    ).toBe('修复登录 · 会话失败');
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

  it('旧格式扁平 sessionId 兜底；无标题时标题只有类型后缀', () => {
    expect(buildPushPayload({ type: 'turn-completed', sessionId: 's2' }, undefined)).toEqual({
      title: '回复完成',
      body: 'agent 已完成,等你查看。',
      sessionId: 's2',
      pending: false,
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
    expect(buildPushPayload(waiting, '修复登录')?.title).toBe('修复登录 · 需要审批');
  });

  it('默认静音 coworker 完成/失败，提问仍推送', () => {
    const coworker = { sessionId: 's1::cw-bob', generation: 'g1' };
    expect(buildPushPayload({ type: 'turn-completed', identity: coworker }, '修复登录')).toBeNull();
    expect(buildPushPayload({ type: 'turn-failed', identity: coworker }, '修复登录')).toBeNull();
    expect(buildPushPayload({ type: 'ask-request', identity: coworker }, '修复登录')?.title).toBe(
      '修复登录 · 等你回答'
    );
  });

  it('关闭「仅主 agent」后 coworker 完成会推送', () => {
    const coworker = { sessionId: 's1::cw-bob', generation: 'g1' };
    expect(
      buildPushPayload({ type: 'turn-completed', identity: coworker }, '修复登录', false)
    ).toEqual({
      title: '修复登录 · 回复完成',
      body: 'agent 已完成,等你查看。',
      sessionId: 's1::cw-bob',
      pending: false,
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
    ).toBe('修复登录 · 等你回答');
  });

  it('转给秘书的提问不推送，普通提问与审批照推', () => {
    const relayed = {
      type: 'ask-request',
      identity,
      ask: { question: '用哪个？', relay: { name: '小秘' } },
    };
    expect(buildPushPayload(relayed, '修复登录')).toBeNull();
    expect(
      buildPushPayload({ type: 'ask-request', identity, ask: { question: '用哪个？' } }, 't')
    ).toEqual({
      title: 't · 等你回答',
      body: '用哪个？',
      sessionId: identity.sessionId,
      pending: true,
    });
    expect(
      buildPushPayload(
        { type: 'approval-request', identity, request: { tool: 'bash', summary: 'ls' } },
        't'
      )?.title
    ).toBe('t · 需要审批');
  });

  it('回合完成正文带 assistant 摘要（digest），无摘要回退固定文案', () => {
    const withDigest = buildPushPayload(
      {
        type: 'turn-completed',
        identity,
        digest: { firstUserText: '', userText: '', assistantText: '已修复登录态刷新问题' },
      },
      '修复登录'
    );
    expect(withDigest?.body).toBe('已修复登录态刷新问题');
    const empty = buildPushPayload(
      {
        type: 'turn-completed',
        identity,
        digest: { firstUserText: '', userText: '', assistantText: '' },
      },
      '修复登录'
    );
    expect(empty?.body).toBe('agent 已完成,等你查看。');
  });

  it('silent 或纯系统注入的回合不推送（与桌面一致）', () => {
    expect(
      buildPushPayload({ type: 'turn-completed', identity, silent: true }, '修复登录')
    ).toBeNull();
    expect(
      buildPushPayload(
        {
          type: 'turn-completed',
          identity,
          digest: {
            firstUserText: '',
            userText: '<session-updates>x</session-updates>',
            assistantText: '<secretary-silent/>',
          },
        },
        '修复登录'
      )
    ).toBeNull();
  });

  it('失败正文用错误原文', () => {
    expect(
      buildPushPayload({ type: 'turn-failed', identity, error: 'provider 503 限流' }, '修复登录')
        ?.body
    ).toBe('provider 503 限流');
  });
});
