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
