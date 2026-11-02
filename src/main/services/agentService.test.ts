import type { ChildSessionIdentity } from '@shared/builtinAgents';
import type {
  AgentControlContext,
  AgentControlSpawnRequest,
  AgentOwnerIdentity,
} from '@shared/types/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    ).resolves.toMatchObject({ ok: false, code: 'not-found' });
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

  it('完成通知超长时注明原长度与截断长度', async () => {
    const notify = vi.fn();
    const { service, children } = setup({ notify });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({
      type: 'message-upsert',
      identity: children[0],
      seq: 1,
      index: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(4000) }] },
    });
    service.observe({
      type: 'turn-completed',
      identity: children[0],
      seq: 2,
      turnId: spawned.value.runId,
    });
    const text = notify.mock.calls[0][1] as string;
    expect(text).toContain('cut from 4000 to its first 1500 characters');
    expect(text).not.toContain('x'.repeat(1501));
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
