import type { RendererAgentEvent, SessionSnapshot } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  applyAgentEvent,
  applyDispatchEvent,
  applyHistoryPage,
  emptyProjection,
  type SessionProjection,
  truncatedNeedsSnapshotResync,
  upsertOutOfRange,
} from './reducer';
import { shouldAbortStalledGeneration } from './stallTimeout';

const identity = (generation = 'g1') => ({ sessionId: 's1', generation });
const base: SessionProjection = { ...emptyProjection };
type TailProjection = SessionProjection & { historyBaseIndex?: number };
const assistant = (text: string): SessionProjection['messages'][number] => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});
const tail = (messages: SessionProjection['messages'] = []): TailProjection => ({
  ...base,
  messages,
  historyBaseIndex: 40,
});
const snapshot = (baseIndex?: number): SessionSnapshot => ({
  identity: identity(),
  status: 'idle',
  messages: [],
  commands: [],
  ...(baseIndex === undefined ? {} : { baseIndex }),
});
const status = (
  seq: number,
  value: 'idle' | 'running' | 'failed',
  generation = 'g1'
): RendererAgentEvent => ({
  type: 'status',
  identity: identity(generation),
  seq,
  status: value,
});

describe('applyHistoryPage', () => {
  it('空页不改变投影对象', () => {
    const state = tail([assistant('m40')]);
    expect(applyHistoryPage(state, { baseIndex: 40, messages: [] })).toBe(state);
  });
  it('未与当前历史起点相接时不改变投影对象', () => {
    const state = tail([assistant('m40')]);
    expect(applyHistoryPage(state, { baseIndex: 20, messages: [assistant('m20')] })).toBe(state);
  });
  it('相接页前置到权威区且保留状态、审批和乐观尾巴', () => {
    const approval = {
      requestId: 'a1',
      tool: 'write',
      kind: 'file-write' as const,
      summary: '/tmp/x',
      toolCallId: 't1',
      phase: 'reviewing' as const,
    };
    const optimistic = { ...assistant('pending'), optimistic: true as const };
    const state = {
      ...tail([assistant('m40'), optimistic]),
      status: 'running' as const,
      pendingApprovals: [approval],
    };
    const next = applyHistoryPage(state, { baseIndex: 39, messages: [assistant('m39')] });
    expect(next.messages).toEqual([assistant('m39'), assistant('m40'), optimistic]);
    expect(next.historyBaseIndex).toBe(39);
    expect(next.status).toBe('running');
    expect(next.pendingApprovals).toBe(state.pendingApprovals);
  });
});

