import type { ChildSessionIdentity, SessionIdentity } from '@shared/builtinAgents';
import { describe, expect, it } from 'vitest';
import { AgentSessionIndex, MAX_ORIGIN_COWORKERS } from './agentSessionIndex';

const parent: SessionIdentity = {
  sessionId: 'origin',
  generation: '11111111-1111-4111-8111-111111111111',
};

function uuids(): () => string {
  let counter = 1;
  return () => `${String(counter++).padStart(8, '0')}-0000-4000-8000-000000000001`;
}

function index(): AgentSessionIndex {
  return new AgentSessionIndex({ readSettings: () => null, randomUuid: uuids() });
}

function readyChild(child: ChildSessionIdentity) {
  return {
    type: 'child-ready' as const,
    identity: child,
    seq: 1,
    sessionFile: `/tmp/${child.instanceId}.jsonl`,
    proof: {
      spawnSpecId: 'spawn',
      typeKey: child.typeKey,
      model: { providerId: 'openai-completions', modelId: 'model' },
      toolIds: ['read'],
      loadedSkillBindingIds: [],
      loadedMcpBindingIds: [],
      systemPromptHash: 'hash',
    },
  };
}

describe('AgentSessionIndex generation and reservation authority', () => {
  it('generates a fresh id, generation, and unique instance name for every mention', () => {
    const sessions = index();
    sessions.prepareParent(parent);

    const first = sessions.reserveChild(parent, 'builtin:scout', 'Scout', 'request-1');
    const second = sessions.reserveChild(parent, 'builtin:scout', 'Scout', 'request-2');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.reservation.child.sessionId).not.toBe(second.reservation.child.sessionId);
    expect(first.reservation.child.generation).not.toBe(second.reservation.child.generation);
    expect(first.reservation.child.instanceName).not.toBe(second.reservation.child.instanceName);
  });

  it('counts active plus reserved atomically and releases failed reservations', () => {
    const sessions = index();
    sessions.prepareParent(parent);
    const reserved = Array.from({ length: MAX_ORIGIN_COWORKERS }, (_, position) =>
      sessions.reserveChild(parent, 'builtin:worker', 'Worker', `request-${position}`)
    );
    expect(reserved.every((result) => result.ok)).toBe(true);
    expect(
      sessions.reserveChild(parent, 'builtin:worker', 'Worker', 'request-overflow')
    ).toMatchObject({ ok: false, code: 'capacity-reached' });

    const first = reserved[0];
    if (!first.ok) return;
    expect(sessions.releaseChild(first.reservation.child)).toBe(true);
    expect(
      sessions.reserveChild(parent, 'builtin:worker', 'Worker', 'request-retry')
    ).toMatchObject({ ok: true });
  });

  it('rejects stale generations and cannot activate an unreserved child identity', () => {
    const sessions = index();
    sessions.prepareParent(parent);
    const reserved = sessions.reserveChild(parent, 'builtin:reviewer', 'Reviewer', 'request');
    if (!reserved.ok) return;

    const stale = {
      ...reserved.reservation.child,
      generation: '22222222-2222-4222-8222-222222222222',
    };
    expect(sessions.observe(readyChild(stale))).toBe(false);
    expect(sessions.currentIdentity(stale.sessionId)).toBeUndefined();

    expect(sessions.observe(readyChild(reserved.reservation.child))).toBe(true);
    expect(sessions.currentIdentity(reserved.reservation.child.sessionId)).toEqual(
      reserved.reservation.child
    );
    expect(sessions.releaseChild(reserved.reservation.child)).toBe(false);
  });

  it('drops late parent events after a new generation is prepared', () => {
    const sessions = index();
    sessions.prepareParent(parent);
    const replacement = {
      sessionId: parent.sessionId,
      generation: '33333333-3333-4333-8333-333333333333',
    };
    sessions.prepareParent(replacement);

    expect(
      sessions.observe({
        type: 'parent-ready',
        identity: parent,
        seq: 1,
        sessionFile: '/tmp/late.jsonl',
        model: { providerId: 'openai-completions', modelId: 'model' },
      })
    ).toBe(false);
    expect(sessions.isReady(parent)).toBe(false);
    expect(sessions.currentIdentity(parent.sessionId)).toEqual(replacement);
  });

  it('model-changed 更新已启动模型；旧 generation 的上报不生效', () => {
    // 不更新的后果见 issue #30：改过模型的会话，后续 @Agent 派发会因
    // selection 与已启动模型对不上而被永久拒绝。
    const sessions = index();
    sessions.prepareParent(parent);
    sessions.observe({
      type: 'parent-ready',
      identity: parent,
      seq: 1,
      sessionFile: '/tmp/a.jsonl',
      model: { providerId: 'pv-A', modelId: 'model-1' },
    });
    expect(sessions.model(parent)).toEqual({ providerId: 'pv-A', modelId: 'model-1' });

    expect(
      sessions.observe({
        type: 'model-changed',
        identity: parent,
        seq: 2,
        model: { providerId: 'pv-B', modelId: 'model-1' },
      })
    ).toBe(true);
    expect(sessions.model(parent)).toEqual({ providerId: 'pv-B', modelId: 'model-1' });

    expect(
      sessions.observe({
        type: 'model-changed',
        identity: { sessionId: parent.sessionId, generation: 'stale-generation' },
        seq: 3,
        model: { providerId: 'pv-C', modelId: 'model-1' },
      })
    ).toBe(false);
    expect(sessions.model(parent)).toEqual({ providerId: 'pv-B', modelId: 'model-1' });
  });

  it('rejects duplicate or decreasing seq and does not let snapshots overwrite sequenced state', () => {
    const sessions = index();
    sessions.prepareParent(parent);
    expect(
      sessions.observe({
        type: 'parent-ready',
        identity: parent,
        seq: 5,
        sessionFile: '/tmp/current.jsonl',
        model: { providerId: 'settings-provider', modelId: 'model' },
      })
    ).toBe(true);
    expect(
      sessions.observe({
        type: 'status',
        identity: parent,
        seq: 4,
        status: 'failed',
      })
    ).toBe(false);
    expect(sessions.isReady(parent)).toBe(true);
    expect(
      sessions.observe({
        type: 'snapshot',
        sessions: [{ identity: parent, status: 'failed', messages: [], commands: [] }],
      })
    ).toBe(false);
    expect(sessions.isReady(parent)).toBe(true);
  });

  it('resets seq authority when prepareParent installs a new generation', () => {
    const sessions = index();
    sessions.prepareParent(parent);
    expect(
      sessions.observe({
        type: 'parent-ready',
        identity: parent,
        seq: 9,
        sessionFile: '/tmp/old.jsonl',
        model: { providerId: 'settings-provider', modelId: 'model' },
      })
    ).toBe(true);
    const replacement = {
      sessionId: parent.sessionId,
      generation: '33333333-3333-4333-8333-333333333333',
    };
    sessions.prepareParent(replacement);
    expect(
      sessions.observe({
        type: 'parent-ready',
        identity: replacement,
        seq: 1,
        sessionFile: '/tmp/new.jsonl',
        model: { providerId: 'settings-provider', modelId: 'model' },
      })
    ).toBe(true);
    expect(sessions.isReady(replacement)).toBe(true);
  });
});
