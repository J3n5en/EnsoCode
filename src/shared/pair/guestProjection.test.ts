import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  applyGuestEvent,
  applyGuestHistory,
  applyGuestSnapshot,
  emptyGuestView,
  type GuestSessionView,
  markAllFailed,
} from './guestProjection';

/**
 * 行为基准 = packages/phone/src/client.ts 的 applyAgentEvent（抽取前）。
 * 这些用例固定手机端现有语义，抽取后桌面与手机共用。
 */

const msg = (text: string): ProjectedMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }) as ProjectedMessage;

const viewWith = (entries: [number, string][], over: Partial<GuestSessionView> = {}) => ({
  ...emptyGuestView(),
  messages: new Map(entries.map(([i, t]) => [i, msg(t)])),
  ...over,
});

describe('applyGuestEvent（单条事件）', () => {
  it('message-upsert 按 index 幂等写入，并返回 lastIndex 供调用方存游标', () => {
    const r = applyGuestEvent(emptyGuestView(), {
      type: 'message-upsert',
      index: 3,
      message: msg('a'),
    });
    expect(r.view.messages.get(3)).toEqual(msg('a'));
    expect(r.lastIndex).toBe(3);
    const r2 = applyGuestEvent(r.view, { type: 'message-upsert', index: 3, message: msg('b') });
    expect(r2.view.messages.size).toBe(1);
    expect(r2.view.messages.get(3)).toEqual(msg('b'));
  });

  it('重写更早的消息不回退游标：lastIndex 是视图内最大 index', () => {
    const r = applyGuestEvent(
      viewWith([
        [0, 'a'],
        [5, 'b'],
      ]),
      {
        type: 'message-upsert',
        index: 0,
        message: msg('a2'),
      }
    );
    expect(r.lastIndex).toBe(5);
  });

  it('messages-truncated 裁掉 index >= length 的消息，并回退游标到 length-1', () => {
    const r = applyGuestEvent(
      viewWith([
        [0, 'a'],
        [1, 'b'],
        [2, 'c'],
      ]),
      {
        type: 'messages-truncated',
        length: 2,
      }
    );
    expect([...r.view.messages.keys()]).toEqual([0, 1]);
    expect(r.lastIndex).toBe(1);
    const empty = applyGuestEvent(viewWith([[0, 'a']]), { type: 'messages-truncated', length: 0 });
    expect(empty.view.messages.size).toBe(0);
    expect(empty.lastIndex).toBe(-1);
  });

  it('status / turn-completed / turn-failed 流转，且清除 retry', () => {
    const base = {
      ...emptyGuestView(),
      retry: { attempt: 1, maxAttempts: 3, delayMs: 1, error: 'x', at: 0 },
    };
    expect(applyGuestEvent(base, { type: 'status', status: 'running' }).view.status).toBe(
      'running'
    );
    expect(applyGuestEvent(base, { type: 'status', status: 'running' }).view.retry).toBeUndefined();
    expect(applyGuestEvent(base, { type: 'turn-completed' }).view.status).toBe('idle');
    expect(applyGuestEvent(base, { type: 'turn-failed' }).view.status).toBe('failed');
  });

  it('turn-retry 设置 retry 横幅（now 可注入）', () => {
    const r = applyGuestEvent(
      emptyGuestView(),
      { type: 'turn-retry', attempt: 2, maxAttempts: 5, delayMs: 800, error: 'rate limited' },
      { now: 42 }
    );
    expect(r.view.retry).toEqual({
      attempt: 2,
      maxAttempts: 5,
      delayMs: 800,
      error: 'rate limited',
      at: 42,
    });
  });

  it('approval-request 兼容嵌套 request 与平铺两种形状；approval-resolved 按 requestId 删除', () => {
    const nested = applyGuestEvent(emptyGuestView(), {
      type: 'approval-request',
      request: { requestId: 'r1', toolName: 'bash' },
    });
    expect(nested.view.approvals.map((a) => a.requestId)).toEqual(['r1']);
    const flat = applyGuestEvent(nested.view, {
      type: 'approval-request',
      requestId: 'r2',
      toolName: 'edit',
    });
    expect(flat.view.approvals.map((a) => a.requestId)).toEqual(['r1', 'r2']);
    const resolved = applyGuestEvent(flat.view, { type: 'approval-resolved', requestId: 'r1' });
    expect(resolved.view.approvals.map((a) => a.requestId)).toEqual(['r2']);
  });

  it('ask-request 兼容嵌套 ask 与平铺；ask-resolved 删除', () => {
    const a = applyGuestEvent(emptyGuestView(), {
      type: 'ask-request',
      ask: { requestId: 'q1', question: '?' },
    });
    const b = applyGuestEvent(a.view, { type: 'ask-request', requestId: 'q2', question: '??' });
    expect(b.view.asks.map((x) => x.requestId)).toEqual(['q1', 'q2']);
    expect(
      applyGuestEvent(b.view, { type: 'ask-resolved', requestId: 'q2' }).view.asks.map(
        (x) => x.requestId
      )
    ).toEqual(['q1']);
  });

  it('task-started / subagent-update 走任务投影，不动消息', () => {
    const base = viewWith([[0, 'hi']]);
    const r = applyGuestEvent(base, {
      type: 'task-started',
      task: { taskId: 't1', command: 'pnpm test', status: 'running', tail: '', startedAt: 1 },
    });
    expect(r.view.tasks).toHaveLength(1);
    expect(r.view.messages.size).toBe(1);
    const s = applyGuestEvent(r.view, {
      type: 'subagent-update',
      agent: {
        id: 'a1',
        description: 'd',
        status: 'running',
        steps: 0,
        currentActivity: '',
        startedAt: 1,
      },
    });
    expect(s.view.subagents).toHaveLength(1);
  });

  it('未知事件类型不改变视图（返回等价副本）', () => {
    const base = viewWith([[0, 'hi']], { status: 'running' });
    const r = applyGuestEvent(base, { type: 'something-else' });
    expect(r.view.status).toBe('running');
    expect(r.view.messages.get(0)).toEqual(msg('hi'));
    expect(r.lastIndex).toBeUndefined();
  });

  it('返回的 messages 是新 Map（不与入参共享引用）', () => {
    const base = viewWith([[0, 'hi']]);
    const r = applyGuestEvent(base, { type: 'message-upsert', index: 1, message: msg('x') });
    expect(r.view.messages).not.toBe(base.messages);
    expect(base.messages.size).toBe(1);
  });
});