describe('applyAgentEvent', () => {
  it('drops low seq and events for another session', () => {
    const advanced = applyAgentEvent(base, 's1', status(5, 'running'));
    expect(applyAgentEvent(advanced, 's1', status(3, 'idle'))).toBe(advanced);
    expect(
      applyAgentEvent(advanced, 's1', {
        type: 'status',
        identity: { sessionId: 's2', generation: 'g1' },
        seq: 6,
        status: 'idle',
      })
    ).toBe(advanced);
  });

  it('parent-rejected at seq 0 lands failed with reason even when lastSeq is 0', () => {
    // 回归锈定：拒绝事件恒以 seq:0 发出（worker 侧被拒时尚未建会话），
    // 若被 event.seq <= lastSeq 单调门吞掉，spawn 失败在 UI 上完全无声。
    const next = applyAgentEvent(base, 's1', {
      type: 'parent-rejected',
      identity: identity(),
      seq: 0,
      reason: 'no api key',
    });
    expect(next.status).toBe('failed');
    expect(next.error).toBe('no api key');
    // generation 重置为 undefined：重试 spawn 的新代事件才能被干净领养，
    // 否则钉在被拒代上会把重试的全部合法事件永久吞掉。
    expect(next.generation).toBeUndefined();
  });

  it('child-rejected at seq 0 lands failed with reason', () => {
    const next = applyAgentEvent(base, 's1', {
      type: 'child-rejected',
      identity: {
        sessionId: 's1',
        generation: 'g1',
        parent: { sessionId: 'p1', generation: 'pg1' },
        instanceId: 'i1',
        instanceName: 'Scout · a1',
        typeKey: 'builtin:scout',
      },
      seq: 0,
      reason: 'spawn denied',
    });
    expect(next.status).toBe('failed');
    expect(next.error).toBe('spawn denied');
    expect(next.generation).toBeUndefined();
  });

  it('child-ended marks the persisted ended flag so restart-side restore skips it', () => {
    // R6：「已结束」必须落盘，否则重启后 Main 级联恢复无法区分
    // 「跑完的一次性派发 child」与「关机时还活着的 coworker」。
    const next = applyAgentEvent(base, 's1', {
      type: 'child-ended',
      identity: {
        sessionId: 's1',
        generation: 'g1',
        parent: { sessionId: 'p1', generation: 'pg1' },
        instanceId: 'i1',
        instanceName: 'Scout · a1',
        typeKey: 'builtin:scout',
      },
      seq: 1,
      reason: 'turn terminal',
    });
    expect(next.ended).toBe(true);
    expect(next.status).toBe('idle');
  });

  it('child-rejected also marks ended (terminal for that generation)', () => {
    const next = applyAgentEvent(base, 's1', {
      type: 'child-rejected',
      identity: {
        sessionId: 's1',
        generation: 'g1',
        parent: { sessionId: 'p1', generation: 'pg1' },
        instanceId: 'i1',
        instanceName: 'Scout · a1',
        typeKey: 'builtin:scout',
      },
      seq: 0,
      reason: 'spawn denied',
    });
    expect(next.ended).toBe(true);
  });

  it('parent-ended / worker-exited reset the seq guard: a revived session restarts at seq 1', () => {
    // worker 每次重建会话 seq 从 0 起；驱逐后 resume 若仍持旧 lastSeq，新会话的所有事件都会被丢
    const advanced = applyAgentEvent(base, 's1', status(50, 'running'));
    const ended = applyAgentEvent(advanced, 's1', {
      type: 'parent-ended',
      identity: identity(),
      seq: 51,
      reason: 'evicted',
    });
    const revived = applyAgentEvent(ended, 's1', status(1, 'running'));
    expect(revived.status).toBe('running');
    expect(revived.lastSeq).toBe(1);

    const exited = applyAgentEvent(advanced, 's1', { type: 'worker-exited' });
    const restarted = applyAgentEvent(exited, 's1', status(1, 'running'));
    expect(restarted.status).toBe('running');
  });

  it('parent-rejected resets the seq guard so a same-generation retry starting at seq 1 is accepted', () => {
    const advanced = applyAgentEvent(base, 's1', status(50, 'running'));
    const rejected = applyAgentEvent(advanced, 's1', {
      type: 'parent-rejected',
      identity: identity(),
      seq: 0,
      reason: 'gone',
    });
    expect(rejected.status).toBe('failed');
    const revived = applyAgentEvent(rejected, 's1', status(1, 'running'));
    expect(revived.status).toBe('running');
  });

  it('turn-failed with undelivered drops the unconfirmed optimistic tail', () => {
    const withOptimistic: SessionProjection = {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }], timestamp: 1 },
        {
          role: 'user',
          content: [{ type: 'text', text: 'never sent' }],
          timestamp: 2,
          optimistic: true,
        },
      ],
    };
    const next = applyAgentEvent(withOptimistic, 's1', {
      type: 'turn-failed',
      identity: identity(),
      seq: 1,
      turnId: 't',
      error: 'stuck',
      undelivered: true,
    });
    expect(next.status).toBe('failed');
    expect(next.messages).toHaveLength(1);
    // 并发两条未确认：worker 按序失败，先收回最早一条（A）而非尾部（B）
    const twoPending: SessionProjection = {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'A' }], timestamp: 1, optimistic: true },
        { role: 'user', content: [{ type: 'text', text: 'B' }], timestamp: 2, optimistic: true },
      ],
    };
    const afterFirst = applyAgentEvent(twoPending, 's1', {
      type: 'turn-failed',
      identity: identity(),
      seq: 1,
      turnId: 't',
      error: 'stuck',
      undelivered: true,
    });
    expect(afterFirst.messages.map((m) => (m.content[0] as { text: string }).text)).toEqual(['B']);
    // 普通 turn-failed（消息已送达）不动时间线
    const plain = applyAgentEvent(withOptimistic, 's1', {
      type: 'turn-failed',
      identity: identity(),
      seq: 1,
      turnId: 't',
      error: 'boom',
    });
    expect(plain.messages).toHaveLength(2);
  });

  it('parent-ended does not mark ended (flag is child-only)', () => {
    const next = applyAgentEvent(base, 's1', {
      type: 'parent-ended',
      identity: identity(),
      seq: 1,
      reason: 'closed',
    });
    expect(next.ended).toBeUndefined();
  });

  it('child-ready on a new generation clears ended (successful resume revives)', () => {
    const endedState: SessionProjection = { ...emptyProjection, ended: true };
    const next = applyAgentEvent(endedState, 's1', {
      type: 'child-ready',
      identity: {
        sessionId: 's1',
        generation: 'g2',
        parent: { sessionId: 'p1', generation: 'pg2' },
        instanceId: 'i1',
        instanceName: 'Scout · a1',
        typeKey: 'builtin:scout',
      },
      seq: 1,
      sessionFile: '/tmp/child.jsonl',
    });
    expect(next.ended).toBeUndefined();
  });

  it('retry after rejection: new-generation parent-ready still applies', () => {
    const rejected = applyAgentEvent(base, 's1', {
      type: 'parent-rejected',
      identity: identity('g1'),
      seq: 0,
      reason: 'no api key',
    });
    const retried = applyAgentEvent(rejected, 's1', {
      type: 'parent-ready',
      identity: identity('g2'),
      seq: 1,
      sessionFile: '/tmp/s1.jsonl',
      model: { providerId: 'p', modelId: 'm' },
    });
    expect(retried.status).toBe('idle');
    expect(retried.error).toBeUndefined();
    expect(retried.generation).toBe('g2');
  });

  it('stale old-generation rejection does not clobber a live newer generation', () => {
    const live = applyAgentEvent(base, 's1', status(3, 'running', 'g2'));
    const next = applyAgentEvent(live, 's1', {
      type: 'parent-rejected',
      identity: identity('g1'),
      seq: 0,
      reason: 'late rejection',
    });
    expect(next).toBe(live);
  });

  it('same-generation rejection after events applies (second spawn failure)', () => {
    const live = applyAgentEvent(base, 's1', status(3, 'running', 'g1'));
    const next = applyAgentEvent(live, 's1', {
      type: 'parent-rejected',
      identity: identity('g1'),
      seq: 0,
      reason: 'worker refused',
    });
    expect(next.status).toBe('failed');
    expect(next.error).toBe('worker refused');
    expect(next.generation).toBeUndefined();
  });

  it('message-upsert writes by index without duplicating the message', () => {
    const first = applyAgentEvent(base, 's1', {
      type: 'message-upsert',
      identity: identity(),
      seq: 1,
      index: 0,
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    });
    const updated = applyAgentEvent(first, 's1', {
      type: 'message-upsert',
      identity: identity(),
      seq: 2,
      index: 0,
      message: { role: 'user', content: [{ type: 'text', text: 'hi!' }] },
    });
    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0].content).toEqual([{ type: 'text', text: 'hi!' }]);
  });

  it('message-upsert maps an absolute worker index into the tail window', () => {
    const next = applyAgentEvent(tail([assistant('old')]), 's1', {
      type: 'message-upsert',
      identity: identity(),
      seq: 1,
      index: 40,
      message: assistant('updated'),
    });
    expect(next.messages[0]).toEqual(assistant('updated'));
  });

  it('message-upsert appends at the absolute tail-window end', () => {
    const next = applyAgentEvent(tail([assistant('m40')]), 's1', {
      type: 'message-upsert',
      identity: identity(),
      seq: 1,
      index: 41,
      message: assistant('m41'),
    });
    expect(next.messages).toEqual([assistant('m40'), assistant('m41')]);
  });

  it('message-upsert before the tail base drops the body but advances seq', () => {
    expect(upsertOutOfRange([], 39, 40)).toBe(true);
    expect(upsertOutOfRange([], 40, 40)).toBe(false);
    const next = applyAgentEvent(tail(), 's1', {
      type: 'message-upsert',
      identity: identity(),
      seq: 7,
      index: 39,
      message: assistant('old'),
    });
    expect(next.messages).toEqual([]);
    expect(next.lastSeq).toBe(7);
  });

  it('message-upsert beyond the known tail never leaves holes (cold-evicted body awaiting snapshot)', () => {
    // 复现：冷会话正文被清空后重新查看，snapshot 回来前流式 upsert 以原 index 到达，
    // 直接按 index 写会产生稀疏空洞 → 后续 .optimistic / .role 读 undefined 崩溃
    const next = applyAgentEvent(base, 's1', {
      type: 'message-upsert',
      identity: identity(),
      seq: 7,
      index: 5,
      message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] },
    });
    expect(next.messages.every((message) => message !== undefined)).toBe(true);
    expect(next.messages).toHaveLength(0);
    expect(next.lastSeq).toBe(7);
  });

  it('upsert beyond the tail with only an optimistic echo drops body but flags upsertOutOfRange', () => {
    // 复现：冷会话正文被清空后用户先发了一句（乐观回显 length=1），worker 推来的
    // assistant upsert 带原 index（一百多）→ 对不上整段丢弃，界面只剩那一句 + 计时器
    const withEcho: SessionProjection = {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '怎么又卡住了' }], optimistic: true },
      ],
    };
    expect(upsertOutOfRange(withEcho.messages, 123)).toBe(true);
    expect(upsertOutOfRange(withEcho.messages, 0)).toBe(false);
    const next = applyAgentEvent(withEcho, 's1', {
      type: 'message-upsert',
      identity: identity(),
      seq: 9,
      index: 123,
      message: { role: 'assistant', content: [{ type: 'text', text: 'running bash' }] },
    });
    expect(next.messages).toEqual(withEcho.messages);
    expect(next.lastSeq).toBe(9);
  });

  it('tail snapshot records its absolute base and keeps the optimistic tail', () => {
    const optimistic = {
      ...assistant('in flight'),
      role: 'user' as const,
      optimistic: true as const,
    };
    const next = applyAgentEvent({ ...base, messages: [optimistic] }, 's1', {
      type: 'snapshot',
      sessions: [snapshot(40)],
    }) as TailProjection;
    expect(next.messages).toEqual([optimistic]);
    expect(next.historyBaseIndex).toBe(40);
  });

  it('尾窗 snapshot 保留已加载的更早前缀并从自身起点替换', () => {
    const history = Array.from({ length: 40 }, (_, i) => assistant(`m${i + 20}`));
    const next = applyAgentEvent({ ...tail(history), historyBaseIndex: 20 }, 's1', {
      type: 'snapshot',
      sessions: [{ ...snapshot(40), messages: [assistant('new40'), assistant('new41')] }],
    });
    expect(next.messages.slice(0, 20)).toEqual(history.slice(0, 20));
    expect(next.messages.slice(20)).toEqual([assistant('new40'), assistant('new41')]);
    expect(next.historyBaseIndex).toBe(20);
  });

  it('full snapshot clears an earlier tail base when baseIndex is missing or zero', () => {
    const tailed = applyAgentEvent(base, 's1', { type: 'snapshot', sessions: [snapshot(40)] });
    expect((tailed as TailProjection).historyBaseIndex).toBe(40);
    const missing = applyAgentEvent(tailed, 's1', {
      type: 'snapshot',
      sessions: [{ ...snapshot(), messages: [assistant('full')] }],
    });
    const zero = applyAgentEvent(tailed, 's1', { type: 'snapshot', sessions: [snapshot(0)] });
    expect(missing.messages).toEqual([assistant('full')]);
    expect((missing as TailProjection).historyBaseIndex).toBeUndefined();
    expect((zero as TailProjection).historyBaseIndex).toBeUndefined();
    // patch 是浅合并：缺 key 会把尾巴 base 留下，全量 800 条后 upsert 写到本地 60。
    expect(Object.hasOwn(missing, 'historyBaseIndex')).toBe(true);
    expect(Object.hasOwn(zero, 'historyBaseIndex')).toBe(true);
    expect({ ...tailed, ...zero }.historyBaseIndex).toBeUndefined();
  });

  it('snapshot keeps optimistic echoes the worker has not delivered yet', () => {
    const withEcho: SessionProjection = {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'delivered' }], optimistic: true },
        { role: 'user', content: [{ type: 'text', text: 'in flight' }], optimistic: true },
      ],
    };
    const snapshot: SessionSnapshot = {
      identity: identity(),
      status: 'running',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'old' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: 'delivered' }] },
      ],
      commands: [],
    };
    const next = applyAgentEvent(withEcho, 's1', { type: 'snapshot', sessions: [snapshot] });
    expect(next.messages.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'old',
      'ok',
      'delivered',
      'in flight',
    ]);
    expect(next.messages[3]).toHaveProperty('optimistic', true);
  });

  it('snapshot 不因窗口里更早的同文 user 吃掉尚未送达的乐观回显', () => {
    const withEcho: SessionProjection = {
      ...base,
      historyBaseIndex: 40,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }], optimistic: true },
      ],
    };
    const next = applyAgentEvent(withEcho, 's1', {
      type: 'snapshot',
      sessions: [
        {
          identity: identity(),
          status: 'running',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
          ],
          commands: [],
          baseIndex: 40,
        },
      ],
    });
    expect(next.messages.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'hi',
      'hello',
      'hi',
    ]);
    expect(next.messages[2]).toHaveProperty('optimistic', true);
  });

  it('乐观尾巴不被同 index 的 assistant upsert 覆盖，同文本 user upsert 将其消费', () => {
    // 复现：running 中“立即发送”乐观回显在本地尾部，当前轮的 assistant
    // upsert 撞同 index 把它覆盖 → 用户看到消息凭空消失，轮次结束后又出现。
    const withHistory = applyAgentEvent(base, 's1', {
      type: 'message-upsert',
      identity: identity(),
      seq: 1,
      index: 0,
      message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
    });
    const withEcho = {
      ...withHistory,
      messages: [
        ...withHistory.messages,
        {
          role: 'user',
          content: [{ type: 'text' as const, text: 'steer me' }],
          optimistic: true as const,
        },
      ],
    };

    // 当前轮的 assistant 消息撞上乐观回显的 index：回显必须浮到它之后而非被覆盖
    const collided = applyAgentEvent(withEcho, 's1', {
      type: 'message-upsert',
      identity: identity(),
      seq: 2,
      index: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'working...' }] },
    });
    expect(collided.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(collided.messages[2].content).toEqual([{ type: 'text', text: 'steer me' }]);

    // steer 真正送达：同文本的 user upsert 消费掉乐观回显，不产生重复
    const delivered = applyAgentEvent(collided, 's1', {
      type: 'message-upsert',
      identity: identity(),
      seq: 3,
      index: 2,
      message: { role: 'user', content: [{ type: 'text', text: 'steer me' }] },
    });
    expect(delivered.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(delivered.messages[2]).not.toHaveProperty('optimistic', true);

    // 历史区（index < 权威长度）的 upsert 仍是就地覆盖
    const rewrite = applyAgentEvent(delivered, 's1', {
      type: 'message-upsert',
      identity: identity(),
      seq: 4,
      index: 0,
      message: { role: 'user', content: [{ type: 'text', text: 'first!' }] },
    });
    expect(rewrite.messages).toHaveLength(3);
    expect(rewrite.messages[0].content).toEqual([{ type: 'text', text: 'first!' }]);
  });

  it('consumes /skill: optimistic echo when upsert lands as expanded skill XML', () => {
    const rest = '看看是不是利用 diffs，能够简单地添加一个侧边栏类型';
    const expanded =
      '<skill name="diffs" location="/tmp/diffs/SKILL.md">\n# diffs\n\nUse diffs.\n</skill>\n\n' +
      rest;
    const withEcho = {
      ...base,
      messages: [
        {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: `/skill:diffs ${rest}` }],
          optimistic: true as const,
        },
      ],
    };
    const delivered = applyAgentEvent(withEcho, 's1', {
      type: 'message-upsert',
      identity: identity(),
      seq: 1,
      index: 0,
      message: { role: 'user', content: [{ type: 'text', text: expanded }] },
    });
    expect(delivered.messages).toHaveLength(1);
    expect(delivered.messages[0]).not.toHaveProperty('optimistic', true);
    expect(delivered.messages[0].content).toEqual([{ type: 'text', text: expanded }]);
  });

  it('restored generation replaces the projection and rejects stale generation events', () => {
    const g1 = applyAgentEvent(base, 's1', status(5, 'running', 'g1'));
    const snapshot: SessionSnapshot = {
      identity: identity('g2'),
      status: 'idle',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'restored' }] }],
      commands: [],
      customEntries: [],
    };
    const restored = applyAgentEvent(g1, 's1', {
      type: 'snapshot',
      sessions: [snapshot],
      partial: true,
    });
    expect(restored.generation).toBe('g2');
    expect(restored.messages[0].content).toEqual([{ type: 'text', text: 'restored' }]);
    expect(applyAgentEvent(restored, 's1', status(99, 'failed', 'g1'))).toBe(restored);
    const g2 = applyAgentEvent(restored, 's1', status(1, 'running', 'g2'));
    expect(g2.status).toBe('running');
  });

  it('keeps parent custom notifications separate from messages and restores both from snapshot', () => {
    const entry = {
      kind: 'agent-completed' as const,
      child: {
        sessionId: 's1::cw-child',
        generation: 'child-g1',
        instanceId: '123e4567-e89b-42d3-a456-426614174000',
        instanceName: 'Scout · a1',
        typeKey: 'builtin:scout' as const,
      },
      receiptSummary: 'Read-only review completed',
      at: 20,
    };
    const next = applyAgentEvent(base, 's1', {
      type: 'session-custom-entry',
      identity: identity(),
      seq: 1,
      entry,
    });
    expect(next.customEntries).toEqual([entry]);
    expect(next.messages).toEqual([]);

    const restored = applyAgentEvent(next, 's1', {
      type: 'snapshot',
      sessions: [
        {
          identity: identity('g2'),
          status: 'idle',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'parent message' }] }],
          commands: [],
          customEntries: [entry],
        },
      ],
    });
    expect(restored.messages).toHaveLength(1);
    expect(restored.customEntries).toEqual([entry]);
  });

  it('turn-failed records the terminal error and running time settles', () => {
    const running = applyAgentEvent(base, 's1', status(1, 'running'), 1000);
    const failed = applyAgentEvent(
      running,
      's1',
      {
        type: 'turn-failed',
        identity: identity(),
        seq: 2,
        turnId: 'turn-1',
        error: 'boom',
      },
      4500
    );
    expect(failed).toMatchObject({ status: 'failed', error: 'boom', activeMs: 3500 });
  });

  it('turn-retry records retry info while status stays running', () => {
    const running = applyAgentEvent(base, 's1', status(1, 'running'), 1000);
    const retrying = applyAgentEvent(
      running,
      's1',
      {
        type: 'turn-retry',
        identity: identity(),
        seq: 2,
        attempt: 1,
        maxAttempts: 3,
        delayMs: 4000,
        error: '503 status code (no body)',
      },
      2000
    );
    expect(retrying.status).toBe('running');
    expect(retrying.retry).toEqual({
      attempt: 1,
      maxAttempts: 3,
      delayMs: 4000,
      error: '503 status code (no body)',
      at: 2000,
    });
    // 重试真正开跑后 agent_start 会再发 status running，横幅应消失
    const resumed = applyAgentEvent(retrying, 's1', status(3, 'running'), 6000);
    expect(resumed.retry).toBeUndefined();
  });

  it('turn-failed clears retry info', () => {
    const retrying = applyAgentEvent(base, 's1', {
      type: 'turn-retry',
      identity: identity(),
      seq: 1,
      attempt: 3,
      maxAttempts: 3,
      delayMs: 4000,
      error: 'boom',
    });
    const failed = applyAgentEvent(retrying, 's1', {
      type: 'turn-failed',
      identity: identity(),
      seq: 2,
      turnId: 'turn-1',
      error: 'boom',
    });
    expect(failed.retry).toBeUndefined();
    expect(failed.status).toBe('failed');
  });

  it('worker-exited has no seq threshold and fails the live projection', () => {
    const next = applyAgentEvent(base, 's1', { type: 'worker-exited' });
    expect(next.status).toBe('failed');
  });

  it('applies only increasing Main seq for one exact dispatch/child and never reopens terminal', () => {
    const child = {
      sessionId: 's1',
      generation: '11111111-1111-4111-8111-111111111111',
      parent: {
        sessionId: 'parent',
        generation: '22222222-2222-4222-8222-222222222222',
      },
      instanceId: '123e4567-e89b-42d3-a456-426614174000',
      instanceName: 'Scout · a1',
      typeKey: 'builtin:scout' as const,
    };
    const dispatchId = '123e4567-e89b-42d3-a456-426614174001';
    const running = applyDispatchEvent(base, 's1', {
      dispatchId,
      child,
      mainSeq: 4,
      phase: 'running',
    });
    const low = applyDispatchEvent(running, 's1', {
      dispatchId,
      child,
      mainSeq: 3,
      phase: 'waiting-user',
    });
    const terminal = applyDispatchEvent(running, 's1', {
      dispatchId,
      child,
      mainSeq: 5,
      phase: 'terminal',
      terminal: 'completed',
      receiptSummary: 'Done after receipts settled',
    });
    const reopened = applyDispatchEvent(terminal, 's1', {
      dispatchId,
      child,
      mainSeq: 6,
      phase: 'running',
    });
    const staleGeneration = applyDispatchEvent(terminal, 's1', {
      dispatchId,
      child: { ...child, generation: '33333333-3333-4333-8333-333333333333' },
      mainSeq: 7,
      phase: 'terminal',
      terminal: 'failed',
    });

    expect(low).toBe(running);
    expect(terminal).toMatchObject({
      status: 'idle',
      dispatchMainEvents: {
        [dispatchId]: { mainSeq: 5, phase: 'terminal', terminal: 'completed' },
      },
    });
    expect(reopened).toBe(terminal);
    expect(staleGeneration).toBe(terminal);
  });
});

