import type { RendererAgentEvent, SessionSnapshot } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { cachedPartializeSessions } from './persistSnapshot';
import { applyAgentEvent, emptyProjection } from './reducer';

const identity = { sessionId: 'body-fixture', generation: 'g1' };
const usage = { bytes: 25, limitBytes: 100, stage: 'wire' as const, blocked: false, at: 10 };
const event = (seq: number): RendererAgentEvent =>
  ({ type: 'request-body', identity, seq, usage }) as unknown as RendererAgentEvent;
describe('请求体计量会话投影', () => {
  it('按 generation / seq 更新，不伪造可见输出或状态，终态保留最后大小', () => {
    const state = {
      ...emptyProjection,
      generation: 'g1',
      status: 'running' as const,
      lastOutputAt: 1,
    };
    const next = applyAgentEvent(state, identity.sessionId, event(3), 20);
    expect(next).toMatchObject({
      requestBody: usage,
      lastSeq: 3,
      lastOutputAt: 1,
      status: 'running',
    });
    expect(applyAgentEvent(next, identity.sessionId, event(2), 21)).toBe(next);
    expect(
      applyAgentEvent(
        next,
        identity.sessionId,
        { ...event(4), identity: { ...identity, generation: 'g0' } } as RendererAgentEvent,
        22
      )
    ).toBe(next);
  });
  it('快照重建最新计量，缺省时显式清空，store 浅合并不得留下旧大小', () => {
    const snapshot = {
      identity,
      status: 'idle',
      messages: [],
      commands: [],
      requestBody: usage,
    } as unknown as SessionSnapshot;
    const next = applyAgentEvent({ ...emptyProjection }, identity.sessionId, {
      type: 'snapshot',
      sessions: [snapshot],
    });
    expect(next).toHaveProperty('requestBody', usage);
    const cleared = applyAgentEvent(next, identity.sessionId, {
      type: 'snapshot',
      sessions: [{ ...snapshot, requestBody: undefined } as SessionSnapshot],
    });
    expect({ ...next, ...cleared }).toHaveProperty('requestBody', undefined);
  });
  it('遥测不持久化，单纯大小更新不产生新的 settings 快照', () => {
    const conv = {
      id: 'body-fixture',
      title: 'fixture',
      messages: [],
      createdAt: 1,
      started: false,
      requestBody: usage,
    };
    const state = {
      conversations: { 'body-fixture': conv },
      order: ['body-fixture'],
      activeId: 'body-fixture',
    };
    const first = cachedPartializeSessions(state);
    expect(first.conversations['body-fixture']).not.toHaveProperty('requestBody');
    expect(
      cachedPartializeSessions({
        ...state,
        conversations: { 'body-fixture': { ...conv, requestBody: { ...usage, bytes: 30 } } },
      })
    ).toBe(first);
  });
});
