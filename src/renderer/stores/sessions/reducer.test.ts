import type { RendererAgentEvent, SessionSnapshot } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  applyAgentEvent,
  applyDispatchEvent,
  emptyProjection,
  type SessionProjection,
} from './reducer';

const identity = (generation = 'g1') => ({ sessionId: 's1', generation });
const base: SessionProjection = { ...emptyProjection };
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
