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
  it('accepts a revived session restarting at seq 1 after parent-ended or worker-exited', () => {
    const ready = (seq: number) => ({
      type: 'parent-ready' as const,
      identity: parent,
      seq,
      sessionFile: '/tmp/a.jsonl',
      model: { providerId: 'pv', modelId: 'm' },
    });
    const sessions = index();
    sessions.prepareParent(parent);
    expect(sessions.observe(ready(40))).toBe(true);
    sessions.observe({ type: 'parent-ended', identity: parent, seq: 41, reason: 'evicted' });
    expect(sessions.isReady(parent)).toBe(false);
    // 同 generation 重新 spawn：worker seq 从 0 起
    sessions.prepareParent(parent);
    expect(sessions.observe(ready(1))).toBe(true);
    expect(sessions.isReady(parent)).toBe(true);

    sessions.observe({ type: 'worker-exited' });
    expect(sessions.isReady(parent)).toBe(false);
    sessions.prepareParent(parent);
    expect(sessions.observe(ready(1))).toBe(true);
    expect(sessions.isReady(parent)).toBe(true);
  });

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

  it('reserveChildResume 保留原 instanceId/name/typeKey，只换新 generation', () => {
    // §7.3：resume 的身份连续性——sessionFile/instanceId/name 不变，每次恢复新 generation。
    const sessions = index();
    sessions.prepareParent(parent);
    const metadata = {
      parentId: parent.sessionId,
      childGeneration: 'old-generation',
      agentTypeKey: 'builtin:scout' as const,
      agentInstanceId: '99999999-9999-4999-8999-999999999999',
      agentInstanceName: 'Scout · 9999',
      dispatchOrigin: 'typed-mention' as const,
    };
    const resumed = sessions.reserveChildResume(parent, metadata, 'resume-1');
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    const child = resumed.reservation.child;
    expect(child.sessionId).toBe(`${parent.sessionId}::cw-${metadata.agentInstanceId}`);
    expect(child.instanceId).toBe(metadata.agentInstanceId);
    expect(child.instanceName).toBe(metadata.agentInstanceName);
    expect(child.typeKey).toBe('builtin:scout');
    expect(child.generation).not.toBe('old-generation');
    expect(resumed.reservation.metadata.childGeneration).toBe(child.generation);
    // 恢复预约同样占容量名额，与新雇共用 occupied 计数
    for (let position = 1; position < MAX_ORIGIN_COWORKERS; position += 1) {
      expect(sessions.reserveChild(parent, 'builtin:worker', 'Worker', `fill-${position}`).ok).toBe(
        true
      );
    }
    expect(sessions.reserveChild(parent, 'builtin:worker', 'Worker', 'overflow')).toMatchObject({
      ok: false,
      code: 'capacity-reached',
    });
  });

  it('reserveChildResume 不被自己的持久化名字挡住（真机回归：恢复必然自撞）', () => {
    // usedNames 扫持久化防跨重启撞名；但 resume 的 child 自己的名字必然在盘上——
    // 把它算冲突会让所有 typed child 永远恢复失败。只有「其他会话」同名才是冲突。
    const metadata = {
      parentId: parent.sessionId,
      childGeneration: 'old-generation',
      agentTypeKey: 'builtin:scout' as const,
      agentInstanceId: '99999999-9999-4999-8999-999999999999',
      agentInstanceName: 'Scout · 9999',
      dispatchOrigin: 'typed-mention' as const,
    };
    const selfId = `${parent.sessionId}::cw-${metadata.agentInstanceId}`;
    const withPersisted = (conversations: Record<string, unknown>) =>
      new AgentSessionIndex({
        readSettings: () => ({ 'enso-conversations': { state: { conversations } } }),
        randomUuid: uuids(),
      });

    // 自己的持久化名字 → 必须成功
    const sessions = withPersisted({
      [selfId]: { parentId: parent.sessionId, coworkerName: metadata.agentInstanceName },
    });
    sessions.prepareParent(parent);
    expect(sessions.reserveChildResume(parent, metadata, 'resume-1').ok).toBe(true);

    // 另一个会话同名 → 拒绝
    const conflicted = withPersisted({
      [`${parent.sessionId}::cw-other`]: {
        parentId: parent.sessionId,
        coworkerName: metadata.agentInstanceName,
      },
    });
    conflicted.prepareParent(parent);
    expect(conflicted.reserveChildResume(parent, metadata, 'resume-2').ok).toBe(false);
  });

  it('reserveChildResume 拒绝名字已被占用与旧代父身份', () => {
    const sessions = index();
    sessions.prepareParent(parent);
    const metadata = {
      parentId: parent.sessionId,
      childGeneration: 'old-generation',
      agentTypeKey: 'builtin:scout' as const,
      agentInstanceId: '99999999-9999-4999-8999-999999999999',
      agentInstanceName: 'Scout · 9999',
      dispatchOrigin: 'typed-mention' as const,
    };
    expect(sessions.reserveChildResume(parent, metadata, 'resume-1').ok).toBe(true);
    // 同名重复恢复（并发/重入）→ 拒绝，不得换名降级
    expect(sessions.reserveChildResume(parent, metadata, 'resume-2').ok).toBe(false);
    const stale: SessionIdentity = { sessionId: parent.sessionId, generation: 'stale' };
    expect(sessions.reserveChildResume(stale, metadata, 'resume-3')).toMatchObject({
      ok: false,
      code: 'stale-parent',
    });
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

  it('工具直雇 coworker 的 coworker-update 带自身 identity 时入索引,用户 tab 可直接 prompt', () => {
    const sessions = index();
    sessions.prepareParent(parent);
    const coworkerIdentity: SessionIdentity = {
      sessionId: 'origin::cw-bob',
      generation: '44444444-4444-4444-8444-444444444444',
    };
    expect(
      sessions.observe({
        type: 'coworker-update',
        identity: parent,
        seq: 1,
        coworker: { id: 'origin::cw-bob', name: 'bob', status: 'idle', createdAt: 0 },
        coworkerIdentity,
      })
    ).toBe(true);
    expect(sessions.currentIdentity('origin::cw-bob')).toEqual(coworkerIdentity);
    expect(sessions.isReady(coworkerIdentity)).toBe(true);
  });

  it('工具直雇 coworker 被 dismiss 后从索引移除', () => {
    const sessions = index();
    sessions.prepareParent(parent);
    const coworkerIdentity: SessionIdentity = {
      sessionId: 'origin::cw-bob',
      generation: '44444444-4444-4444-8444-444444444444',
    };
    sessions.observe({
      type: 'coworker-update',
      identity: parent,
      seq: 1,
      coworker: { id: 'origin::cw-bob', name: 'bob', status: 'idle', createdAt: 0 },
      coworkerIdentity,
    });
    sessions.observe({
      type: 'coworker-update',
      identity: parent,
      seq: 2,
      coworker: { id: 'origin::cw-bob', name: 'bob', status: 'dismissed', createdAt: 0 },
    });
    expect(sessions.currentIdentity('origin::cw-bob')).toBeUndefined();
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
