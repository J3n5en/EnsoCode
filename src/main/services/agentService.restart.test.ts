import type { ChildSessionIdentity } from '@shared/builtinAgents';
import type { AgentControlContext, AgentControlSpawnRequest } from '@shared/types/agent';
import { describe, expect, it, vi } from 'vitest';
import { type AgentRunLedgerStore, parseAgentRunLedger } from './agentRunLedger';
import { AgentService, type AgentServiceOptions, type AgentServiceRuntime } from './agentService';

const parent = { sessionId: 'chat-1', generation: '11111111-1111-4111-8111-111111111111' };
const context: AgentControlContext = {
  owner: { ownerId: 'chat-1', projectId: 'project-1', kind: 'chatSession' },
  actor: {
    kind: 'agent',
    actorId: 'chat-1',
    ownerId: 'chat-1',
    projectId: 'project-1',
    identity: parent,
  },
};

/** 落盘再读回：台账条目要经得起真实文件格式的往返 */
function fileLikeLedger(): AgentRunLedgerStore {
  let saved = '{"runs":[]}';
  return {
    load: () => parseAgentRunLedger(JSON.parse(saved)),
    save: (entries) => {
      saved = JSON.stringify({ version: 1, runs: entries });
    },
  };
}

function setup(options: Partial<AgentServiceOptions> = {}) {
  let generation = 0;
  const children: ChildSessionIdentity[] = [];
  const nextChild = (agentId: string): ChildSessionIdentity => {
    const identity = {
      sessionId: `chat-1::cw-${agentId}`,
      generation: `22222222-2222-4222-8222-${String(++generation).padStart(12, '0')}`,
      parent,
      instanceId: agentId,
      instanceName: `cw-${agentId}`,
      typeKey: 'builtin:worker',
    } as ChildSessionIdentity;
    children.push(identity);
    return identity;
  };
  const runtime = {
    spawn: vi.fn(async ({ agentId }: { agentId: string }) => nextChild(agentId)),
    prompt: vi.fn(async () => ({ ok: true })),
    steer: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
    dismiss: vi.fn(async () => ({ ok: true })),
    resume: vi.fn(async ({ identity }: { identity: ChildSessionIdentity }) =>
      nextChild(identity.instanceId)
    ),
    retry: vi.fn(async () => ({ ok: true })),
  } satisfies AgentServiceRuntime;
  let id = 0;
  const service = new AgentService({
    runtime,
    randomUuid: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++id).padStart(12, '0')}`,
    now: () => id,
    ...options,
  });
  return { service, runtime, children };
}

const spawnRequest = (overrides: Partial<AgentControlSpawnRequest> = {}) => ({
  context,
  requestId: 'request-1',
  description: 'implement change',
  prompt: 'do the work',
  agentType: 'worker',
  model: 'provider/model-x',
  thinking: 'high' as const,
  ...overrides,
});

const checkpointOf = (
  child: ChildSessionIdentity,
  nextStep: 'model-request' | 'await-user' = 'model-request'
) => [{ sessionId: child.sessionId, generation: child.generation, nextStep }];

/**
 * 更新重启：worker 落下断点（含子会话）后退出，Main 随之退出；新 Main 读同一份台账与断点。
 * 返回新 Main 里的 AgentService，父会话就绪前什么都不做
 */
async function restartDuringRun(
  mode: 'task' | 'coworker' = 'task',
  nextStep: 'model-request' | 'await-user' = 'model-request',
  after: Partial<AgentServiceOptions> = {}
) {
  const ledger = fileLikeLedger();
  const before = setup({ ledger });
  const spawned = await before.service.spawn(spawnRequest({ mode }));
  if (!spawned.ok) throw new Error(spawned.error);
  const child = before.children[0];
  const checkpoint = checkpointOf(child, nextStep);
  before.service.noteRestartCheckpoint(checkpoint);
  before.service.observe({ type: 'worker-exited' });
  const notify = vi.fn();
  const next = setup({
    ledger,
    notify,
    restartCheckpoint: checkpoint,
    ...after,
  });
  return { ...next, notify, spawned: spawned.value, child, ledger };
}

describe('重启打断的子代理自动续跑', () => {
  it('task 停在模型请求前：父会话就绪后用原配置重开、同一 runId 续跑，结果照常交回父会话', async () => {
    const { service, runtime, notify, spawned, child } = await restartDuringRun();
    expect(service.restartInterruptedOwners()).toEqual(['chat-1']);
    expect(service.claimsRestartChild(child.sessionId)).toBe(true);

    service.recoverOwner(context);
    await vi.waitFor(() => expect(runtime.retry).toHaveBeenCalledTimes(1));
    // 重建的记录与原来一致：同一 agentId / 子会话 / 派发参数，同一 runId
    expect(runtime.resume).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: spawned.agentId,
        identity: expect.objectContaining({ sessionId: child.sessionId }),
        spawn: {
          description: 'implement change',
          agentType: 'worker',
          model: 'provider/model-x',
          thinking: 'high',
        },
      })
    );
    expect(runtime.retry).toHaveBeenCalledWith(
      expect.objectContaining({ runId: spawned.runId, agentId: spawned.agentId })
    );
    // 续跑期间不发「已中断」通知，Run 仍在跑
    expect(notify).not.toHaveBeenCalled();
    const waiting = service.wait({ context, requestId: 'w', runIds: [spawned.runId] });

    const resumed = runtime.resume.mock.results[0]!.value as Promise<ChildSessionIdentity>;
    service.observe({
      type: 'message-upsert',
      identity: await resumed,
      seq: 1,
      index: 3,
      message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] },
    } as never);
    service.observe({
      type: 'turn-completed',
      identity: await resumed,
      seq: 2,
      turnId: spawned.runId,
    } as never);
    await expect(waiting).resolves.toMatchObject({
      ok: true,
      value: { runs: [{ runId: spawned.runId, status: 'succeeded' }] },
    });
    await expect(
      service.report({ context, requestId: 'r', runId: spawned.runId })
    ).resolves.toMatchObject({ ok: true, value: { text: 'all done' } });
  });

  it('续跑不重发任务 prompt（已执行的工具留在会话里，不从头重做）；没人 wait 时完成通知照常发', async () => {
    const { service, runtime, notify, spawned } = await restartDuringRun();
    runtime.prompt.mockClear();
    service.recoverOwner(context);
    await vi.waitFor(() => expect(runtime.retry).toHaveBeenCalledTimes(1));
    expect(runtime.prompt).not.toHaveBeenCalled();
    const resumed = await (runtime.resume.mock.results[0]!.value as Promise<ChildSessionIdentity>);
    service.observe({
      type: 'turn-completed',
      identity: resumed,
      seq: 1,
      turnId: spawned.runId,
    } as never);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toContain(`runId ${spawned.runId}) succeeded`);
  });

  it('同一 Main 里换代重启（worker 换代、Main 不退）：同样续跑，不发中断通知', async () => {
    const notify = vi.fn();
    const { service, runtime, children } = setup({ notify });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.noteRestartCheckpoint(checkpointOf(children[0]));
    service.observe({ type: 'worker-exited' });
    service.recoverOwner(context);
    await vi.waitFor(() => expect(runtime.retry).toHaveBeenCalledTimes(1));
    expect(runtime.retry).toHaveBeenCalledWith(
      expect.objectContaining({ runId: spawned.value.runId })
    );
    // 只有派发时那一次 prompt：续跑不重发任务
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('子会话重开失败（会话文件损坏 / 模型不可用）：退回停放可 resume，告诉父会话原因与下一步', async () => {
    const { service, runtime, notify, spawned } = await restartDuringRun();
    runtime.resume.mockRejectedValueOnce(new Error('session file is corrupted'));
    service.recoverOwner(context);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][2]).toBe(true);
    expect(notify.mock.calls[0][1]).toContain('session file is corrupted');
    expect(notify.mock.calls[0][1]).toContain(`resume with agentId ${spawned.agentId}`);
    const list = await service.list({ context, requestId: 'l' });
    expect(list.ok && list.value.agents[0]?.status).toBe('parked');
    // 手动 resume 用同一份派发参数重开
    const resumed = await service.resume({ context, requestId: 'r', agentId: spawned.agentId });
    expect(resumed.ok).toBe(true);
    expect(runtime.resume).toHaveBeenLastCalledWith(
      expect.objectContaining({ spawn: expect.objectContaining({ model: 'provider/model-x' }) })
    );
  });

  it('已自动续跑满 3 次又被重启打断：不再续跑，停放并通知父会话', async () => {
    const ledger = fileLikeLedger();
    let current = setup({ ledger });
    const spawned = await current.service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    let child = current.children[0];
    for (let round = 0; round < 4; round++) {
      current.service.noteRestartCheckpoint(checkpointOf(child));
      current.service.observe({ type: 'worker-exited' });
      const checkpoint = checkpointOf(child);
      const notify = vi.fn();
      current = setup({ ledger, notify, restartCheckpoint: checkpoint });
      current.service.recoverOwner(context);
      if (round < 3) {
        await vi.waitFor(() => expect(current.runtime.retry).toHaveBeenCalledTimes(1));
        child = current.children[0];
        expect(notify).not.toHaveBeenCalled();
      } else {
        expect(current.runtime.resume).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][1]).toContain('3 times');
        expect(notify.mock.calls[0][1]).toContain(`resume with agentId ${spawned.value.agentId}`);
      }
    }
  });

  it('父会话已删除：直接结束，不报错，之后不再补通知', async () => {
    const { service, notify, ledger, child } = await restartDuringRun();
    expect(() => service.abandonOwner('chat-1')).not.toThrow();
    expect(service.restartInterruptedOwners()).toEqual([]);
    expect(service.claimsRestartChild(child.sessionId)).toBe(false);
    const again = setup({ ledger, notify });
    again.service.recoverOwner(context);
    expect(notify).not.toHaveBeenCalled();
  });

  it('等安全点超时：断点在 worker 收尾时才落、Main 退出前没记下，断点里有子会话就照样续跑，不报 restart-lost', async () => {
    const ledger = fileLikeLedger();
    const before = setup({ ledger });
    const spawned = await before.service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    const child = before.children[0];
    before.service.observe({ type: 'worker-exited' });
    const notify = vi.fn();
    const after = setup({ ledger, notify, restartCheckpoint: checkpointOf(child, 'await-user') });
    expect(after.service.claimsRestartChild(child.sessionId)).toBe(true);
    after.service.recoverOwner(context);
    await vi.waitFor(() => expect(after.runtime.retry).toHaveBeenCalledTimes(1));
    expect(after.runtime.retry).toHaveBeenCalledWith(
      expect.objectContaining({ runId: spawned.value.runId, agentId: spawned.value.agentId })
    );
    expect(notify).not.toHaveBeenCalled();
    const list = await after.service.list({ context, requestId: 'l' });
    expect(list.ok && list.value.agents.map((agent) => agent.agentId)).toEqual([
      spawned.value.agentId,
    ]);
  });

  it('重启时子会话没到安全点（断点里没有它）：照旧按中断通知，不自动续跑', async () => {
    const ledger = fileLikeLedger();
    const before = setup({ ledger });
    const spawned = await before.service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    before.service.observe({ type: 'worker-exited' });
    const notify = vi.fn();
    const after = setup({ ledger, notify, restartCheckpoint: [] });
    expect(after.service.claimsRestartChild(before.children[0].sessionId)).toBe(false);
    after.service.recoverOwner(context);
    expect(after.runtime.resume).not.toHaveBeenCalled();
    expect(notify.mock.calls[0][1]).toContain(`runId ${spawned.value.runId}`);
  });

  it('coworker 在执行时被打断：同样续跑原 Run；结束后仍可 send', async () => {
    const { service, runtime, notify, spawned } = await restartDuringRun('coworker');
    service.recoverOwner(context);
    await vi.waitFor(() => expect(runtime.retry).toHaveBeenCalledTimes(1));
    expect(runtime.retry).toHaveBeenCalledWith(expect.objectContaining({ runId: spawned.runId }));
    expect(notify).not.toHaveBeenCalled();
    const resumed = await (runtime.resume.mock.results[0]!.value as Promise<ChildSessionIdentity>);
    service.observe({
      type: 'turn-completed',
      identity: resumed,
      seq: 1,
      turnId: spawned.runId,
    } as never);
    const sent = await service.send({
      context,
      requestId: 's',
      agentId: spawned.agentId,
      message: 'next',
    });
    expect(sent).toMatchObject({ ok: true, value: { status: 'running' } });
  });

  it('coworker 重启时空闲：不续跑、不通知，子会话恢复后可 send', async () => {
    const ledger = fileLikeLedger();
    const before = setup({ ledger });
    const spawned = await before.service.spawn(spawnRequest({ mode: 'coworker' }));
    if (!spawned.ok) throw new Error(spawned.error);
    const child = before.children[0];
    before.service.observe({
      type: 'turn-completed',
      identity: child,
      seq: 1,
      turnId: spawned.value.runId,
    } as never);
    before.service.noteRestartCheckpoint(checkpointOf(child, 'await-user'));
    before.service.observe({ type: 'worker-exited' });
    const notify = vi.fn();
    const after = setup({ ledger, notify, restartCheckpoint: checkpointOf(child, 'await-user') });
    expect(after.service.restartInterruptedOwners()).toEqual([]);
    expect(after.service.claimsRestartChild(child.sessionId)).toBe(false);
    after.service.recoverOwner(context);
    expect(after.runtime.resume).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(after.service.adoptCoworker(context, { ...child, generation: 'new-gen' })).toBe(true);
    await expect(
      after.service.send({ context, requestId: 's', agentId: spawned.value.agentId, message: 'go' })
    ).resolves.toMatchObject({ ok: true });
  });

  it('#394 持有后台任务时被重启：子会话断点是等用户，同样走续跑（由 worker 把任务中断的消息交给它）', async () => {
    const { service, runtime, notify, spawned } = await restartDuringRun('task', 'await-user');
    service.recoverOwner(context);
    await vi.waitFor(() => expect(runtime.retry).toHaveBeenCalledTimes(1));
    expect(runtime.retry).toHaveBeenCalledWith(expect.objectContaining({ runId: spawned.runId }));
    expect(notify).not.toHaveBeenCalled();
  });

  it('冷启动后父会话还没就绪就被用户停止：台账里等续跑 / 等补通知的条目清掉，就绪后不续跑也不通知', async () => {
    for (const mode of ['task', 'coworker'] as const) {
      const { service, runtime, notify, spawned, child, ledger } = await restartDuringRun(mode);
      expect(service.claimsRestartChild(child.sessionId)).toBe(true);

      await service.cancelOwner('chat-1');

      expect(service.restartInterruptedOwners()).toEqual([]);
      expect(service.claimsRestartChild(child.sessionId)).toBe(false);
      expect(ledger.load().find((entry) => entry.runId === spawned.runId)).toMatchObject({
        notified: true,
      });
      expect(ledger.load()[0]?.restart).toBeUndefined();
      service.recoverOwner(context);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(runtime.resume).not.toHaveBeenCalled();
      expect(runtime.retry).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      // 再重启一次也不会复活
      const again = setup({ ledger, notify, restartCheckpoint: checkpointOf(child) });
      expect(again.service.restartInterruptedOwners()).toEqual([]);
      again.service.recoverOwner(context);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(again.runtime.retry).not.toHaveBeenCalled();
    }
  });

  it('等续跑期间用户停止父会话：不再自动续跑，task 停放可手动 resume，台账不留续跑记录', async () => {
    const ledger = fileLikeLedger();
    const notify = vi.fn();
    const { service, runtime, children } = setup({ ledger, notify });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.noteRestartCheckpoint(checkpointOf(children[0]));
    service.observe({ type: 'worker-exited' });

    await service.cancelOwner('chat-1');
    service.recoverOwner(context);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(runtime.retry).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(service.progress('chat-1')).toEqual([]);
    expect(ledger.load().find((entry) => entry.runId === spawned.value.runId)).toMatchObject({
      status: 'interrupted',
      notified: true,
    });
    expect(ledger.load()[0]?.restart).toBeUndefined();
    await expect(
      service.resume({ context, requestId: 'r', agentId: spawned.value.agentId })
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('父会话就绪前被用户停止', () => {
  it('同一 Main 里 worker 退出打断的 Run 等着补通知：用户先停止，父会话就绪后不再补通知唤醒它', async () => {
    const ledger = fileLikeLedger();
    const notify = vi.fn();
    const { service } = setup({ ledger, notify });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    service.observe({ type: 'worker-exited' });

    await service.cancelOwner('chat-1');
    service.recoverOwner(context);

    expect(notify).not.toHaveBeenCalled();
    expect(ledger.load()).toMatchObject([{ runId: spawned.value.runId, notified: true }]);
  });

  it('启动与重启续跑后：台账磁盘状态落盘为 running（不滞留 queued），且 hasRestartPendingOwner 准确识别续跑中的父会话', async () => {
    const ledger = fileLikeLedger();
    const { service, children } = setup({ ledger });
    const spawned = await service.spawn(spawnRequest());
    if (!spawned.ok) throw new Error(spawned.error);
    expect(ledger.load().find((entry) => entry.runId === spawned.value.runId)?.status).toBe(
      'running'
    );

    service.noteRestartCheckpoint(checkpointOf(children[0]));
    service.observe({ type: 'worker-exited' });

    const after = setup({ ledger, restartCheckpoint: checkpointOf(children[0]) });
    expect(after.service.hasRestartPendingOwner('chat-1')).toBe(true);
    expect(after.service.hasRestartPendingOwner('other-chat')).toBe(false);
    after.service.recoverOwner(context);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ledger.load().find((entry) => entry.runId === spawned.value.runId)?.status).toBe(
      'running'
    );
    expect(after.service.hasRestartPendingOwner('chat-1')).toBe(true);
  });
});
