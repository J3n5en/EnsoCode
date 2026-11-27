import type { RendererAgentEvent } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { pluginAskEvent, SessionStateTracker, turnEndSessionId } from './sessionState';

const root = { sessionId: 'r', generation: 'g' };
const child = { sessionId: 'r::cw-1', generation: 'c', parent: root };
let seq = 0;
const ev = (event: Record<string, unknown>) =>
  ({ seq: ++seq, identity: root, ...event }) as unknown as RendererAgentEvent;

describe('pluginAskEvent', () => {
  const notBot = () => false;
  const ask = {
    requestId: 'q1',
    question: '部署吗？',
    options: ['是', '否'],
    recommended: '是',
    expiresAt: 99,
    relatesTo: { conversationId: 'x' },
  };

  it('主会话提问映射成 ask_request，relayed 按是否转给秘书', () => {
    expect(pluginAskEvent(ev({ type: 'ask-request', ask }), notBot)).toEqual({
      sessionId: 'r',
      event: 'ask_request',
      data: {
        sessionId: 'r',
        requestId: 'q1',
        question: '部署吗？',
        options: ['是', '否'],
        recommended: '是',
        expiresAt: 99,
        relayed: false,
      },
    });
    expect(
      pluginAskEvent(
        ev({ type: 'ask-request', ask: { requestId: 'q2', question: '?', relay: { name: '秘' } } }),
        notBot
      )?.data
    ).toEqual({ sessionId: 'r', requestId: 'q2', question: '?', relayed: true });
  });

  it('收尾映射成 ask_resolved，带 by 与 answer；取消时两者都没有', () => {
    expect(
      pluginAskEvent(
        ev({ type: 'ask-resolved', requestId: 'q1', by: 'relay', answer: '是', name: '秘' }),
        notBot
      )
    ).toEqual({
      sessionId: 'r',
      event: 'ask_resolved',
      data: { sessionId: 'r', requestId: 'q1', by: 'relay', answer: '是' },
    });
    expect(pluginAskEvent(ev({ type: 'ask-resolved', requestId: 'q1' }), notBot)?.data).toEqual({
      sessionId: 'r',
      requestId: 'q1',
    });
  });

  it('子会话、Bot 会话与其他事件不发', () => {
    expect(pluginAskEvent(ev({ type: 'ask-request', ask, identity: child }), notBot)).toBeNull();
    expect(pluginAskEvent(ev({ type: 'ask-request', ask }), (id) => id === 'r')).toBeNull();
    expect(pluginAskEvent(ev({ type: 'turn-completed', turnId: 't' }), notBot)).toBeNull();
  });
});

