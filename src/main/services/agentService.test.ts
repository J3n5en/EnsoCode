import type { ChildSessionIdentity } from '@shared/builtinAgents';
import type {
  AgentControlContext,
  AgentControlSpawnRequest,
  AgentOwnerIdentity,
  AgentWorkerEvent,
} from '@shared/types/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunLedgerEntry, AgentRunLedgerStore } from './agentRunLedger';
import { AgentService, type AgentServiceOptions, type AgentServiceRuntime } from './agentService';

const owner: AgentOwnerIdentity = {
  ownerId: 'chat-1',
  projectId: 'project-1',
  kind: 'chatSession',
};
const context: AgentControlContext = {
  owner,
  actor: {
    kind: 'agent',
    actorId: 'chat-1',
    ownerId: owner.ownerId,
    projectId: owner.projectId,
    identity: {
      sessionId: 'chat-1',
      generation: '11111111-1111-4111-8111-111111111111',
    },
  },
};

function child(agentId: string, generation: string): ChildSessionIdentity {
  return {
    sessionId: `chat-1::agent-${agentId}`,
    generation,
    parent: context.actor.kind === 'agent' ? context.actor.identity : ({} as never),
    instanceId: agentId,
    instanceName: `agent-${agentId}`,
    typeKey: 'builtin:worker',
  };
}

