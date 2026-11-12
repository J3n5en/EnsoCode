import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildSessionIdentity, SessionIdentity } from '@shared/builtinAgents';
import { describe, expect, it } from 'vitest';
import { AgentSessionIndex, MAX_ORIGIN_COWORKERS } from './agentSessionIndex';
import { listChildRuns } from './childRunCatalog';

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
  it('blocks starting, reserved and running workspace trees but allows idle children', () => {
    const sessions = index();
    expect(sessions.workspaceTreeRunning(parent.sessionId)).toBe(false);
    sessions.prepareParent(parent);
    expect(sessions.anyWorkspaceBusy()).toBe(true);
    expect(sessions.workspaceTreeRunning(parent.sessionId)).toBe(true);
    sessions.observe({
      type: 'parent-ready',
      identity: parent,
      seq: 1,
      sessionFile: '/tmp/a.jsonl',
      model: { providerId: 'p', modelId: 'm' },
    });
    expect(sessions.workspaceTreeRunning(parent.sessionId)).toBe(false);
    const reserved = sessions.reserveChild(parent, 'builtin:scout', 'Scout', 'request-1');
    expect(sessions.workspaceTreeRunning(parent.sessionId)).toBe(true);
    if (!reserved.ok) throw new Error('reservation failed');
    const child = reserved.reservation.child;
    sessions.observe(readyChild(child));
    expect(sessions.workspaceTreeRunning(parent.sessionId)).toBe(false);
    expect(sessions.workspaceRoot(child.sessionId)).toBe(parent.sessionId);
    sessions.observe({ type: 'status', identity: child, seq: 2, status: 'running' });
    expect(sessions.workspaceTreeRunning(parent.sessionId)).toBe(true);
    expect(sessions.workspaceTreeRunning('unrelated')).toBe(false);
    sessions.observe({ type: 'status', identity: child, seq: 3, status: 'idle' });
    expect(sessions.workspaceTreeRunning(parent.sessionId)).toBe(false);
    sessions.observe({ type: 'worker-exited' });
    expect(sessions.workspaceTreeRunning(parent.sessionId)).toBe(false);
  });
  it('runningRootSessionIds 只列自身在跑的父会话，不含子会话与空闲会话', () => {
    const sessions = index();
    const other: SessionIdentity = { sessionId: 'other', generation: parent.generation };
    for (const identity of [parent, other]) {
      sessions.prepareParent(identity);
      sessions.observe({
        type: 'parent-ready',
        identity,
        seq: 1,
        sessionFile: `/tmp/${identity.sessionId}.jsonl`,
        model: { providerId: 'p', modelId: 'm' },
      });
    }
    const reserved = sessions.reserveChild(other, 'builtin:scout', 'Scout', 'request-1');
    if (!reserved.ok) throw new Error('reservation failed');
    sessions.observe(readyChild(reserved.reservation.child));
    sessions.observe({
      type: 'status',
      identity: reserved.reservation.child,
      seq: 2,
      status: 'running',
    });
    expect(sessions.runningRootSessionIds()).toEqual([]);
    sessions.observe({ type: 'status', identity: parent, seq: 2, status: 'running' });
    expect(sessions.runningRootSessionIds()).toEqual([parent.sessionId]);
    sessions.observe({ type: 'worker-exited' });
    expect(sessions.runningRootSessionIds()).toEqual([]);
  });

  it('distinguishes preparing workers from ended identities for worktree rebuilds', () => {
    const sessions = index();
    expect(sessions.isAlive(parent.sessionId)).toBe(false);
    sessions.prepareParent(parent);
    expect(sessions.isAlive(parent.sessionId)).toBe(true);
    sessions.observe({ type: 'parent-ended', identity: parent, seq: 1, reason: 'released' });
    expect(sessions.currentIdentity(parent.sessionId)).toEqual(parent);
    expect(sessions.isAlive(parent.sessionId)).toBe(false);
  });

  it('手动只读响应不进入生命周期索引', () => {
    const sessions = index();
    const response = {
      type: 'session-reloaded' as const,
      requestId: 'reload-1',
      result: { ok: false as const, error: 'gone' },
    };
    expect(() => sessions.observe(response)).not.toThrow();
    expect(sessions.observe(response)).toBe(false);
  });

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

    // 会话已跑过（lastSeq 高）后 worker 拒绝（恒为 seq 0）：不得被单调守卫当重复丢掉
    expect(
      sessions.observe({ type: 'parent-rejected', identity: parent, seq: 0, reason: 'gone' })
    ).toBe(true);
    expect(sessions.isReady(parent)).toBe(false);
    sessions.prepareParent(parent);
    expect(sessions.observe(ready(1))).toBe(true);

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

  it('读取 settings 的 maxActiveCoworkers，脏值回落默认 5', () => {
    const withLimit = (value: unknown) =>
      new AgentSessionIndex({
        readSettings: () => ({ 'enso-settings': { state: { maxActiveCoworkers: value } } }),
        randomUuid: uuids(),
      });

    const two = withLimit(2);
    two.prepareParent(parent);
    expect(two.reserveChild(parent, 'builtin:worker', 'Worker', 'a').ok).toBe(true);
    expect(two.reserveChild(parent, 'builtin:worker', 'Worker', 'b').ok).toBe(true);
    expect(two.reserveChild(parent, 'builtin:worker', 'Worker', 'c')).toMatchObject({
      ok: false,
      code: 'capacity-reached',
    });

    const dirty = withLimit('nope');
    dirty.prepareParent(parent);
    const reserved = Array.from({ length: MAX_ORIGIN_COWORKERS }, (_, position) =>
      dirty.reserveChild(parent, 'builtin:worker', 'Worker', `fill-${position}`)
    );
    expect(reserved.every((result) => result.ok)).toBe(true);
    expect(dirty.reserveChild(parent, 'builtin:worker', 'Worker', 'overflow')).toMatchObject({
      ok: false,
      code: 'capacity-reached',
    });
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

  it('child-ready 写入子运行目录，同一 child 再次 ready 不重复', () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'enso-child-ready-'));
    const parentId = '11111111-1111-4111-8111-111111111111';
    const root: SessionIdentity = {
      sessionId: parentId,
      generation: '22222222-2222-4222-8222-222222222222',
    };
    const file = path.join(sessionDir, '2026-08-29T00-00-00-000Z_abc.jsonl');
    const open = () =>
      new AgentSessionIndex({
        readSettings: () => null,
        randomUuid: uuids(),
        sessionDir,
      });
    try {
      const first = open();
      first.prepareParent(root);
      first.observe({
        type: 'parent-ready',
        identity: root,
        seq: 1,
        sessionFile: path.join(sessionDir, 'parent.jsonl'),
        model: { providerId: 'p', modelId: 'm' },
      });
      const reserved = first.reserveChild(root, 'builtin:scout', 'Scout', 'request-1');
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;
      expect(
        first.observe({ ...readyChild(reserved.reservation.child), sessionFile: file, seq: 1 })
      ).toBe(true);
      expect(listChildRuns(sessionDir, parentId)).toEqual([
        expect.objectContaining({
          childId: reserved.reservation.child.sessionId,
          name: reserved.reservation.child.instanceName,
          agentType: 'builtin:scout',
          file: path.basename(file),
        }),
      ]);

      const second = open();
      second.prepareParent(root);
      const resumed = second.reserveChildResume(root, reserved.reservation.metadata, 'resume-1');
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(
        second.observe({ ...readyChild(resumed.reservation.child), sessionFile: file, seq: 1 })
      ).toBe(true);
      const lines = readFileSync(path.join(sessionDir, 'child-runs', `${parentId}.jsonl`), 'utf8')
        .trim()
        .split('\n');
      expect(lines).toHaveLength(1);
      expect(listChildRuns(sessionDir, parentId)).toHaveLength(1);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('预约时的任务标题写入子运行目录，coworker-update 先到也不会丢掉', () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'enso-child-title-'));
    const parentId = '11111111-1111-4111-8111-111111111111';
    const root: SessionIdentity = {
      sessionId: parentId,
      generation: '22222222-2222-4222-8222-222222222222',
    };
    const file = path.join(sessionDir, '2026-08-29T00-00-00-000Z_abc.jsonl');
    const sessions = new AgentSessionIndex({
      readSettings: () => null,
      randomUuid: uuids(),
      sessionDir,
    });
    try {
      sessions.prepareParent(root);
      const reserved = sessions.reserveChild(
        root,
        'builtin:scout',
        'exp-invite',
        'request-1',
        'agent-tool',
        'task',
        '探测邀请接口'
      );
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;
      const child = reserved.reservation.child;
      expect(
        sessions.observe({
          type: 'coworker-update',
          identity: root,
          seq: 1,
          coworker: {
            id: child.sessionId,
            name: child.instanceName,
            agentType: child.typeKey,
            status: 'idle',
            sessionFile: file,
            createdAt: 0,
          },
        })
      ).toBe(true);
      expect(listChildRuns(sessionDir, parentId)[0]).toMatchObject({
        name: child.instanceName,
        title: '探测邀请接口',
      });
      expect(sessions.observe({ ...readyChild(child), sessionFile: file, seq: 2 })).toBe(true);
      expect(listChildRuns(sessionDir, parentId)).toEqual([
        expect.objectContaining({ title: '探测邀请接口', file: path.basename(file) }),
      ]);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('带 sessionFile 的 coworker-update 写入同一份目录，重复更新不追加', () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'enso-coworker-run-'));
    const parentId = '11111111-1111-4111-8111-111111111111';
    const root: SessionIdentity = {
      sessionId: parentId,
      generation: '22222222-2222-4222-8222-222222222222',
    };
    const childId = `${parentId}::cw-bob`;
    const file = path.join(sessionDir, '2026-08-29T00-00-00-000Z_bob.jsonl');
    const sessions = new AgentSessionIndex({
      readSettings: () => null,
      randomUuid: uuids(),
      sessionDir,
    });
    try {
      sessions.prepareParent(root);
      const coworker = {
        id: childId,
        name: 'bob',
        agentType: 'worker',
        status: 'idle' as const,
        sessionFile: file,
        createdAt: 0,
      };
      expect(
        sessions.observe({
          type: 'coworker-update',
          identity: root,
          seq: 1,
          coworker,
          coworkerIdentity: {
            sessionId: childId,
            generation: '44444444-4444-4444-8444-444444444444',
          },
        })
      ).toBe(true);
      expect(listChildRuns(sessionDir, parentId)).toEqual([
        expect.objectContaining({
          childId,
          name: 'bob',
          agentType: 'worker',
          file: '2026-08-29T00-00-00-000Z_bob.jsonl',
        }),
      ]);
      sessions.observe({
        type: 'coworker-update',
        identity: root,
        seq: 2,
        coworker,
        coworkerIdentity: {
          sessionId: childId,
          generation: '44444444-4444-4444-8444-444444444444',
        },
      });
      expect(
        readFileSync(path.join(sessionDir, 'child-runs', `${parentId}.jsonl`), 'utf8')
          .trim()
          .split('\n')
      ).toHaveLength(1);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