describe('applyAgentEvent approval-request reviewing', () => {
  it('reviewing 进入 pendingApprovals，resolved 后清掉', () => {
    const request = {
      requestId: 'apr-1',
      tool: 'write',
      kind: 'file-write' as const,
      summary: '/tmp/x',
      toolCallId: 't1',
      phase: 'reviewing' as const,
    };
    const reviewing = applyAgentEvent(base, 's1', {
      type: 'approval-request',
      identity: identity(),
      seq: 1,
      request,
    });
    expect(reviewing.pendingApprovals).toEqual([request]);
    const resolved = applyAgentEvent(reviewing, 's1', {
      type: 'approval-resolved',
      identity: identity(),
      seq: 2,
      requestId: 'apr-1',
    });
    expect(resolved.pendingApprovals).toEqual([]);
  });
});

describe('applyAgentEvent tool-output', () => {
  const toolOutput = (seq: number, output: string, startedAt?: number): RendererAgentEvent => ({
    type: 'tool-output',
    identity: identity(),
    seq,
    toolCallId: 't1',
    output,
    ...(startedAt === undefined ? {} : { startedAt }),
  });

  it('累积工具增量输出快照（后到覆盖先到）', () => {
    const first = applyAgentEvent(base, 's1', toolOutput(1, 'line 1'));
    const second = applyAgentEvent(first, 's1', toolOutput(2, 'line 1\nline 2'));
    expect(second.toolOutputs).toEqual({ t1: 'line 1\nline 2' });
    expect(second.lastOutputAt).toBeDefined();
  });

  it('startedAt 只在首次出现时记下，后续增量覆盖不改起点', () => {
    const first = applyAgentEvent(base, 's1', toolOutput(1, '', 1_000));
    expect(first.toolStartedAt).toEqual({ t1: 1_000 });
    const second = applyAgentEvent(first, 's1', toolOutput(2, 'line'));
    expect(second.toolOutputs).toEqual({ t1: 'line' });
    expect(second.toolStartedAt).toEqual({ t1: 1_000 });
  });

  it('轮次收口后清空增量快照，避免残留与无限增长', () => {
    const withOutput = applyAgentEvent(base, 's1', toolOutput(1, 'partial'));
    const done = applyAgentEvent(withOutput, 's1', {
      type: 'turn-completed',
      identity: identity(),
      seq: 2,
      turnId: 'turn-1',
    });
    expect(done.toolOutputs).toEqual({});
    expect(done.toolStartedAt).toEqual({});

    const failed = applyAgentEvent(withOutput, 's1', {
      type: 'turn-failed',
      identity: identity(),
      seq: 2,
      turnId: 'turn-1',
      error: 'boom',
    });
    expect(failed.toolOutputs).toEqual({});
  });

  it('toolResult 落地即清掉该工具的流式输出与起点，不让 hasToolOutput 豁免拖到轮末', () => {
    const withOutput = applyAgentEvent(
      applyAgentEvent(base, 's1', toolOutput(1, 'partial', 1_000)),
      's1',
      { ...toolOutput(2, 'other'), toolCallId: 't2' } as RendererAgentEvent
    );
    const done = applyAgentEvent(withOutput, 's1', {
      type: 'message-upsert',
      identity: identity(),
      seq: 3,
      index: 0,
      message: {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'done' }],
      },
    });
    expect(done.toolOutputs).toEqual({ t2: 'other' });
    expect(done.toolStartedAt).toEqual({});
  });
});