describe('applyGuestSnapshot（尾窗快照）', () => {
  const snap = (id: string, base: number, texts: string[], over: Record<string, unknown> = {}) => ({
    sessionId: id,
    baseIndex: base,
    messages: texts.map(msg),
    status: 'idle',
    pendingApprovals: [],
    pendingAsks: [],
    backgroundTasks: [],
    subagents: [],
    ...over,
  });

  it('首次快照建视图；返回每会话 lastIndex', () => {
    const out = applyGuestSnapshot(new Map(), { sessions: [snap('s1', 5, ['a', 'b'])] });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('s1');
    expect([...out[0].view.messages.keys()]).toEqual([5, 6]);
    expect(out[0].lastIndex).toBe(6);
  });

  it('尾窗与已有内容接得上（base <= prevMax+1）→ 合并保留上滑加载的早段', () => {
    const existing = new Map([
      [
        's1',
        viewWith([
          [0, 'old0'],
          [1, 'old1'],
        ]),
      ],
    ]);
    const out = applyGuestSnapshot(existing, { sessions: [snap('s1', 2, ['n2', 'n3'])] });
    expect([...out[0].view.messages.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('尾窗接不上（离线太久）→ 丢弃旧段保持连续', () => {
    const existing = new Map([
      [
        's1',
        viewWith([
          [0, 'old0'],
          [1, 'old1'],
        ]),
      ],
    ]);
    const out = applyGuestSnapshot(existing, { sessions: [snap('s1', 10, ['n10'])] });
    expect([...out[0].view.messages.keys()]).toEqual([10]);
  });

  it('快照字段缺省时用空值；identity 形状（无扁平 sessionId）也能识别；无 id 的跳过', () => {
    const out = applyGuestSnapshot(new Map(), {
      sessions: [
        { identity: { sessionId: 's2' }, messages: [msg('x')] },
        { messages: [msg('orphan')] },
      ],
    });
    expect(out.map((o) => o.id)).toEqual(['s2']);
    expect(out[0].view.status).toBe('idle');
    expect(out[0].view.approvals).toEqual([]);
    expect(out[0].view.tasks).toEqual([]);
  });

  it('快照的 pendingApprovals / pendingAsks / backgroundTasks / subagents 直接成为视图状态', () => {
    const out = applyGuestSnapshot(new Map(), {
      sessions: [
        snap('s1', 0, [], {
          status: 'running',
          pendingApprovals: [{ requestId: 'r1' }],
          pendingAsks: [{ requestId: 'q1' }],
          backgroundTasks: [{ taskId: 't1' }],
          subagents: [{ id: 'a1' }],
        }),
      ],
    });
    const v = out[0].view;
    expect(v.status).toBe('running');
    expect(v.approvals).toHaveLength(1);
    expect(v.asks).toHaveLength(1);
    expect(v.tasks).toHaveLength(1);
    expect(v.subagents).toHaveLength(1);
  });

  it('尾窗是时间线的权威尾部：已有的更靠后消息（离线期间被截断）要丢掉，游标退回尾窗末', () => {
    const existing = new Map([
      [
        's1',
        viewWith([
          [0, 'a'],
          [1, 'b'],
          [2, 'c'],
          [3, 'd'],
        ]),
      ],
    ]);
    const out = applyGuestSnapshot(existing, { sessions: [snap('s1', 1, ['b2'])] });
    expect([...out[0].view.messages.keys()].sort((a, b) => a - b)).toEqual([0, 1]);
    expect(out[0].lastIndex).toBe(1);
  });

  it('空消息快照：清空已有消息，游标退到 -1（不能留 undefined，否则旧游标永不回退）', () => {
    const existing = new Map([['s1', viewWith([[0, 'a']])]]);
    const out = applyGuestSnapshot(existing, { sessions: [snap('s1', 0, [])] });
    expect(out[0].view.messages.size).toBe(0);
    expect(out[0].lastIndex).toBe(-1);
  });
});

describe('applyGuestHistory（上滑分页应答）', () => {
  it('按 baseIndex 并入更早消息，不动 status/审批', () => {
    const base = viewWith([[10, 'n10']], { status: 'running' });
    const next = applyGuestHistory(base, { baseIndex: 8, messages: [msg('h8'), msg('h9')] });
    expect([...next.messages.keys()].sort((a, b) => a - b)).toEqual([8, 9, 10]);
    expect(next.status).toBe('running');
  });

  it('空页返回原视图', () => {
    const base = viewWith([[10, 'n10']]);
    expect(applyGuestHistory(base, { baseIndex: 0, messages: [] })).toBe(base);
  });
});

describe('markAllFailed（worker-exited）', () => {
  it('所有会话 status 置 failed，消息保留', () => {
    const sessions = new Map([
      ['s1', viewWith([[0, 'a']], { status: 'running' })],
      ['s2', viewWith([[0, 'b']], { status: 'idle' })],
    ]);
    const out = markAllFailed(sessions);
    expect([...out.values()].every((v) => v.status === 'failed')).toBe(true);
    expect(out.get('s1')?.messages.get(0)).toEqual(msg('a'));
  });
});