function setup(options: Partial<AgentServiceOptions> = {}) {
  let generation = 0;
  const children: ChildSessionIdentity[] = [];
  const runtime: AgentServiceRuntime = {
    spawn: vi.fn(async ({ agentId }) => {
      const identity = child(
        agentId,
        `22222222-2222-4222-8222-${String(++generation).padStart(12, '0')}`
      );
      children.push(identity);
      return identity;
    }),
    prompt: vi.fn(async () => ({ ok: true })),
    steer: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
    dismiss: vi.fn(async () => ({ ok: true })),
    validate: vi.fn(async () => ({ ok: true, value: { accepted: true } })),
  };
  let id = 0;
  return {
    children,
    runtime,
    service: new AgentService({
      runtime,
      randomUuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++id).padStart(12, '0')}`,
      now: () => id,
      ...options,
    }),
  };
}

function spawnRequest(overrides: Partial<AgentControlSpawnRequest> = {}): AgentControlSpawnRequest {
  return {
    context,
    requestId: 'request-1',
    description: 'implement change',
    prompt: 'do the work',
    ...overrides,
  };
}

describe('AgentService lifecycle', () => {
  it('不注入 randomUuid 时默认 id 生成器可直接调用', async () => {
    // crypto.randomUUID 解绑后调用会抛 "Value of \"this\" must be of type Crypto"。
    const { runtime } = setup();
    const service = new AgentService({ runtime });
    const result = await service.spawn(spawnRequest());
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.agentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('同一父会话并行 spawn 不互相排队：子会话初始化可同时进行', async () => {
    const { service, runtime } = setup();
    const original = runtime.spawn;
    const releases: Array<() => void> = [];
    const spawn = vi.fn(
      (input: Parameters<AgentServiceRuntime['spawn']>[0]) =>
        new Promise<ChildSessionIdentity>((resolve) => {
          releases.push(() => resolve(original(input)));
        })
    );
    runtime.spawn = spawn;
    const first = service.spawn(spawnRequest());
    const second = service.spawn(spawnRequest({ requestId: 'request-2' }));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    for (const release of releases) release();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(new Set(results.map((result) => result.ok && result.value.agentId)).size).toBe(2);
  });

  it('spawn 默认 task + 异步，Agent 与 Run 使用独立稳定身份', async () => {
    const { service, runtime } = setup();
    const result = await service.spawn(spawnRequest());
    expect(result).toEqual({
      ok: true,
      value: {
        agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
        mode: 'task',
        status: 'running',
      },
    });
    expect(runtime.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
        prompt: 'do the work',
      })
    );
  });

  it('spawn 透传 seedContext 给 runtime.spawn', async () => {
    const { service, runtime } = setup();
    const result = await service.spawn(spawnRequest({ seedContext: 'prior_reads' }));
    expect(result.ok).toBe(true);
    expect(runtime.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ seedContext: 'prior_reads' })
    );
  });

  it('adopts a persisted agent-tool coworker by stable instanceId after Main restart', async () => {
    const { service, runtime } = setup();
    const restored = {
      sessionId: 'parent::cw-persisted-agent',
      generation: '99999999-9999-4999-8999-999999999999',
      parent: context.actor.kind === 'agent' ? context.actor.identity : ({} as never),
      instanceId: 'persisted-agent',
      instanceName: 'reviewer',
      typeKey: 'builtin:worker' as const,
    };
    expect(service.adoptCoworker(context, restored)).toBe(true);
    await expect(
      service.list({ context, requestId: 'list-restored', limit: 20 })
    ).resolves.toMatchObject({
      ok: true,
      value: { agents: [{ agentId: 'persisted-agent', status: 'ready' }] },
    });
    const sent = await service.message({
      context,
      requestId: 'after-restart',
      to: 'persisted-agent',
      text: 'continue',
    });
    expect(sent).toMatchObject({ ok: true, value: { agentId: 'persisted-agent' } });
    expect(runtime.prompt).toHaveBeenCalledWith(expect.objectContaining({ identity: restored }));
  });

  it('child-ended closes an adopted coworker that never started a run', async () => {
    const { service } = setup();
    const restored = {
      sessionId: 'parent::cw-persisted-agent',
      generation: '99999999-9999-4999-8999-999999999999',
      parent: context.actor.kind === 'agent' ? context.actor.identity : ({} as never),
      instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000099',
      instanceName: 'reviewer',
      typeKey: 'builtin:worker' as const,
    };
    expect(service.adoptCoworker(context, restored)).toBe(true);
    service.observe({
      type: 'child-ended',
      identity: restored,
      seq: 1,
      reason: 'dismissed',
    });
    await expect(
      service.list({ context, requestId: 'list-ended', limit: 20 })
    ).resolves.toMatchObject({
      ok: true,
      value: { agents: [{ agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000099', status: 'closed' }] },
    });
  });

  it('schema is included in the child prompt', async () => {
    const { service, runtime } = setup();
    const schema = { type: 'object', required: ['ok'] };
    await service.spawn(spawnRequest({ schema }));
    expect(runtime.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: [
          'do the work',
          '',
          'Return exactly one JSON value matching this schema:',
          JSON.stringify(schema),
        ].join('\n'),
      })
    );
  });

  it('rechecks terminal state after awaited steer delivery', async () => {
    const { service, runtime, children } = setup();
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    vi.mocked(runtime.steer).mockImplementationOnce(async () => {
      service.observe({
        type: 'turn-completed',
        identity: children[0],
        seq: 1,
        turnId: spawned.value.runId,
      });
      return { ok: true };
    });
    await expect(
      service.send({
        context,
        requestId: 'late-steer',
        agentId: spawned.value.agentId,
        message: 'more',
        delivery: 'steer',
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid-state' });
  });

  it('does not authorize sibling actors merely because they share an owner', async () => {
    const { service } = setup();
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    const siblingContext: AgentControlContext = {
      ...context,
      actor: {
        kind: 'agent',
        actorId: 'sibling',
        ownerId: owner.ownerId,
        projectId: owner.projectId,
        identity: child('sibling', '88888888-8888-4888-8888-888888888888'),
      },
    };
    await expect(
      service.report({
        context: siblingContext,
        requestId: 'sibling-read',
        runId: spawned.value.runId,
      })
    ).resolves.toMatchObject({ ok: false, code: 'other-owner' });
  });

  it('schema/gate 在完成后进入 validating，并以 Main runtime 结果结算报告', async () => {
    const { service, runtime, children } = setup();
    const spawned = await service.spawn(
      spawnRequest({ mode: 'coworker', schema: { type: 'object' }, gate: { commandRef: 'tests' } })
    );
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'message-upsert',
      identity: children[0],
      seq: 1,
      index: 0,
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: '{"accepted":true}' }],
        usage: { input: 12, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
    });
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: spawned.value.runId,
    });
    await vi.waitFor(() => expect(runtime.validate).toHaveBeenCalled());
    const report = await service.report({
      context,
      requestId: 'report-validation',
      runId: spawned.value.runId,
    });
    expect(report).toMatchObject({
      ok: true,
      value: {
        run: { status: 'succeeded' },
        value: { accepted: true },
        usage: { inputTokens: 12, outputTokens: 5 },
      },
    });
  });

  it('stop 可取消 validating，迟到的 gate 结果不能把 Run 改回成功', async () => {
    const { service, runtime, children } = setup();
    const deferred = Promise.withResolvers<{ ok: true; value: unknown }>();
    vi.mocked(runtime.validate!).mockReturnValueOnce(deferred.promise);
    const spawned = await service.spawn(
      spawnRequest({ mode: 'coworker', gate: { commandRef: 'tests' } })
    );
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 1,
      turnId: spawned.value.runId,
    });
    await vi.waitFor(() => expect(runtime.validate).toHaveBeenCalled());
    expect(
      await service.stop({ context, requestId: 'stop-validating', runId: spawned.value.runId })
    ).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    expect(vi.mocked(runtime.validate!).mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(runtime.stop).not.toHaveBeenCalled();
    deferred.resolve({ ok: true, value: { late: true } });
    await Promise.resolve();
    expect(
      await service.report({ context, requestId: 'late-report', runId: spawned.value.runId })
    ).toMatchObject({ ok: true, value: { run: { status: 'cancelled' } } });
  });

  it('running auto/steer 返回原 run；expectedRunId 不匹配时不投递', async () => {
    const { service, runtime } = setup();
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    const steered = await service.send({
      context,
      requestId: 'send-1',
      agentId: spawned.value.agentId,
      message: 'adjust it',
      delivery: 'auto',
      expectedRunId: spawned.value.runId,
    });
    expect(steered).toEqual({
      ok: true,
      value: {
        agentId: spawned.value.agentId,
        runId: spawned.value.runId,
        delivery: 'steer',
        status: 'running',
      },
    });
    expect(runtime.steer).toHaveBeenCalledTimes(1);
    const stale = await service.send({
      context,
      requestId: 'send-2',
      agentId: spawned.value.agentId,
      message: 'wrong run',
      expectedRunId: 'stale-run',
    });
    expect(stale).toMatchObject({ ok: false, code: 'run-mismatch' });
    expect(runtime.steer).toHaveBeenCalledTimes(1);
  });

  it('next 只给 coworker 排新 Run，当前 Run 完成后按序启动', async () => {
    const { children, service, runtime } = setup();
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    const queued = await service.send({
      context,
      requestId: 'send-next',
      agentId: spawned.value.agentId,
      message: 'second round',
      delivery: 'next',
    });
    expect(queued).toMatchObject({ ok: true, value: { delivery: 'next', status: 'queued' } });
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: spawned.value.runId,
    });
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(2));
  });

  it('wait 的 AbortSignal 只中断等待，不停止正在执行的 Run', async () => {
    const { service, runtime } = setup();
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    const abort = new AbortController();
    const waiting = service.wait(
      { context, requestId: 'wait-1', runIds: [spawned.value.runId] },
      abort.signal
    );
    abort.abort();
    expect(await waiting).toMatchObject({
      ok: true,
      value: { timedOut: false, interrupted: true },
    });
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.dismiss).not.toHaveBeenCalled();
  });

  it('worker 重建后 coworker 仅按同 owner+instanceId 绑定新 generation', async () => {
    const { service, runtime, children } = setup();
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({ type: 'worker-exited' });
    const replacement: ChildSessionIdentity = {
      ...children[0],
      generation: '99999999-9999-4999-8999-999999999999',
      parent: {
        ...children[0].parent,
        generation: '88888888-8888-4888-8888-888888888888',
      },
    };
    service.observe({ type: 'child-ready', identity: replacement } as never);
    await service.send({
      context,
      requestId: 'after-worker-restart',
      agentId: spawned.value.agentId,
      message: 'continue',
      delivery: 'next',
    });
    expect(runtime.prompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ identity: replacement })
    );
  });

  // 生产里子会话 instanceId 随机生成，与 agentId 不同；child-ready 会让 Main 调 adoptCoworker
  const instanceId = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
  const liveChild: ChildSessionIdentity = {
    ...child(instanceId, '22222222-2222-4222-8222-000000000001'),
    sessionId: `chat-1::cw-${instanceId}`,
  };
  const agentIds = async (service: AgentService) => {
    const listed = await service.list({ context, requestId: 'list-ids', limit: 20 });
    return listed.ok ? listed.value.agents.map((agent) => agent.agentId) : listed;
  };

  it('spawn 途中 child-ready 先触发 adopt 时不留幽灵记录，首个 Run 能正常结束', async () => {
    const { service, runtime } = setup();
    vi.mocked(runtime.spawn).mockImplementationOnce(async () => {
      service.adoptCoworker(context, liveChild);
      return liveChild;
    });
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'turn-completed',
      identity: liveChild,
      seq: 1,
      turnId: spawned.value.runId,
    });
    await expect(
      service.report({ context, requestId: 'report-first-run', runId: spawned.value.runId })
    ).resolves.toMatchObject({ ok: true, value: { run: { status: 'succeeded' } } });
    expect(await agentIds(service)).toEqual([spawned.value.agentId]);
  });

  it('spawn 之后同一子会话再次 child-ready 只更新原记录，不重复登记', async () => {
    const { service, runtime } = setup();
    vi.mocked(runtime.spawn).mockResolvedValueOnce(liveChild);
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({ type: 'worker-exited' });
    const replacement = { ...liveChild, generation: '99999999-9999-4999-8999-999999999999' };
    service.observe({ type: 'child-ready', identity: replacement } as never);
    expect(service.adoptCoworker(context, replacement)).toBe(true);
    expect(await agentIds(service)).toEqual([spawned.value.agentId]);
  });

  it('agentId 取子会话 instanceId：Main 重启后按 instanceId 认领，模型手里的 id 照样能用', async () => {
    const { service, runtime } = setup();
    vi.mocked(runtime.spawn).mockResolvedValueOnce(liveChild);
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    expect(spawned.value.agentId).toBe(instanceId);

    const restarted = setup().service;
    const resumed = { ...liveChild, generation: '99999999-9999-4999-8999-999999999999' };
    expect(restarted.adoptCoworker(context, resumed)).toBe(true);
    await expect(
      restarted.message({
        context,
        requestId: 'after-restart',
        to: spawned.value.agentId,
        text: 'continue',
      })
    ).resolves.toMatchObject({ ok: true, value: { agentId: instanceId } });
  });

  it('stop 只终止 Run 并保留 coworker；dismiss 关闭实例且幂等', async () => {
    const { service, runtime } = setup();
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    expect(
      await service.stop({ context, requestId: 'stop-1', runId: spawned.value.runId })
    ).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.dismiss).not.toHaveBeenCalled();
    const dismissed = {
      context,
      requestId: 'dismiss-1',
      agentId: spawned.value.agentId,
    };
    expect(await service.dismiss(dismissed)).toMatchObject({ ok: true });
    expect(await service.dismiss({ ...dismissed, requestId: 'dismiss-2' })).toMatchObject({
      ok: true,
    });
    expect(runtime.dismiss).toHaveBeenCalledTimes(1);
  });

  it('已 dismiss 的 coworker 遇到 worker 退出仍是 closed，不会被复活成 parked', async () => {
    const { service, runtime } = setup();
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    await service.dismiss({ context, requestId: 'dismiss', agentId: spawned.value.agentId });
    service.observe({ type: 'worker-exited' });
    const listed = await service.list({ context, requestId: 'list', limit: 10 });
    expect(listed).toMatchObject({
      ok: true,
      value: { agents: [{ agentId: spawned.value.agentId, status: 'closed' }] },
    });
    expect(
      await service.send({
        context,
        requestId: 'send-after-dismiss',
        agentId: spawned.value.agentId,
        message: 'again',
      })
    ).toMatchObject({ ok: false, code: 'invalid-state' });
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
  });

  it('stop 掉 task 唯一的 Run 后关闭实例并回收子会话，不留孤儿', async () => {
    const { service, runtime } = setup();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    expect(
      await service.stop({ context, requestId: 'stop-task', runId: spawned.value.runId })
    ).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.dismiss).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: spawned.value.agentId })
    );
    expect(
      await service.send({
        context,
        requestId: 'send-after-stop',
        agentId: spawned.value.agentId,
        message: 'again',
      })
    ).toMatchObject({ ok: false, code: 'invalid-state' });
    await service.dismiss({
      context,
      requestId: 'dismiss-after-stop',
      agentId: spawned.value.agentId,
    });
    expect(runtime.dismiss).toHaveBeenCalledTimes(1);
  });

  it('task stop 途中子会话先收尾时只回收一次', async () => {
    const { service, runtime, children } = setup();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    vi.mocked(runtime.stop).mockImplementationOnce(async () => {
      service.observe({
        type: 'turn-completed',
        identity: children[0],
        seq: 1,
        turnId: spawned.value.runId,
      });
      return { ok: true };
    });
    await service.stop({ context, requestId: 'stop-race', runId: spawned.value.runId });
    expect(runtime.dismiss).toHaveBeenCalledTimes(1);
  });

  it('owner/project/actor 不一致时在 runtime 前拒绝', async () => {
    const { service, runtime } = setup();
    const result = await service.spawn(
      spawnRequest({
        context: {
          ...context,
          owner: { ...owner, projectId: 'other-project' },
        },
      })
    );
    expect(result).toMatchObject({ ok: false, code: 'invalid-context' });
    expect(runtime.spawn).not.toHaveBeenCalled();
  });
});

describe('AgentService wait bounds and completion notify', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('不写时限的 wait 30 秒后超时返回进度，Run 继续跑', async () => {
    vi.useFakeTimers();
    const { service, runtime, children } = setup({ now: () => Date.now() });
    const spawned = await service.spawn(spawnRequest({ name: '数据核对' }));
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'message-upsert',
      identity: children[0],
      seq: 1,
      index: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'pnpm test' } },
        ],
      },
    });
    let settled = false;
    const waiting = service.wait({ context, requestId: 'w', runIds: [spawned.value.runId] });
    void waiting.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(30 * 1000 - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toMatchObject({
      ok: true,
      value: {
        timedOut: true,
        interrupted: false,
        pending: [
          {
            agentId: spawned.value.agentId,
            runId: spawned.value.runId,
            title: '数据核对',
            status: 'running',
            elapsedMs: 30 * 1000,
            activity: { phase: 'tool', tool: 'bash', detail: 'pnpm test' },
          },
        ],
      },
    });
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it('超过上限的时限截到 5 分钟', async () => {
    vi.useFakeTimers();
    const { service } = setup();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    let settled = false;
    const waiting = service.wait({
      context,
      requestId: 'w',
      runIds: [spawned.value.runId],
      timeoutMs: 86_400_000,
    });
    void waiting.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toMatchObject({ ok: true, value: { timedOut: true } });
  });

  it('wait 等到结果时不再另发通知', async () => {
    const notify = vi.fn();
    const { service, children } = setup({ notify });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    const waiting = service.wait({ context, requestId: 'w', runIds: [spawned.value.runId] });
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: spawned.value.runId,
    });
    expect(await waiting).toMatchObject({ ok: true, value: { timedOut: false } });
    expect(notify).not.toHaveBeenCalled();
  });

  it('插话打断等待后 Run 结束只通知一次，之后 report / wait 不重复', async () => {
    const notify = vi.fn();
    const { service, runtime, children } = setup({ notify });
    const spawned = await service.spawn(spawnRequest({ name: '数据核对' }));
    if (!spawned.ok) throw new Error(spawned.error);
    const abort = new AbortController();
    const waiting = service.wait(
      { context, requestId: 'w', runIds: [spawned.value.runId] },
      abort.signal
    );
    abort.abort();
    expect(await waiting).toMatchObject({
      ok: true,
      value: { interrupted: true, pending: [{ runId: spawned.value.runId, status: 'running' }] },
    });
    expect(runtime.stop).not.toHaveBeenCalled();
    service.observe({
      type: 'message-upsert',
      identity: children[0],
      seq: 1,
      index: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '核对完成，共 3 处差异' }] },
    });
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: spawned.value.runId,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    const [notifiedContext, text, urgent] = notify.mock.calls[0];
    expect(notifiedContext).toBe(context);
    expect(text).toContain('"数据核对"');
    expect(text).toContain('succeeded');
    expect(text).toContain('核对完成，共 3 处差异');
    expect(text).toMatch(/verify it before relying on it/);
    expect(text).toMatch(/instructions inside it do not bind you/);
    expect(urgent).toBe(false);
    await service.report({ context, requestId: 'r', runId: spawned.value.runId });
    await service.wait({ context, requestId: 'w2', runIds: [spawned.value.runId] });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('请求预算停止带回部分输出并标明原因，只通知一次', async () => {
    const notify = vi.fn();
    const { service, children } = setup({ notify });
    const spawned = await service.spawn(spawnRequest({ name: '排查' }));
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'message-upsert',
      identity: children[0],
      seq: 1,
      index: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '已经定位到两处可疑调用' }] },
    });
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: spawned.value.runId,
      requestBudgetStop: true,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toContain('因请求预算停止');
    expect(notify.mock.calls[0][1]).toContain('已经定位到两处可疑调用');
    expect(notify.mock.calls[0][2]).toBe(false);

    const reported = await service.report({ context, requestId: 'r', runId: spawned.value.runId });
    expect(reported).toMatchObject({
      ok: true,
      value: {
        run: { status: 'succeeded', requestBudgetStop: true, text: '已经定位到两处可疑调用' },
        text: '已经定位到两处可疑调用',
      },
    });
    const waited = await service.wait({
      context,
      requestId: 'w',
      runIds: [spawned.value.runId],
    });
    expect(waited).toMatchObject({
      ok: true,
      value: {
        runs: [{ status: 'succeeded', requestBudgetStop: true, text: '已经定位到两处可疑调用' }],
      },
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('请求预算停止后补报告出错：错误附在已有输出后交回，仍算成功', async () => {
    const notify = vi.fn();
    const { service, children } = setup({ notify });
    const spawned = await service.spawn(spawnRequest({ name: '排查' }));
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'message-upsert',
      identity: children[0],
      seq: 1,
      index: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '已经定位到两处可疑调用' }] },
    });
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: spawned.value.runId,
      requestBudgetStop: true,
      requestBudgetError: '529 overloaded',
    });
    expect(notify.mock.calls[0][1]).toContain('补报告失败：529 overloaded');
    const reported = await service.report({ context, requestId: 'r', runId: spawned.value.runId });
    expect(reported).toMatchObject({
      ok: true,
      value: {
        run: { status: 'succeeded', requestBudgetStop: true },
        text: '已经定位到两处可疑调用\n\n补报告失败：529 overloaded',
      },
    });
  });

  it('report 运行中的 Run：说明仍在运行、会自动通知，不要轮询', async () => {
    const { service } = setup();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    const reported = await service.report({ context, requestId: 'r', runId: spawned.value.runId });
    expect(reported).toMatchObject({ ok: false, code: 'invalid-state' });
    expect(!reported.ok && reported.error).toMatch(/still running/);
    expect(!reported.ok && reported.error).toMatch(/notified automatically/);
  });

  const completionOf = async (report: string, mode?: 'coworker') => {
    const notify = vi.fn();
    const { service, children } = setup({ notify });
    const spawned = await service.spawn(spawnRequest(mode ? { mode } : {}));
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'message-upsert',
      identity: children[0],
      seq: 1,
      index: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: report }] },
    });
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: spawned.value.runId,
    });
    return notify.mock.calls[0][1] as string;
  };

  it('完成通知超长时注明原长度与截断长度，并指向 report 取全文', async () => {
    const text = await completionOf('x'.repeat(5000));
    expect(text).toContain('cut from 5000 to its first 4000 characters');
    expect(text).not.toContain('x'.repeat(4001));
    expect(text).toMatch(/Use subagent report with runId \S+ for the full result\./);
  });

  it('完成通知已含全文时不提示 report，避免模型重复拉取', async () => {
    const text = await completionOf('x'.repeat(4000));
    expect(text).toContain('x'.repeat(4000));
    expect(text).not.toContain('cut from');
    expect(text).not.toContain('subagent report');
  });

  it('coworker 报告未截断时仍提示可 send 继续', async () => {
    const text = await completionOf('done', 'coworker');
    expect(text).not.toContain('subagent report');
    expect(text).toMatch(/To continue this coworker, use subagent send with agentId \S+\./);
  });

  it('完成通知附 usage：token 合计、工具调用数与耗时', async () => {
    const notify = vi.fn();
    let clock = 1_000;
    const { service, children } = setup({ notify, now: () => clock });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    const toolCall = (id: string) => ({ type: 'toolCall', id, name: 'read', arguments: {} });
    service.observe({
      type: 'message-upsert',
      identity: children[0],
      seq: 1,
      index: 1,
      message: {
        role: 'assistant',
        content: [toolCall('t1'), toolCall('t2')],
        usage: { input: 100, output: 20 },
      } as never,
    });
    // 同一条消息流式重发不重复计数
    service.observe({
      type: 'message-upsert',
      identity: children[0],
      seq: 2,
      index: 1,
      message: {
        role: 'assistant',
        content: [toolCall('t1'), toolCall('t2')],
        usage: { input: 100, output: 20 },
      } as never,
    });
    service.observe({
      type: 'message-upsert',
      identity: children[0],
      seq: 3,
      index: 3,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        usage: { input: 150, output: 30, cacheRead: 1000, cacheWrite: 0 },
      } as never,
    });
    clock = 4_500;
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 4,
      turnId: spawned.value.runId,
    });
    expect(notify.mock.calls[0][1]).toContain(
      '<usage>subagent_tokens: 1300\ntool_uses: 2\nduration_ms: 3500</usage>'
    );
  });

  it('失败的 Run 通知为紧急；模型自己 stop 的不通知', async () => {
    const notify = vi.fn();
    const { service, children } = setup({ notify });
    const failed = await service.spawn(spawnRequest());
    const stopped = await service.spawn(spawnRequest({ requestId: 'request-2' }));
    if (!failed.ok || !stopped.ok) throw new Error('spawn failed');
    service.observe({
      type: 'turn-failed',
      identity: children[0],
      seq: 2,
      turnId: failed.value.runId,
      error: 'model overloaded',
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toContain('model overloaded');
    expect(notify.mock.calls[0][2]).toBe(true);
    await service.stop({ context, requestId: 's', runId: stopped.value.runId });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('progress 只列该父会话未结束的 Run', async () => {
    const { service, children } = setup();
    const done = await service.spawn(spawnRequest({ name: 'done' }));
    const running = await service.spawn(spawnRequest({ requestId: 'request-2', name: 'running' }));
    if (!done.ok || !running.ok) throw new Error('spawn failed');
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: done.value.runId,
    });
    expect(service.progress('chat-1')).toEqual([
      expect.objectContaining({ runId: running.value.runId, title: 'running', status: 'running' }),
    ]);
    expect(service.progress('chat-2')).toEqual([]);
  });

  it('onProgress：Run 启动即推全量快照，消息带文本尾巴，结束推空快照', async () => {
    const onProgress = vi.fn();
    const { service, children } = setup({ onProgress });
    const spawned = await service.spawn(spawnRequest({ name: '核对' }));
    if (!spawned.ok) throw new Error(spawned.error);
    expect(onProgress).toHaveBeenLastCalledWith('chat-1', [
      expect.objectContaining({ runId: spawned.value.runId, title: '核对', status: 'running' }),
    ]);
    const text = `${'a'.repeat(300)}结论在末尾`;
    service.observe({
      type: 'message-upsert',
      identity: children[0],
      seq: 1,
      index: 1,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
    const [, runs] = onProgress.mock.calls.at(-1)!;
    expect(runs[0].text).toHaveLength(160);
    expect(runs[0].text.endsWith('结论在末尾')).toBe(true);
    expect(runs[0].activity).toEqual({ phase: 'writing' });
    const calls = onProgress.mock.calls.length;
    // 同样的内容重发不推
    service.observe({
      type: 'message-upsert',
      identity: children[0],
      seq: 2,
      index: 1,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
    expect(onProgress).toHaveBeenCalledTimes(calls);
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 3,
      turnId: spawned.value.runId,
    });
    expect(onProgress).toHaveBeenLastCalledWith('chat-1', []);
  });

  it('wait 超时回执的进度不带文本尾巴，避免模型借进度窥探中途结果', async () => {
    const { service, children } = setup();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'message-upsert',
      identity: children[0],
      seq: 1,
      index: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '半成品' }] },
    });
    const waited = await service.wait({
      context,
      requestId: 'w',
      runIds: [spawned.value.runId],
      timeoutMs: 0,
    });
    expect(waited.ok && waited.value.pending?.[0]).not.toHaveProperty('text');
    expect(service.progress('chat-1')[0].text).toBe('半成品');
  });

  it('until:all 等多个 Run：先结束的不单独通知，由 wait 回执一并交付', async () => {
    const notify = vi.fn();
    const { service, children } = setup({ notify });
    const a = await service.spawn(spawnRequest());
    const b = await service.spawn(spawnRequest({ requestId: 'request-2' }));
    if (!a.ok || !b.ok) throw new Error('spawn failed');
    const waiting = service.wait({
      context,
      requestId: 'w',
      runIds: [a.value.runId, b.value.runId],
      until: 'all',
    });
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: a.value.runId,
    });
    expect(notify).not.toHaveBeenCalled();
    service.observe({
      type: 'turn-completed',
      identity: children[1],
      seq: 2,
      turnId: b.value.runId,
    });
    expect(await waiting).toMatchObject({ ok: true, value: { timedOut: false } });
    expect(notify).not.toHaveBeenCalled();
  });

  it('until:all 等待中被插话打断：回执交付已结束的 Run，未结束的之后照常通知', async () => {
    const notify = vi.fn();
    const { service, children } = setup({ notify });
    const a = await service.spawn(spawnRequest());
    const b = await service.spawn(spawnRequest({ requestId: 'request-2' }));
    if (!a.ok || !b.ok) throw new Error('spawn failed');
    const detach = new AbortController();
    const waiting = service.wait(
      { context, requestId: 'w', runIds: [a.value.runId, b.value.runId], until: 'all' },
      detach.signal
    );
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: a.value.runId,
    });
    detach.abort('detach');
    expect(await waiting).toMatchObject({ ok: true, value: { interrupted: true } });
    expect(notify).not.toHaveBeenCalled();
    service.observe({
      type: 'turn-completed',
      identity: children[1],
      seq: 2,
      turnId: b.value.runId,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toContain(b.value.runId);
  });

  it('硬中断丢弃回执：已结束未交付的 Run 补发通知，不算已交付', async () => {
    const notify = vi.fn();
    const { service, children } = setup({ notify });
    const a = await service.spawn(spawnRequest());
    const b = await service.spawn(spawnRequest({ requestId: 'request-2' }));
    if (!a.ok || !b.ok) throw new Error('spawn failed');
    const abort = new AbortController();
    const waiting = service.wait(
      { context, requestId: 'w', runIds: [a.value.runId, b.value.runId], until: 'all' },
      abort.signal
    );
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: a.value.runId,
    });
    abort.abort('abort');
    await waiting;
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toContain(a.value.runId);
    service.observe({
      type: 'turn-completed',
      identity: children[1],
      seq: 2,
      turnId: b.value.runId,
    });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][1]).toContain(b.value.runId);
  });

  it('stop 途中 Run 自然结束而 stop 失败：补发通知', async () => {
    const notify = vi.fn();
    const { service, runtime, children } = setup({ notify });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    vi.mocked(runtime.stop).mockImplementationOnce(async () => {
      service.observe({
        type: 'turn-completed',
        identity: children[0],
        seq: 2,
        turnId: spawned.value.runId,
      });
      return { ok: false, error: 'child gone' };
    });
    const stopped = await service.stop({ context, requestId: 's', runId: spawned.value.runId });
    expect(stopped.ok).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toContain('succeeded');
  });
});

describe('AgentService 中断的 task 停放与续跑', () => {
  const listStatus = async (service: AgentService) => {
    const listed = await service.list({ context, requestId: 'list', limit: 20 });
    if (!listed.ok) throw new Error(listed.error);
    return listed.value.agents.map((agent) => agent.status);
  };

  function resumable(options: Partial<AgentServiceOptions> = {}) {
    const fixture = setup(options);
    let generation = 100;
    fixture.runtime.resume = vi.fn(async ({ identity }) => ({
      ...identity,
      generation: `33333333-3333-4333-8333-${String(++generation).padStart(12, '0')}`,
    }));
    fixture.runtime.retry = vi.fn(async () => ({ ok: true }));
    return fixture;
  }

  it('turn-failed 的 task 停放为 parked：释放子会话但不关闭，之后的 child-ended 不改状态', async () => {
    const notify = vi.fn();
    const { service, runtime, children } = resumable({ notify });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'turn-failed',
      identity: children[0],
      seq: 2,
      turnId: spawned.value.runId,
      error: 'network down',
      retryExhausted: true,
    });
    expect(await listStatus(service)).toEqual(['parked']);
    expect(runtime.dismiss).toHaveBeenCalledTimes(1);
    service.observe({ type: 'child-ended', identity: children[0], seq: 3, reason: 'dismissed' });
    expect(await listStatus(service)).toEqual(['parked']);
    expect(notify.mock.calls[0][1]).toContain(
      `subagent resume with agentId ${spawned.value.agentId}`
    );
  });

  it('worker 退出时在跑的 task 停放为 parked', async () => {
    const { service } = resumable();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({ type: 'worker-exited' });
    expect(await listStatus(service)).toEqual(['parked']);
  });

  it('正常完成与模型自己 stop 的 task 仍是 closed，不能 resume', async () => {
    const { service, runtime, children } = resumable();
    const done = await service.spawn(spawnRequest());
    const stopped = await service.spawn(spawnRequest({ requestId: 'request-2' }));
    if (!done.ok || !stopped.ok) throw new Error('spawn failed');
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: done.value.runId,
    });
    await service.stop({ context, requestId: 'stop', runId: stopped.value.runId });
    expect(await listStatus(service)).toEqual(['closed', 'closed']);
    for (const agentId of [done.value.agentId, stopped.value.agentId]) {
      expect(
        await service.resume({ context, requestId: `resume-${agentId}`, agentId })
      ).toMatchObject({ ok: false, code: 'invalid-state' });
    }
    expect(runtime.resume).not.toHaveBeenCalled();
  });

  it('resume 用原会话文件重开子会话并续跑未完成的回合，不新 spawn、不再发 prompt', async () => {
    const { service, runtime, children } = resumable();
    const spawned = await service.spawn(spawnRequest({ schema: { type: 'object' } }));
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({ type: 'worker-exited' });
    const resumed = await service.resume({
      context,
      requestId: 'resume-1',
      agentId: spawned.value.agentId,
    });
    if (!resumed.ok) throw new Error(resumed.error);
    expect(resumed.value).toMatchObject({
      agentId: spawned.value.agentId,
      mode: 'task',
      status: 'running',
    });
    expect(resumed.value.runId).not.toBe(spawned.value.runId);
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
    expect(runtime.resume).toHaveBeenCalledWith(
      expect.objectContaining({ identity: children[0], agentId: spawned.value.agentId })
    );
    const relaunched = await vi.mocked(runtime.resume!).mock.results[0].value;
    expect(runtime.retry).toHaveBeenCalledWith(
      expect.objectContaining({ identity: relaunched, runId: resumed.value.runId })
    );
    expect(await listStatus(service)).toEqual(['active']);
    service.observe({
      type: 'turn-completed',
      identity: relaunched,
      seq: 5,
      turnId: resumed.value.runId,
    });
    // 原 Run 的 schema 跟着续跑的 Run 走：完成后照样校验
    await vi.waitFor(async () =>
      expect(
        await service.report({ context, requestId: 'report', runId: resumed.value.runId })
      ).toMatchObject({ ok: true, value: { run: { status: 'succeeded' } } })
    );
    expect(runtime.validate).toHaveBeenCalledTimes(1);
    expect(await listStatus(service)).toEqual(['closed']);
  });

  it('子会话没留下会话文件时 resume 明确报错，保持 parked，不静默重开', async () => {
    const { service, runtime } = resumable();
    vi.mocked(runtime.resume!).mockRejectedValueOnce(
      new Error('The subagent stopped before its first reply was saved.')
    );
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({ type: 'worker-exited' });
    expect(
      await service.resume({ context, requestId: 'resume', agentId: spawned.value.agentId })
    ).toEqual({
      ok: false,
      code: 'runtime-unavailable',
      error: 'The subagent stopped before its first reply was saved.',
    });
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    expect(runtime.retry).not.toHaveBeenCalled();
    expect(await listStatus(service)).toEqual(['parked']);
  });

  it('续跑时 worker 回执没有可续的回合：按已完成收口', async () => {
    const { service, runtime } = resumable();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({ type: 'worker-exited' });
    const resumed = await service.resume({
      context,
      requestId: 'resume',
      agentId: spawned.value.agentId,
    });
    if (!resumed.ok) throw new Error(resumed.error);
    const relaunched = await vi.mocked(runtime.resume!).mock.results[0].value;
    service.observe({
      type: 'retry-skipped',
      identity: relaunched,
      seq: 2,
      reason: 'nothing-to-retry',
    });
    expect(
      await service.report({ context, requestId: 'report', runId: resumed.value.runId })
    ).toMatchObject({ ok: true, value: { run: { status: 'succeeded' } } });
  });

  it('续跑时没有可续的回合：交回中断前已写完的回复，不交空报告', async () => {
    const notify = vi.fn();
    const { service, runtime, children } = resumable({ notify });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'message-upsert',
      identity: children[0],
      seq: 1,
      index: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'final report' }] },
    });
    service.observe({ type: 'worker-exited' });
    const resumed = await service.resume({
      context,
      requestId: 'resume',
      agentId: spawned.value.agentId,
    });
    if (!resumed.ok) throw new Error(resumed.error);
    const relaunched = await vi.mocked(runtime.resume!).mock.results[0].value;
    service.observe({
      type: 'retry-skipped',
      identity: relaunched,
      seq: 2,
      reason: 'nothing-to-retry',
    });
    expect(
      await service.report({ context, requestId: 'report', runId: resumed.value.runId })
    ).toMatchObject({ ok: true, value: { run: { status: 'succeeded' }, text: 'final report' } });
    expect(notify.mock.calls.at(-1)?.[1]).toContain('final report');
  });

  it('停放中的 task 被原样再 spawn：拒绝并指向 resume；换了 prompt 或先 dismiss 才放行', async () => {
    const { service, runtime, children } = resumable();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'turn-failed',
      identity: children[0],
      seq: 2,
      turnId: spawned.value.runId,
      error: 'network down',
      retryExhausted: true,
    });
    const again = await service.spawn(spawnRequest({ requestId: 'request-2' }));
    expect(again).toMatchObject({ ok: false, code: 'invalid-state' });
    expect(!again.ok && again.error).toMatch(
      new RegExp(`"resume" with agentId ${spawned.value.agentId}`)
    );
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    const other = await service.spawn(
      spawnRequest({ requestId: 'request-3', prompt: 'other work' })
    );
    expect(other.ok).toBe(true);
    await service.dismiss({ context, requestId: 'dismiss', agentId: spawned.value.agentId });
    const fresh = await service.spawn(spawnRequest({ requestId: 'request-4' }));
    expect(fresh.ok).toBe(true);
  });

  it('resume 未知 agentId 报 not-found，coworker 报 invalid-state', async () => {
    const { service } = resumable();
    expect(await service.resume({ context, requestId: 'r', agentId: 'missing' })).toMatchObject({
      ok: false,
      code: 'not-found',
    });
    const coworker = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!coworker.ok) throw new Error(coworker.error);
    service.observe({ type: 'worker-exited' });
    expect(
      await service.resume({ context, requestId: 'r2', agentId: coworker.value.agentId })
    ).toMatchObject({ ok: false, code: 'invalid-state' });
  });

  it('app 退出窗口里的断连按可恢复中断停放', async () => {
    const { service, children } = resumable();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'turn-failed',
      identity: children[0],
      seq: 2,
      turnId: spawned.value.runId,
      error: 'terminated',
      interrupted: { at: 1, kind: 'quit' },
    });
    expect(await listStatus(service)).toEqual(['parked']);
  });

  it.each(['400 invalid request', '401 invalid api key', 'network down'])(
    '重试也没用的失败（%s，未标可恢复）照旧关闭：不停放、通知不提示 resume',
    async (error) => {
      const notify = vi.fn();
      const { service, runtime, children } = resumable({ notify });
      const spawned = await service.spawn(spawnRequest());
      if (!spawned.ok) throw new Error(spawned.error);
      service.observe({
        type: 'turn-failed',
        identity: children[0],
        seq: 2,
        turnId: spawned.value.runId,
        error,
      });
      expect(await listStatus(service)).toEqual(['closed']);
      expect(notify.mock.calls[0][1]).toContain(error);
      expect(notify.mock.calls[0][1]).not.toContain('resume');
      expect(
        await service.resume({ context, requestId: 'r', agentId: spawned.value.agentId })
      ).toMatchObject({ ok: false, code: 'invalid-state' });
      expect(runtime.resume).not.toHaveBeenCalled();
    }
  );

  /** 当前 Run 再被可恢复地打断一次（瞬态错误重试用尽） */
  const interruptActive = async (
    service: AgentService,
    runtime: ReturnType<typeof resumable>['runtime'],
    runId: string,
    resumes: number
  ) => {
    const identity =
      resumes === 0
        ? vi.mocked(runtime.spawn).mock.results[0].value
        : vi.mocked(runtime.resume!).mock.results[resumes - 1].value;
    service.observe({
      type: 'turn-failed',
      identity: await identity,
      seq: 10 + resumes,
      turnId: runId,
      error: 'socket hang up',
      retryExhausted: true,
    });
  };

  it('每个 task 最多 resume 3 次：再被打断就关闭并说明原因，resume 被拒', async () => {
    const notify = vi.fn();
    const { service, runtime } = resumable({ notify });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    let runId = spawned.value.runId;
    for (let resumes = 0; resumes < 3; resumes++) {
      await interruptActive(service, runtime, runId, resumes);
      expect(await listStatus(service)).toEqual(['parked']);
      const resumed = await service.resume({
        context,
        requestId: `resume-${resumes}`,
        agentId: spawned.value.agentId,
      });
      if (!resumed.ok) throw new Error(resumed.error);
      runId = resumed.value.runId;
    }
    await interruptActive(service, runtime, runId, 3);
    expect(await listStatus(service)).toEqual(['closed']);
    const last = notify.mock.calls.at(-1)?.[1] as string;
    expect(last).toContain('resumed 3 times');
    expect(last).not.toContain(`subagent resume with agentId`);
    const rejected = await service.resume({
      context,
      requestId: 'resume-4',
      agentId: spawned.value.agentId,
    });
    expect(rejected).toMatchObject({ ok: false, code: 'invalid-state' });
    expect(!rejected.ok && rejected.error).toContain('resumed 3 times');
    expect(runtime.resume).toHaveBeenCalledTimes(3);
  });

  it('续跑把之前各段已用的模型请求数交给 worker，请求预算接着累计', async () => {
    const { service, runtime, children } = resumable();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    const upsert = (identity: (typeof children)[0], index: number, role: string) =>
      service.observe({
        type: 'message-upsert',
        identity,
        seq: index,
        index,
        message: { role, content: [{ type: 'text', text: `m${index}` }] },
      } as AgentWorkerEvent);
    upsert(children[0], 1, 'assistant');
    upsert(children[0], 1, 'assistant'); // 同一条流式更新不重复计
    upsert(children[0], 2, 'toolResult');
    upsert(children[0], 3, 'assistant');
    service.observe({ type: 'worker-exited' });
    const first = await service.resume({
      context,
      requestId: 'r1',
      agentId: spawned.value.agentId,
    });
    if (!first.ok) throw new Error(first.error);
    expect(runtime.retry).toHaveBeenLastCalledWith(expect.objectContaining({ requestsUsed: 2 }));
    const relaunched = await vi.mocked(runtime.resume!).mock.results[0].value;
    upsert(relaunched, 5, 'assistant');
    service.observe({ type: 'worker-exited' });
    const second = await service.resume({
      context,
      requestId: 'r2',
      agentId: spawned.value.agentId,
    });
    if (!second.ok) throw new Error(second.error);
    expect(runtime.retry).toHaveBeenLastCalledWith(expect.objectContaining({ requestsUsed: 3 }));
  });

  it('续跑时子会话正忙（retry-skipped busy）：本次续跑报错收口、重新停放，不占 resume 次数', async () => {
    const notify = vi.fn();
    const { service, runtime } = resumable({ notify });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({ type: 'worker-exited' });
    const resumed = await service.resume({
      context,
      requestId: 'resume',
      agentId: spawned.value.agentId,
    });
    if (!resumed.ok) throw new Error(resumed.error);
    const relaunched = await vi.mocked(runtime.resume!).mock.results[0].value;
    service.observe({ type: 'retry-skipped', identity: relaunched, seq: 2, reason: 'busy' });
    expect(
      await service.report({ context, requestId: 'report', runId: resumed.value.runId })
    ).toMatchObject({ ok: true, value: { run: { status: 'failed' } } });
    expect(await listStatus(service)).toEqual(['parked']);
    expect(notify.mock.calls.at(-1)?.[1]).toContain('busy');
    for (let i = 0; i < 3; i++) {
      const again = await service.resume({
        context,
        requestId: `again-${i}`,
        agentId: spawned.value.agentId,
      });
      expect(again.ok).toBe(true);
      service.observe({ type: 'worker-exited' });
    }
  });
});

describe('AgentService 子代理起的后台任务', () => {
  it('结果里列出子代理起的后台任务，并说明归子代理、完成时不会通知父会话', async () => {
    const notify = vi.fn();
    const childTasks = vi.fn((sessionId: string) =>
      sessionId === 'chat-1::agent-aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
        ? [
            {
              taskId: 'task-1-a',
              command: 'pnpm dev\n--port 5173',
              status: 'running' as const,
              startedAt: 5,
            },
            {
              taskId: 'task-2-b',
              command: 'pnpm test',
              status: 'done' as const,
              exitCode: 0,
              startedAt: 6,
            },
            {
              taskId: 'task-0-old',
              command: 'old',
              status: 'done' as const,
              exitCode: 0,
              startedAt: 0,
            },
          ]
        : []
    );
    const { service, children } = setup({ notify, childTasks });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: spawned.value.runId,
    });
    const text = notify.mock.calls[0][1] as string;
    expect(text).toContain('task-1-a (running): pnpm dev --port 5173');
    expect(text).toContain('task-2-b (done, exit 0): pnpm test');
    expect(text).not.toContain('task-0-old');
    expect(text).toContain('belong to the subagent');
    expect(text).toContain('will not notify you');
  });

  it('子代理没起后台任务时结果不加这一段', async () => {
    const notify = vi.fn();
    const { service, children } = setup({ notify, childTasks: () => [] });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: spawned.value.runId,
    });
    expect(notify.mock.calls[0][1]).not.toContain('Background tasks');
  });

  it('回合带 awaitingTasks 结束时 Run 不收口；接上它的那一轮结束才收口，结果是后一轮的文本', async () => {
    const notify = vi.fn();
    const { service, children } = setup({ notify });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    const runId = spawned.value.runId;
    const say = (index: number, text: string) =>
      service.observe({
        type: 'message-upsert',
        identity: children[0],
        seq: index,
        index,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      });
    say(1, '服务已起，等它跑完');
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: runId,
      awaitingTasks: true,
    });
    expect(notify).not.toHaveBeenCalled();
    expect(service.progress('chat-1').map((run) => run.runId)).toEqual([runId]);

    say(3, '服务跑完了，结论是 X');
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 4,
      turnId: 'woken-turn',
      continues: runId,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    const text = notify.mock.calls[0][1] as string;
    expect(text).toContain('succeeded');
    expect(text).toContain('结论是 X');
    expect(text).not.toContain('等它跑完');
    expect(service.progress('chat-1')).toEqual([]);
  });
});

describe('AgentService 用户在子代理 tab 里停止', () => {
  const listStatus = async (service: AgentService) => {
    const listed = await service.list({ context, requestId: 'list', limit: 20 });
    if (!listed.ok) throw new Error(listed.error);
    return listed.value.agents.map((agent) => agent.status);
  };

  function fixture() {
    const notify = vi.fn();
    const onProgress = vi.fn();
    const value = setup({ notify, onProgress });
    let generation = 200;
    value.runtime.resume = vi.fn(async ({ identity }) => ({
      ...identity,
      generation: `44444444-4444-4444-8444-${String(++generation).padStart(12, '0')}`,
    }));
    value.runtime.retry = vi.fn(async () => ({ ok: true }));
    return { ...value, notify, onProgress };
  }

  const partial = (identity: ChildSessionIdentity, text: string): AgentWorkerEvent => ({
    type: 'message-upsert',
    identity,
    seq: 1,
    index: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

  const userStopped = (identity: ChildSessionIdentity, turnId: string): AgentWorkerEvent => ({
    type: 'turn-completed',
    identity,
    seq: 9,
    turnId,
    aborted: true,
  });

  it('task：Run 按用户停止收口、停放待 resume，父会话收到一次带部分输出的结果', async () => {
    const { service, children, notify, onProgress } = fixture();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe(partial(children[0], 'half done: checked a.ts'));
    service.observe(userStopped(children[0], spawned.value.runId));

    expect(await listStatus(service)).toEqual(['parked']);
    expect(service.progress(owner.ownerId)).toEqual([]);
    expect(onProgress).toHaveBeenLastCalledWith(owner.ownerId, []);
    expect(
      await service.report({ context, requestId: 'report', runId: spawned.value.runId })
    ).toMatchObject({ ok: true, value: { run: { status: 'interrupted' } } });
    expect(notify).toHaveBeenCalledTimes(1);
    const text = notify.mock.calls[0][1] as string;
    expect(text).toContain('interrupted');
    expect(text).toContain('用户在子代理的 tab 里停止了它');
    expect(text).toContain('half done: checked a.ts');
    expect(text).toContain(`subagent resume with agentId ${spawned.value.agentId}`);
    const waited = await service.wait({
      context,
      requestId: 'wait',
      runIds: [spawned.value.runId],
    });
    expect(waited).toMatchObject({ ok: true });
    expect(JSON.stringify(waited)).not.toContain('"running"');
  });

  it('task：停止后 resume 计入 3 次上限，用满后再被停止就关闭并说明', async () => {
    const { service, runtime, notify } = fixture();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    let runId = spawned.value.runId;
    let identity = await vi.mocked(runtime.spawn).mock.results[0].value;
    for (let resumes = 0; resumes < 3; resumes++) {
      service.observe(userStopped(identity, runId));
      expect(await listStatus(service)).toEqual(['parked']);
      const resumed = await service.resume({
        context,
        requestId: `resume-${resumes}`,
        agentId: spawned.value.agentId,
      });
      if (!resumed.ok) throw new Error(resumed.error);
      runId = resumed.value.runId;
      identity = await vi.mocked(runtime.resume!).mock.results[resumes].value;
    }
    service.observe(userStopped(identity, runId));
    expect(await listStatus(service)).toEqual(['closed']);
    const last = notify.mock.calls.at(-1)?.[1] as string;
    expect(last).toContain('resumed 3 times');
    expect(last).not.toContain('subagent resume with agentId');
  });

  it('重试倒计时中被停止（aborted 的 turn-failed）同样按用户停止停放', async () => {
    const { service, children, notify } = fixture();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'turn-failed',
      identity: children[0],
      seq: 3,
      turnId: spawned.value.runId,
      error: '529 overloaded',
      aborted: true,
    });
    expect(await listStatus(service)).toEqual(['parked']);
    expect(notify.mock.calls[0][1]).toContain('用户在子代理的 tab 里停止了它');
  });

  it('coworker：当前 Run 收口为中断，Agent 回到可用并接着跑排队的 Run', async () => {
    const { service, runtime, children, notify } = fixture();
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    const queued = await service.send({
      context,
      requestId: 'send',
      agentId: spawned.value.agentId,
      message: 'next job',
      delivery: 'next',
    });
    if (!queued.ok) throw new Error(queued.error);
    service.observe(userStopped(children[0], spawned.value.runId));
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledTimes(2));
    expect(
      await service.report({ context, requestId: 'report', runId: spawned.value.runId })
    ).toMatchObject({ ok: true, value: { run: { status: 'interrupted' } } });
    expect(notify.mock.calls[0][1]).toContain('用户在子代理的 tab 里停止了它');
    expect(await listStatus(service)).toEqual(['active']);
  });

  it('模型自己 subagent stop 时同一轮的中止回执不再按用户停止重复收口', async () => {
    const { service, runtime, children, notify } = fixture();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    vi.mocked(runtime.stop).mockImplementationOnce(async () => {
      service.observe(userStopped(children[0], spawned.value.runId));
      return { ok: true };
    });
    await service.stop({ context, requestId: 'stop', runId: spawned.value.runId });
    expect(
      await service.report({ context, requestId: 'report', runId: spawned.value.runId })
    ).toMatchObject({ ok: true, value: { run: { status: 'cancelled' } } });
    expect(await listStatus(service)).toEqual(['closed']);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('AgentService 找不到 Run / Agent 时说明原因', () => {
  /** 内存台账：同一份数据交给重启后的新 AgentService，模拟 Main 重启 */
  function memoryLedger() {
    let saved: AgentRunLedgerEntry[] = [];
    const store: AgentRunLedgerStore = {
      load: () => saved.map((entry) => ({ ...entry })),
      save: (entries) => {
        saved = entries.map((entry) => ({ ...entry }));
      },
    };
    return store;
  }

  const target = (runId: string) => ({ context, requestId: `t-${runId}`, runId });

  it('现场：coworker 在跑时更新重启，父会话回来后补一次中断通知，旧 runId 仍可 report / wait / stop', async () => {
    const ledger = memoryLedger();
    const before = setup({ ledger });
    const spawned = await before.service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    // 更新重启：worker 退出时父会话也没了，此刻不通知
    before.service.observe({ type: 'worker-exited' });

    const notify = vi.fn();
    const after = setup({ ledger, notify });
    after.service.recoverOwner(context);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toContain(`runId ${spawned.value.runId}`);
    expect(notify.mock.calls[0][1]).toContain(`send with agentId ${spawned.value.agentId}`);
    // 子会话恢复后 coworker 被重新认领
    expect(after.service.adoptCoworker(context, before.children[0])).toBe(true);
    const report = await after.service.report(target(spawned.value.runId));
    expect(report).toMatchObject({
      ok: true,
      value: { run: { runId: spawned.value.runId, status: 'interrupted' } },
    });
    expect(report.ok && report.value.error).toContain('restarted while this Run was in progress');
    await expect(
      after.service.wait({ context, requestId: 'w', runIds: [spawned.value.runId] })
    ).resolves.toMatchObject({ ok: true, value: { runs: [{ status: 'interrupted' }] } });
    await expect(after.service.stop(target(spawned.value.runId))).resolves.toMatchObject({
      ok: true,
      value: { status: 'interrupted' },
    });
    // 同一父会话再次就绪、或再重启一次，都不重复通知
    after.service.recoverOwner(context);
    const again = vi.fn();
    setup({ ledger, notify: again }).service.recoverOwner(context);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(again).not.toHaveBeenCalled();
  });

  it('没来得及收到 worker-exited 的崩溃式重启：在跑的 task 也补通知，并说明不能 resume、要重新派', async () => {
    const ledger = memoryLedger();
    const before = setup({ ledger });
    const spawned = await before.service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);

    const notify = vi.fn();
    const after = setup({ ledger, notify });
    after.service.recoverOwner(context);
    expect(notify.mock.calls[0][1]).toContain('cannot be resumed after a restart');
    const resumed = await after.service.resume({
      context,
      requestId: 'resume',
      agentId: spawned.value.agentId,
    });
    expect(resumed).toMatchObject({ ok: false, code: 'restart-lost' });
    expect(!resumed.ok && resumed.error).toContain('spawn a new subagent');
  });

  it('重启前已结束且已通知的 task：不再通知，旧 runId 的 report 说明结果正文不跨重启保留', async () => {
    const ledger = memoryLedger();
    const before = setup({ ledger });
    const spawned = await before.service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    before.service.observe({
      type: 'turn-completed',
      identity: before.children[0],
      seq: 1,
      turnId: spawned.value.runId,
    });

    const notify = vi.fn();
    const after = setup({ ledger, notify });
    after.service.recoverOwner(context);
    expect(notify).not.toHaveBeenCalled();
    const report = await after.service.report(target(spawned.value.runId));
    expect(report).toMatchObject({ ok: true, value: { run: { status: 'succeeded' } } });
    expect(report.ok && report.value.error).toContain('not kept across a restart');
  });

  it('同一 Main 里 worker 退出停放的 task：父会话重新就绪时补通知并指向 resume', async () => {
    const notify = vi.fn();
    const { service } = setup({ notify });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({ type: 'worker-exited' });
    expect(notify).not.toHaveBeenCalled();
    service.recoverOwner(context);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toContain(`resume with agentId ${spawned.value.agentId}`);
    service.recoverOwner(context);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('worker 退出时 coworker 排队的 Run 随在跑的一起中断，父会话就绪时一并补通知', async () => {
    const notify = vi.fn();
    const { service } = setup({ notify });
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    const queued = await service.send({
      context,
      requestId: 'queued',
      agentId: spawned.value.agentId,
      message: 'after that',
      delivery: 'next',
    });
    if (!queued.ok) throw new Error(queued.error);
    service.observe({ type: 'worker-exited' });
    expect(service.progress(owner.ownerId)).toEqual([]);
    service.recoverOwner(context);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toContain(`runId ${spawned.value.runId}`);
    expect(notify.mock.calls[0][1]).toContain(`runId ${queued.value.runId}`);
  });

  it('resume 换了新 runId 后，旧 runId 仍可 report / stop，不报 not-found', async () => {
    const { service, runtime, children } = setup();
    runtime.resume = vi.fn(async ({ identity }) => ({
      ...identity,
      generation: '55555555-5555-4555-8555-555555555555',
    }));
    runtime.retry = vi.fn(async () => ({ ok: true }));
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 1,
      turnId: spawned.value.runId,
      aborted: true,
    });
    const resumed = await service.resume({
      context,
      requestId: 'resume',
      agentId: spawned.value.agentId,
    });
    if (!resumed.ok) throw new Error(resumed.error);
    expect(resumed.value.runId).not.toBe(spawned.value.runId);
    await expect(service.report(target(spawned.value.runId))).resolves.toMatchObject({
      ok: true,
      value: { run: { status: 'interrupted' } },
    });
    await expect(service.stop(target(spawned.value.runId))).resolves.toMatchObject({
      ok: true,
      value: { status: 'interrupted' },
    });
  });

  it('agentId 与 runId 传反时指出类型错了', async () => {
    const { service } = setup();
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    const asRun = await service.report(target(spawned.value.agentId));
    expect(asRun).toMatchObject({ ok: false, code: 'not-found' });
    expect(!asRun.ok && asRun.error).toContain('is an agentId, not a runId');
    const asAgent = await service.dismiss({
      context,
      requestId: 'dismiss',
      agentId: spawned.value.runId,
    });
    expect(asAgent).toMatchObject({ ok: false, code: 'not-found' });
    expect(!asAgent.ok && asAgent.error).toContain(
      `is a runId, not an agentId; it belongs to agentId ${spawned.value.agentId}`
    );
  });

  it('别的会话（如 fork 出来的会话）拿父会话的 id：说明属于别的会话；重启后台账里的也一样', async () => {
    const ledger = memoryLedger();
    const { service } = setup({ ledger });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    const forked: AgentControlContext = {
      owner: { ...owner, ownerId: 'chat-fork' },
      actor: {
        kind: 'agent',
        actorId: 'chat-fork',
        ownerId: 'chat-fork',
        projectId: owner.projectId,
        identity: { sessionId: 'chat-fork', generation: '66666666-6666-4666-8666-666666666666' },
      },
    };
    const fromFork = { context: forked, requestId: 'fork', runId: spawned.value.runId };
    await expect(service.report(fromFork)).resolves.toMatchObject({
      ok: false,
      code: 'other-owner',
    });
    await expect(setup({ ledger }).service.report(fromFork)).resolves.toMatchObject({
      ok: false,
      code: 'other-owner',
    });
  });

  it('不存在的 id 说明可能抄错或编造，并引导 list', async () => {
    const { service } = setup();
    const result = await service.report(target('made-up-run'));
    expect(result).toMatchObject({ ok: false, code: 'not-found' });
    expect(!result.ok && result.error).toContain('mistyped or made up');
    expect(!result.ok && result.error).toContain('subagent list');
  });
});

describe('AgentService 父会话停止时级联停止子代理', () => {
  const otherOwner: AgentControlContext = {
    owner: { ...owner, ownerId: 'chat-2' },
    actor: {
      kind: 'agent',
      actorId: 'chat-2',
      ownerId: 'chat-2',
      projectId: owner.projectId,
      identity: { sessionId: 'chat-2', generation: '33333333-3333-4333-8333-333333333333' },
    },
  };

  it('停掉名下在跑的 task 与 coworker：按用户中止收口，task 停放可 resume，coworker 回到 ready，不另发通知', async () => {
    const notify = vi.fn();
    const { service, runtime } = setup({ notify });
    const task = await service.spawn(spawnRequest({ requestId: 'spawn-task' }));
    const coworker = await service.spawn(
      spawnRequest({ requestId: 'spawn-coworker', mode: 'coworker' })
    );
    if (!task.ok || !coworker.ok) throw new Error('spawn failed');

    await service.cancelOwner(owner.ownerId);

    expect(runtime.stop).toHaveBeenCalledTimes(2);
    expect(runtime.stop).toHaveBeenCalledWith(expect.objectContaining({ runId: task.value.runId }));
    expect(runtime.stop).toHaveBeenCalledWith(
      expect.objectContaining({ runId: coworker.value.runId })
    );
    const listed = await service.list({ context, requestId: 'list', limit: 10 });
    if (!listed.ok) throw new Error(listed.error);
    expect(
      Object.fromEntries(listed.value.agents.map((agent) => [agent.agentId, agent.status]))
    ).toEqual({ [task.value.agentId]: 'parked', [coworker.value.agentId]: 'ready' });
    expect(runtime.dismiss).toHaveBeenCalledTimes(1);
    expect(runtime.dismiss).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: task.value.agentId })
    );
    expect(service.progress(owner.ownerId)).toEqual([]);
    const report = await service.report({ context, requestId: 'r', runId: task.value.runId });
    expect(report).toMatchObject({
      ok: true,
      value: { run: { status: 'interrupted' }, error: expect.stringContaining('父会话') },
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('停止后父会话接着发消息：停掉的 task 能 resume，也能派新的子代理', async () => {
    const { service, runtime } = setup();
    runtime.resume = vi.fn(async ({ identity }) => identity);
    runtime.retry = vi.fn(async () => ({ ok: true }));
    const task = await service.spawn(spawnRequest());
    if (!task.ok) throw new Error(task.error);

    await service.cancelOwner(owner.ownerId);

    const resumed = await service.resume({
      context,
      requestId: 'resume',
      agentId: task.value.agentId,
    });
    expect(resumed).toMatchObject({ ok: true, value: { status: 'running' } });
    const fresh = await service.spawn(
      spawnRequest({ requestId: 'spawn-fresh', prompt: 'other work' })
    );
    expect(fresh).toMatchObject({ ok: true, value: { status: 'running' } });
  });

  it('停止时还在初始化的 spawn：回收子会话、不起 Run，之后的 spawn 照常', async () => {
    const notify = vi.fn();
    const { service, runtime } = setup({ notify });
    const create = vi.mocked(runtime.spawn).getMockImplementation()!;
    let finishSpawn!: () => void;
    vi.mocked(runtime.spawn).mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        finishSpawn = resolve;
      });
      return create(input);
    });
    const pending = service.spawn(spawnRequest());
    await Promise.resolve();

    await service.cancelOwner(owner.ownerId);
    finishSpawn();

    expect(await pending).toMatchObject({ ok: false });
    expect(runtime.prompt).not.toHaveBeenCalled();
    expect(runtime.dismiss).toHaveBeenCalledTimes(1);
    expect(service.progress(owner.ownerId)).toEqual([]);
    const listed = await service.list({ context, requestId: 'list', limit: 10 });
    expect(listed.ok && listed.value.agents).toEqual([]);
    const next = await service.spawn(spawnRequest({ requestId: 'spawn-next' }));
    expect(next).toMatchObject({ ok: true, value: { status: 'running' } });
    expect(notify).not.toHaveBeenCalled();
  });

  it('已结束的 Run 与别的父会话的 Run 不动', async () => {
    const { service, runtime, children } = setup();
    const done = await service.spawn(spawnRequest({ requestId: 'spawn-done' }));
    const foreign = await service.spawn(
      spawnRequest({ requestId: 'spawn-foreign', context: otherOwner })
    );
    if (!done.ok || !foreign.ok) throw new Error('spawn failed');
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: done.value.runId,
    });

    await service.cancelOwner(owner.ownerId);

    expect(runtime.stop).not.toHaveBeenCalled();
    expect(service.progress('chat-2')).toHaveLength(1);
  });

  it('coworker 排队的 Run 一并撤掉，不会在停掉当前 Run 后被拉起', async () => {
    const { service, runtime } = setup();
    const spawned = await service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    await service.send({
      context,
      requestId: 'send-next',
      agentId: spawned.value.agentId,
      message: 'second round',
      delivery: 'next',
    });

    await service.cancelOwner(owner.ownerId);

    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
    expect(service.progress(owner.ownerId)).toEqual([]);
  });

  it('在等这些 Run 的 wait 随之返回，不留孤儿等待', async () => {
    const { service } = setup();
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    const waiting = service.wait({ context, requestId: 'w', runIds: [spawned.value.runId] });

    await service.cancelOwner(owner.ownerId);

    expect(await waiting).toMatchObject({ ok: true, value: { timedOut: false } });
  });

  it('某个子会话停止失败或抛错：其余照停，Main 侧照样收口，整体不抛', async () => {
    const { service, runtime } = setup();
    const first = await service.spawn(spawnRequest({ requestId: 'spawn-1' }));
    const second = await service.spawn(spawnRequest({ requestId: 'spawn-2' }));
    const third = await service.spawn(spawnRequest({ requestId: 'spawn-3' }));
    if (!first.ok || !second.ok || !third.ok) throw new Error('spawn failed');
    vi.mocked(runtime.stop)
      .mockImplementationOnce(async () => {
        throw new Error('worker gone');
      })
      .mockImplementationOnce(async () => ({ ok: false, error: 'not running' }));

    await expect(service.cancelOwner(owner.ownerId)).resolves.toBeUndefined();

    expect(runtime.stop).toHaveBeenCalledTimes(3);
    expect(service.progress(owner.ownerId)).toEqual([]);
  });
});

describe('AgentService 父会话被释放（删除 / worktree 归档 / 移入 worktree）时收口子代理 Run', () => {
  function fileLedger() {
    let saved: AgentRunLedgerEntry[] = [];
    return {
      load: () => saved.map((entry) => ({ ...entry })),
      save: (entries: readonly AgentRunLedgerEntry[]) => {
        saved = entries.map((entry) => ({ ...entry }));
      },
    } satisfies AgentRunLedgerStore;
  }
  const parentEnded = {
    type: 'parent-ended',
    identity: context.actor.kind === 'agent' ? context.actor.identity : ({} as never),
    seq: 9,
    reason: 'released',
  } as AgentWorkerEvent;

  it('worker 拆掉子会话树后 Main 侧 Run 全部收口：wait 返回、不发通知、台账落终态', async () => {
    const notify = vi.fn();
    const ledger = fileLedger();
    const { service } = setup({ notify, ledger });
    const task = await service.spawn(spawnRequest({ requestId: 'spawn-task' }));
    const coworker = await service.spawn(
      spawnRequest({ requestId: 'spawn-coworker', mode: 'coworker' })
    );
    if (!task.ok || !coworker.ok) throw new Error('spawn failed');
    const waiting = service.wait({ context, requestId: 'w', runIds: [task.value.runId] });

    service.observe(parentEnded);

    expect(service.progress(owner.ownerId)).toEqual([]);
    expect(await waiting).toMatchObject({ ok: true, value: { timedOut: false } });
    expect(notify).not.toHaveBeenCalled();
    expect(ledger.load().map((entry) => entry.status)).toEqual(['interrupted', 'interrupted']);
    expect(ledger.load().every((entry) => entry.restart === undefined)).toBe(true);
  });

  it('会话被删除：台账记为已告知，冷启动不再叫醒它；删除先于 parent-ended 到达也一样', async () => {
    for (const order of ['released-first', 'removed-first'] as const) {
      const notify = vi.fn();
      const ledger = fileLedger();
      const { service } = setup({ notify, ledger });
      const task = await service.spawn(spawnRequest());
      if (!task.ok) throw new Error(task.error);

      if (order === 'released-first') service.observe(parentEnded);
      service.abandonOwner(owner.ownerId);
      if (order === 'removed-first') service.observe(parentEnded);

      expect(service.progress(owner.ownerId)).toEqual([]);
      expect(ledger.load()).toMatchObject([{ status: 'interrupted', notified: true }]);
      const next = setup({ ledger, notify });
      expect(next.service.restartInterruptedOwners()).toEqual([]);
      next.service.recoverOwner(context);
      expect(notify).not.toHaveBeenCalled();
    }
  });

  it('父会话之后回来（移入 worktree / 重启会话）：就绪时补告一次，task 可 resume', async () => {
    const notify = vi.fn();
    const { service, runtime } = setup({ notify });
    runtime.resume = vi.fn(async ({ identity }) => identity);
    runtime.retry = vi.fn(async () => ({ ok: true }));
    const task = await service.spawn(spawnRequest());
    if (!task.ok) throw new Error(task.error);

    service.observe(parentEnded);
    expect(notify).not.toHaveBeenCalled();
    service.recoverOwner(context);
    service.recoverOwner(context);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[1]).toContain(task.value.runId);
    await expect(
      service.resume({ context, requestId: 'r', agentId: task.value.agentId })
    ).resolves.toMatchObject({ ok: true });
  });

  it('释放时还在初始化的 spawn 不再起 Run', async () => {
    const { service, runtime } = setup();
    const create = vi.mocked(runtime.spawn).getMockImplementation()!;
    let finishSpawn!: () => void;
    vi.mocked(runtime.spawn).mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        finishSpawn = resolve;
      });
      return create(input);
    });
    const pending = service.spawn(spawnRequest());
    await Promise.resolve();

    service.observe(parentEnded);
    finishSpawn();

    expect(await pending).toMatchObject({ ok: false });
    expect(runtime.prompt).not.toHaveBeenCalled();
    expect(service.progress(owner.ownerId)).toEqual([]);
  });

  it('别的父会话被释放不影响本会话的 Run', async () => {
    const { service } = setup();
    const task = await service.spawn(spawnRequest());
    if (!task.ok) throw new Error(task.error);

    service.observe({
      ...parentEnded,
      identity: { sessionId: 'chat-2', generation: '33333333-3333-4333-8333-333333333333' },
    } as AgentWorkerEvent);

    expect(service.progress(owner.ownerId)).toHaveLength(1);
  });
});