describe('lastOutputAt stall heartbeat', () => {
  const NOW = 50_000;
  const upsert = (
    seq: number,
    index: number,
    message: SessionProjection['messages'][number]
  ): RendererAgentEvent => ({
    type: 'message-upsert',
    identity: identity(),
    seq,
    index,
    message,
  });

  it('越界 upsert 只推 seq，不续命 lastOutputAt', () => {
    const seeded: SessionProjection = { ...base, lastOutputAt: 1_000 };
    const next = applyAgentEvent(
      seeded,
      's1',
      upsert(1, 5, { role: 'assistant', content: [{ type: 'text', text: 'late' }] }),
      NOW
    );
    expect(next.lastSeq).toBe(1);
    expect(next.messages).toHaveLength(0);
    expect(next.lastOutputAt).toBe(1_000);
  });

  it('非空 assistant text 刷新 lastOutputAt', () => {
    const next = applyAgentEvent(
      base,
      's1',
      upsert(1, 0, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }),
      NOW
    );
    expect(next.lastOutputAt).toBe(NOW);
  });

  it('空 assistant / Connection error 不刷新', () => {
    const seeded: SessionProjection = { ...base, lastOutputAt: 1_000 };
    const next = applyAgentEvent(
      seeded,
      's1',
      upsert(1, 0, {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Connection error.',
      }),
      NOW
    );
    expect(next.lastOutputAt).toBe(1_000);
  });

  it('非空 thinking 刷新，空 thinking 与仅 toolCall 不刷新', () => {
    const thinking = applyAgentEvent(
      { ...base, lastOutputAt: 1_000 },
      's1',
      upsert(1, 0, { role: 'assistant', content: [{ type: 'thinking', text: 'plan' }] }),
      NOW
    );
    expect(thinking.lastOutputAt).toBe(NOW);

    const emptyThinking = applyAgentEvent(
      { ...base, lastOutputAt: 1_000 },
      's1',
      upsert(1, 0, { role: 'assistant', content: [{ type: 'thinking', text: '  ' }] }),
      NOW
    );
    expect(emptyThinking.lastOutputAt).toBe(1_000);

    const toolCallOnly = applyAgentEvent(
      { ...base, lastOutputAt: 1_000 },
      's1',
      upsert(1, 0, {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.md' } }],
      }),
      NOW
    );
    expect(toolCallOnly.lastOutputAt).toBe(1_000);
  });

  it('toolResult 刷新 lastOutputAt', () => {
    const next = applyAgentEvent(
      { ...base, lastOutputAt: 1_000 },
      's1',
      upsert(1, 0, {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'read',
        content: [{ type: 'text', text: '# guide' }],
      }),
      NOW
    );
    expect(next.lastOutputAt).toBe(NOW);
  });

  it('用户消息不刷新 lastOutputAt', () => {
    const next = applyAgentEvent(
      { ...base, lastOutputAt: 1_000 },
      's1',
      upsert(1, 0, { role: 'user', content: [{ type: 'text', text: 'hi' }] }),
      NOW
    );
    expect(next.lastOutputAt).toBe(1_000);
  });

  it('非空 tool-output 刷新，空快照不刷新', () => {
    const live = applyAgentEvent(
      { ...base, lastOutputAt: 1_000 },
      's1',
      {
        type: 'tool-output',
        identity: identity(),
        seq: 1,
        toolCallId: 't1',
        output: 'line 1',
      },
      NOW
    );
    expect(live.lastOutputAt).toBe(NOW);

    const empty = applyAgentEvent(
      { ...base, lastOutputAt: 1_000 },
      's1',
      {
        type: 'tool-output',
        identity: identity(),
        seq: 1,
        toolCallId: 't1',
        output: '  ',
      },
      NOW
    );
    expect(empty.lastOutputAt).toBe(1_000);
  });

  it.each(['text', 'thinking'] as const)(
    '尾窗内重复 %s 即使 seq 和无关工具参数变化也不续命，新增正文才刷新',
    (type) => {
      const message = (text: string, offset: number): SessionProjection['messages'][number] => ({
        role: 'assistant',
        content: [
          { type, text },
          {
            type: 'toolCall',
            id: 'c1',
            name: 'read',
            arguments: { path: '/workspace/guide.md', offset },
          },
        ],
      });
      const first = applyAgentEvent(tail(), 's1', upsert(1, 40, message('plan', 1)), 1_000);
      const replay = message('plan', 2);
      const repeated = applyAgentEvent(first, 's1', upsert(2, 40, replay), NOW);
      expect(repeated.lastSeq).toBe(2);
      expect(repeated.messages).toEqual([replay]);
      expect.soft(repeated.lastOutputAt).toBe(1_000);

      const growing = applyAgentEvent(
        repeated,
        's1',
        upsert(3, 40, message('plan next step', 2)),
        NOW + 1_000
      );
      expect(growing.lastOutputAt).toBe(NOW + 1_000);
    }
  );

  it('同位置重复 toolResult 不续命，工具结果正文变化才刷新', () => {
    const result = (text: string): SessionProjection['messages'][number] => ({
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'read',
      content: [{ type: 'text', text }],
    });
    const first = applyAgentEvent(base, 's1', upsert(1, 0, result('# guide')), 1_000);
    const repeated = applyAgentEvent(first, 's1', upsert(2, 0, result('# guide')), NOW);
    expect(repeated.lastSeq).toBe(2);
    expect(repeated.messages).toEqual([result('# guide')]);
    expect.soft(repeated.lastOutputAt).toBe(1_000);

    const changed = applyAgentEvent(
      repeated,
      's1',
      upsert(3, 0, result('# guide\nnext section')),
      NOW + 1_000
    );
    expect(changed.lastOutputAt).toBe(NOW + 1_000);
  });

  it('同一工具的非空 tool-output 重复快照不续命，变化的非空快照才刷新', () => {
    const output = (seq: number, text: string): RendererAgentEvent => ({
      type: 'tool-output',
      identity: identity(),
      seq,
      toolCallId: 't1',
      output: text,
    });
    const first = applyAgentEvent(base, 's1', output(1, 'line 1'), 1_000);
    const repeated = applyAgentEvent(first, 's1', output(2, 'line 1'), NOW);
    expect(repeated.lastSeq).toBe(2);
    expect(repeated.toolOutputs).toEqual({ t1: 'line 1' });
    expect.soft(repeated.lastOutputAt).toBe(1_000);

    const changed = applyAgentEvent(repeated, 's1', output(3, 'line 2'), NOW + 1_000);
    expect(changed.toolOutputs).toEqual({ t1: 'line 2' });
    expect(changed.lastOutputAt).toBe(NOW + 1_000);
  });

  it.each(['write', 'edit'] as const)('%s 可见预览静止时不续命，预览继续增长才刷新', (name) => {
    // 时间线从 write.content 或 edit.edits[] 提取可见内容，不是整个 arguments JSON。
    const message = (text: string, path: string): SessionProjection['messages'][number] => ({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'c1',
          name,
          arguments:
            name === 'write'
              ? { path, content: text }
              : { path, edits: [{ oldText: 'const previous = 0;', newText: text }] },
        },
      ],
    });
    const first = applyAgentEvent(
      { ...base, lastOutputAt: 1_000 },
      's1',
      upsert(1, 0, message('const next =', '/workspace/a.ts')),
      1_000
    );
    const replay = message('const next =', '/workspace/b.ts');
    const repeated = applyAgentEvent(first, 's1', upsert(2, 0, replay), NOW);
    expect(repeated.lastSeq).toBe(2);
    expect(repeated.messages).toEqual([replay]);
    expect(repeated.lastOutputAt).toBe(1_000);

    const preview = message('const next = 1;', '/workspace/b.ts');
    const growing = applyAgentEvent(repeated, 's1', upsert(3, 0, preview), NOW + 1_000);
    expect(growing.messages).toEqual([preview]);
    expect(growing.lastOutputAt).toBe(NOW + 1_000);
  });

  it.each(['write', 'edit'] as const)('%s 只有路径的工具占位变化不续命', (name) => {
    const message = (path: string): SessionProjection['messages'][number] => ({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c1', name, arguments: { path } }],
    });
    const first = applyAgentEvent(
      { ...base, lastOutputAt: 1_000 },
      's1',
      upsert(1, 0, message('/workspace/a.ts')),
      NOW
    );
    expect(first.lastOutputAt).toBe(1_000);

    const placeholder = message('/workspace/b.ts');
    const changed = applyAgentEvent(first, 's1', upsert(2, 0, placeholder), NOW + 1_000);
    expect(changed.lastSeq).toBe(2);
    expect(changed.messages).toEqual([placeholder]);
    expect(changed.lastOutputAt).toBe(1_000);
  });

  it('edit 预览相同但块字段顺序或额外元数据变化不续命', () => {
    const message = (edit: {
      oldText: string;
      newText: string;
      note: number;
    }): SessionProjection['messages'][number] => ({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'c1',
          name: 'edit',
          arguments: { path: '/workspace/a.ts', edits: [edit] },
        },
      ],
    });
    const first = applyAgentEvent(
      base,
      's1',
      upsert(1, 0, message({ oldText: 'old', newText: 'new', note: 1 })),
      1_000
    );
    const reordered = applyAgentEvent(
      first,
      's1',
      upsert(2, 0, message({ newText: 'new', oldText: 'old', note: 1 })),
      NOW
    );
    expect.soft(reordered.lastOutputAt).toBe(1_000);
    const changedMetadata = message({ newText: 'new', oldText: 'old', note: 2 });
    const repeated = applyAgentEvent(reordered, 's1', upsert(3, 0, changedMetadata), NOW + 1_000);
    expect(repeated.lastSeq).toBe(3);
    expect(repeated.messages).toEqual([changedMetadata]);
    expect(repeated.lastOutputAt).toBe(1_000);
  });

  it('edit 空 oldText/newText 占位不续命，真实删除的非空 oldText 算可见预览', () => {
    const message = (oldText: string): SessionProjection['messages'][number] => ({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'c1',
          name: 'edit',
          arguments: { path: '/workspace/a.ts', edits: [{ oldText, newText: '' }] },
        },
      ],
    });
    const empty = applyAgentEvent(
      { ...base, lastOutputAt: 1_000 },
      's1',
      upsert(1, 0, message('')),
      NOW
    );
    expect.soft(empty.lastOutputAt).toBe(1_000);
    const deletion = applyAgentEvent(
      empty,
      's1',
      upsert(2, 0, message('const obsolete = true;')),
      NOW + 1_000
    );
    expect(deletion.lastOutputAt).toBe(NOW + 1_000);
  });
});