describe('SessionStateTracker', () => {
  it('回合结束：主会话完成、失败、中止各算一次；子会话与其他事件不算', () => {
    expect(turnEndSessionId(ev({ type: 'turn-completed', turnId: 't' }))).toBe('r');
    expect(turnEndSessionId(ev({ type: 'turn-failed', turnId: 't', error: 'x' }))).toBe('r');
    expect(turnEndSessionId(ev({ type: 'turn-completed', turnId: 't', aborted: true }))).toBe('r');
    expect(turnEndSessionId(ev({ type: 'turn-completed', identity: child }))).toBeNull();
    expect(turnEndSessionId(ev({ type: 'status', status: 'idle' }))).toBeNull();
    expect(turnEndSessionId({ type: 'worker-exited' } as RendererAgentEvent)).toBeNull();
  });

  it('按侧栏圆点优先级汇总：error > waiting > running > idle，状态或挂起数变化才报告', () => {
    const t = new SessionStateTracker();
    expect(t.status('r')).toEqual({
      sessionId: 'r',
      state: 'idle',
      pendingAsks: 0,
      pendingApprovals: 0,
    });
    expect(t.observe(ev({ type: 'status', status: 'running' }))).toEqual([
      { sessionId: 'r', state: 'running', previous: 'idle', pendingAsks: 0, pendingApprovals: 0 },
    ]);
    expect(t.observe(ev({ type: 'message-upsert', index: 0, message: {} }))).toEqual([]);
    expect(t.observe(ev({ type: 'ask-request', ask: { requestId: 'q', question: '?' } }))).toEqual([
      {
        sessionId: 'r',
        state: 'waiting',
        previous: 'running',
        pendingAsks: 1,
        pendingApprovals: 0,
      },
    ]);
    expect(t.observe(ev({ type: 'ask-resolved', requestId: 'q' }))[0]).toMatchObject({
      state: 'running',
      previous: 'waiting',
    });
    expect(t.observe(ev({ type: 'status', status: 'failed', error: 'x' }))[0]).toMatchObject({
      state: 'error',
    });
    expect(t.observe(ev({ type: 'status', status: 'failed', error: 'x' }))).toEqual([]);
    // 失败优先于挂起的提问；下一轮开始运行即清除
    expect(t.observe(ev({ type: 'ask-request', ask: { requestId: 'q2', question: '?' } }))).toEqual(
      [{ sessionId: 'r', state: 'error', previous: 'error', pendingAsks: 1, pendingApprovals: 0 }]
    );
    t.observe(ev({ type: 'ask-resolved', requestId: 'q2' }));
    expect(t.observe(ev({ type: 'status', status: 'running' }))[0]).toMatchObject({
      state: 'running',
      previous: 'error',
    });
    expect(t.observe(ev({ type: 'status', status: 'idle' }))[0]).toMatchObject({ state: 'idle' });
  });

  it('turn-failed 与 worker 退出记为 error，并清空挂起请求', () => {
    const t = new SessionStateTracker();
    t.observe(ev({ type: 'approval-request', request: { requestId: 'a' } }));
    expect(t.status('r')).toMatchObject({ state: 'waiting', pendingApprovals: 1 });
    expect(t.observe(ev({ type: 'turn-failed', turnId: 't', error: 'x' }))[0]).toMatchObject({
      state: 'error',
    });
    t.observe(ev({ type: 'parent-ready', sessionFile: '/x', model: {} }));
    expect(t.status('r').state).toBe('idle');
    t.observe(ev({ type: 'status', status: 'running' }));
    expect(t.observe({ type: 'worker-exited' })).toEqual([
      { sessionId: 'r', state: 'error', previous: 'running', pendingAsks: 0, pendingApprovals: 0 },
    ]);
  });

  it('子会话与子代理汇总进所属主会话；子会话失败不算主会话出错', () => {
    const t = new SessionStateTracker();
    const c = (event: Record<string, unknown>) => ev({ ...event, identity: child });
    expect(t.observe(c({ type: 'status', status: 'running' }))).toEqual([
      { sessionId: 'r', state: 'running', previous: 'idle', pendingAsks: 0, pendingApprovals: 0 },
    ]);
    expect(
      t.observe(c({ type: 'approval-request', request: { requestId: 'a' } }))[0]
    ).toMatchObject({ sessionId: 'r', state: 'waiting', pendingApprovals: 1 });
    t.observe(c({ type: 'approval-resolved', requestId: 'a' }));
    expect(t.observe(c({ type: 'status', status: 'failed' }))[0]).toMatchObject({ state: 'idle' });
    t.observe(c({ type: 'child-ended', reason: 'done' }));
    expect(t.status('r').state).toBe('idle');

    t.observe(ev({ type: 'subagent-update', agent: { id: 's1', status: 'running' } }));
    expect(t.status('r').state).toBe('running');
    t.observe(ev({ type: 'subagent-update', agent: { id: 's1', status: 'done' } }));
    expect(t.status('r').state).toBe('idle');
  });

  it('快照重建状态与挂起请求', () => {
    const t = new SessionStateTracker();
    t.observe(ev({ type: 'ask-request', ask: { requestId: 'old', question: '?' } }));
    const changes = t.observe({
      type: 'snapshot',
      sessions: [
        {
          identity: root,
          status: 'running',
          pendingApprovals: [{ requestId: 'a' }],
          pendingAsks: [],
        },
        { identity: { sessionId: 'o', generation: 'g' }, status: 'running' },
      ],
    } as unknown as RendererAgentEvent);
    expect(changes).toEqual([
      {
        sessionId: 'r',
        state: 'waiting',
        previous: 'waiting',
        pendingAsks: 0,
        pendingApprovals: 1,
      },
      { sessionId: 'o', state: 'running', previous: 'idle', pendingAsks: 0, pendingApprovals: 0 },
    ]);
  });

  it('worker 退出：重启后接着跑的主会话不改判失败，其余照旧记失败', () => {
    const t = new SessionStateTracker((sessionId) => sessionId === 'kept');
    for (const sessionId of ['kept', 'killed']) {
      t.observe(
        ev({ type: 'status', status: 'running', identity: { sessionId, generation: 'g' } })
      );
    }
    const changes = t.observe({ type: 'worker-exited' } as RendererAgentEvent);
    expect(changes.map((change) => [change.sessionId, change.state])).toEqual([
      ['killed', 'error'],
    ]);
    expect(t.status('kept').state).toBe('running');
  });

  it('ownStatus 只看主会话自身状态：子会话在跑时 status 为 running，但 ownStatus 为 idle', () => {
    const t = new SessionStateTracker();
    t.observe(ev({ type: 'status', status: 'idle' }));
    t.observe(ev({ type: 'status', status: 'running', identity: child }));
    expect(t.status('r').state).toBe('running');
    expect(t.ownStatus('r').state).toBe('idle');

    t.observe(ev({ type: 'status', status: 'running' }));
    expect(t.ownStatus('r').state).toBe('running');
  });
});