describe('snapshot running clocks', () => {
  const NOW = 50_000;
  const restore = (
    state: SessionProjection,
    overrides: Partial<SessionSnapshot> = {},
    now = NOW
  ): SessionProjection =>
    applyAgentEvent(
      state,
      's1',
      { type: 'snapshot', sessions: [{ ...snapshot(), status: 'running', ...overrides }] },
      now
    );

  it('首次 running 快照从接收时间计时，历史正文与后续空 assistant 不续命', () => {
    const restored = restore(base, { messages: [assistant('historical answer')] });
    expect.soft(restored.runStartedAt).toBe(NOW);
    expect(restored.lastOutputAt).toBeUndefined();
    const empty = applyAgentEvent(
      restored,
      's1',
      {
        type: 'message-upsert',
        identity: identity(),
        seq: 1,
        index: 1,
        message: { role: 'assistant', content: [] },
      },
      NOW + 1_000
    );
    expect.soft(empty.runStartedAt).toBe(NOW);
    expect(empty.lastOutputAt).toBeUndefined();
    expect(
      shouldAbortStalledGeneration({
        ...empty,
        now: NOW + 120_000,
        timeoutMs: 120_000,
        hasLiveWork: false,
      })
    ).toBe(true);
  });

  it.each([undefined, 2_000])(
    '同代连续 running 快照保留开始时间和既有心跳 %s，不把历史当新输出',
    (lastOutputAt) => {
      const running = {
        ...applyAgentEvent({ ...base, activeMs: 500 }, 's1', status(1, 'running'), 1_000),
        lastOutputAt,
      };
      const first = restore(running, { messages: [assistant('history')] });
      const second = restore(first, { messages: [assistant('history updated')] }, NOW + 1_000);
      for (const restored of [first, second]) {
        expect.soft(restored.runStartedAt).toBe(1_000);
        expect.soft(restored.lastOutputAt).toBe(lastOutputAt);
        expect(restored.activeMs).toBe(500);
      }
    }
  );

  it('新代 running 快照重建基准并清除旧代心跳与累计时间', () => {
    const running = {
      ...applyAgentEvent({ ...base, activeMs: 500 }, 's1', status(1, 'running'), 1_000),
      lastOutputAt: 2_000,
    };
    const restored = restore(running, {
      identity: identity('g2'),
      messages: [assistant('new generation history')],
    });
    expect(restored.generation).toBe('g2');
    expect.soft(restored.runStartedAt).toBe(NOW);
    expect(restored.activeMs).toBe(0);
    // store 浅合并投影；只省略字段会把旧代心跳留在会话里。
    expect({ ...running, ...restored }.lastOutputAt).toBeUndefined();
  });

  it.each(['idle', 'failed'] as const)('%s 快照显式清除运行时钟，浅合并也不残留', (status) => {
    const running: SessionProjection = {
      ...base,
      generation: 'g1',
      status: 'running',
      runStartedAt: 1_000,
      lastOutputAt: 2_000,
    };
    const restored = restore(running, { status });
    expect(restored.status).toBe(status);
    const merged = { ...running, ...restored };
    expect.soft(merged.runStartedAt).toBeUndefined();
    expect(merged.lastOutputAt).toBeUndefined();
  });

  it('同代 idle 快照结算运行时长，重复 idle 快照不重复累计', () => {
    const running = applyAgentEvent({ ...base, activeMs: 500 }, 's1', status(1, 'running'), 1_000);
    const idle = restore(running, { status: 'idle' }, 4_000);
    expect.soft(idle.activeMs).toBe(3_500);
    expect(restore(idle, { status: 'idle' }, 5_000).activeMs).toBe(3_500);
  });

  it('running 尾窗快照保留基准，窗口前后越界 upsert 只推进 seq 不续命', () => {
    const running = {
      ...applyAgentEvent(base, 's1', status(1, 'running'), 1_000),
      lastOutputAt: 2_000,
    };
    const restored = restore(running, {
      ...snapshot(40),
      status: 'running',
      messages: [assistant('m40')],
    });
    let next = restored;
    for (const [seq, index] of [
      [1, 39],
      [2, 42],
    ]) {
      next = applyAgentEvent(
        next,
        's1',
        { type: 'message-upsert', identity: identity(), seq, index, message: assistant('late') },
        NOW + seq * 1_000
      );
      expect(next.lastSeq).toBe(seq);
      expect(next.historyBaseIndex).toBe(40);
      expect(next.messages).toEqual([assistant('m40')]);
      expect.soft(next.runStartedAt).toBe(1_000);
      expect.soft(next.lastOutputAt).toBe(2_000);
    }
  });

  it('同轮 running 快照保留进行中工具输出，重复输出仍使用快照前的去重基准', () => {
    const message: SessionProjection['messages'][number] = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'build' } }],
    };
    const running = applyAgentEvent(
      { ...base, messages: [message] },
      's1',
      status(1, 'running'),
      1_000
    );
    const output = (seq: number): RendererAgentEvent => ({
      type: 'tool-output',
      identity: identity(),
      seq,
      toolCallId: 'c1',
      output: 'building',
    });
    const live = applyAgentEvent(running, 's1', output(2), 2_000);
    const restored = restore(live, { messages: [message] });
    expect.soft(restored.toolOutputs).toEqual({ c1: 'building' });
    expect(restored.lastOutputAt).toBe(2_000);
    const repeated = applyAgentEvent(restored, 's1', output(3), NOW + 1_000);
    expect(repeated.lastSeq).toBe(3);
    expect(repeated.toolOutputs).toEqual({ c1: 'building' });
    expect(repeated.lastOutputAt).toBe(2_000);
  });

  it('同轮快照只清掉已完成工具的旧输出，idle 或新代快照清掉其余输出', () => {
    const calls: SessionProjection['messages'][number] = {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'c1', name: 'bash' },
        { type: 'toolCall', id: 'c2', name: 'bash' },
      ],
    };
    const running: SessionProjection = {
      ...base,
      generation: 'g1',
      status: 'running',
      runStartedAt: 1_000,
      lastOutputAt: 2_000,
      messages: [calls],
      toolOutputs: { c1: 'old partial', c2: 'still building' },
    };
    const restored = restore(running, {
      messages: [
        calls,
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'done' }],
        },
      ],
    });
    expect.soft(restored.toolOutputs).toEqual({ c2: 'still building' });
    expect(restored.lastOutputAt).toBe(2_000);
    expect(restore(running, { status: 'idle' }).toolOutputs).toEqual({});
    expect(restore(running, { identity: identity('g2') }).toolOutputs).toEqual({});
  });

  it('messages-truncated 按绝对 length 减去 historyBaseIndex 裁局部窗口', () => {
    const state = tail([assistant('m40'), assistant('m41'), assistant('m42')]);
    const next = applyAgentEvent(state, 's1', {
      type: 'messages-truncated',
      identity: identity(),
      seq: 1,
      length: 42,
    }) as TailProjection;
    expect(next.messages).toEqual([assistant('m40'), assistant('m41')]);
    expect(next.historyBaseIndex).toBe(40);
  });

  it('messages-truncated length<=base 丢弃尾窗权威正文并清 historyBaseIndex', () => {
    const optimistic = { ...assistant('pending'), optimistic: true as const };
    const state = tail([assistant('m40'), assistant('m41'), optimistic]);
    const next = applyAgentEvent(state, 's1', {
      type: 'messages-truncated',
      identity: identity(),
      seq: 1,
      length: 10,
    }) as TailProjection;
    expect(next.messages).toEqual([optimistic]);
    expect(next.historyBaseIndex).toBeUndefined();
    expect(Object.hasOwn(next, 'historyBaseIndex')).toBe(true);
  });

  it('truncatedNeedsSnapshotResync：裁到尾窗起点之前才要补快照', () => {
    expect(truncatedNeedsSnapshotResync(40, 10)).toBe(true);
    expect(truncatedNeedsSnapshotResync(40, 40)).toBe(true);
    expect(truncatedNeedsSnapshotResync(40, 41)).toBe(false);
    expect(truncatedNeedsSnapshotResync(undefined, 1)).toBe(false);
  });
});
