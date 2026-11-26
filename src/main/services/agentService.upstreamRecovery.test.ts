import type { ChildSessionIdentity } from '@shared/builtinAgents';
import type { AgentControlContext, AgentControlSpawnRequest } from '@shared/types/agent';
import {
  QUOTA_MAX_WINDOW_MS,
  TRANSIENT_BACKOFF_MS,
  TRANSIENT_MAX_WINDOW_MS,
} from '@shared/upstreamRecovery';
import { describe, expect, it, vi } from 'vitest';
import { AgentService, type AgentServiceRuntime } from './agentService';
import { createUpstreamRecoveryService } from './upstreamRecovery';

const parent = {
  sessionId: 'chat-1',
  generation: '11111111-1111-4111-8111-111111111111',
};
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

function spawnReq(overrides: Partial<AgentControlSpawnRequest> = {}): AgentControlSpawnRequest {
  return {
    context,
    requestId: 'req-1',
    description: '测试子代理',
    prompt: 'do work',
    ...overrides,
  };
}

function createSetup() {
  let clock = 1_700_000_000_000;
  let seq = 0;
  const children: ChildSessionIdentity[] = [];
  const notify = vi.fn();
  const runtime: AgentServiceRuntime = {
    spawn: vi.fn(async (input) => {
      const child: ChildSessionIdentity = {
        sessionId: `${parent.sessionId}::agent-${input.agentId}`,
        generation: `22222222-2222-4222-8222-${String(++seq).padStart(12, '0')}`,
        parent,
        instanceId: input.agentId,
        instanceName: input.name ?? 'worker',
        typeKey: 'builtin:worker',
      };
      children.push(child);
      return child;
    }),
    prompt: vi.fn(async () => ({ ok: true })),
    steer: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
    dismiss: vi.fn(async () => ({ ok: true })),
    resume: vi.fn(async (input) => {
      const next: ChildSessionIdentity = {
        ...input.identity,
        generation: `22222222-2222-4222-8222-${String(++seq).padStart(12, '0')}`,
      };
      children.push(next);
      return next;
    }),
    retry: vi.fn(async () => ({ ok: true })),
  };

  let service!: AgentService;
  const recovery = createUpstreamRecoveryService({
    now: () => clock,
    random: () => 0,
    wakeConcurrency: 2,
    wakeBaseJitterMs: 0,
    wakeStaggerMs: 1_000,
    onWake(event) {
      if (event.waiter.kind === 'subagent') {
        void service.wakeUpstream(event.waiter.id);
      }
    },
  });

  service = new AgentService({
    runtime,
    notify,
    now: () => clock,
    upstreamRecovery: recovery,
  });

  return {
    service,
    runtime,
    recovery,
    children,
    notify,
    async advance(ms: number) {
      clock += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

describe('AgentService 子代理上游故障自动恢复', () => {
  it('瞬态 503 故障后进入等待不发假失败、上游恢复自动续跑且不消耗 3 次手动 resume 额度', async () => {
    vi.useFakeTimers();
    try {
      const { service, runtime, recovery, children, notify, advance } = createSetup();
      const spawned = await service.spawn(spawnReq());
      if (!spawned.ok) throw new Error(spawned.error);

      // 连续 4 次瞬态上游故障（超过 3 次手动 resume 限额！）
      for (let i = 0; i < 4; i++) {
        service.observe({
          type: 'turn-failed',
          identity: children[0]!,
          seq: i + 1,
          turnId: spawned.value.runId,
          error: '503 Service Unavailable: No available accounts',
          retryExhausted: true,
          provider: 'anthropic',
        });
        // 尚未通知父会话失败终态（等待通知只发一次，不含终态用词 " failed after"）
        const failureCalls = notify.mock.calls.filter((call) =>
          /\) failed after/.test(call[1] as string)
        );
        expect(failureCalls).toEqual([]);
        // 推进到下一次探测
        await advance(TRANSIENT_BACKOFF_MS[Math.min(i, TRANSIENT_BACKOFF_MS.length - 1)]!);
      }

      expect(runtime.retry).toHaveBeenCalledTimes(4);
      // 第 5 次探测成功
      service.observe({
        type: 'message-upsert',
        identity: children[0]!,
        seq: 10,
        index: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '全部完成' }] },
      });
      service.observe({
        type: 'turn-completed',
        identity: children[0]!,
        seq: 11,
        turnId: spawned.value.runId,
        provider: 'anthropic',
      });

      // 1 次等待通知 + 1 次完成通知
      expect(notify).toHaveBeenCalledTimes(2);
      const completion = notify.mock.calls.at(-1)![1] as string;
      expect(completion).toContain('succeeded');
      expect(completion).toContain('全部完成');
      expect(recovery.snapshots()).toEqual([]);
      recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('同 provider 外部会话成功时立即解锁等待中的子代理并自动续跑', async () => {
    vi.useFakeTimers();
    try {
      const { service, runtime, recovery, children, advance } = createSetup();
      const spawned = await service.spawn(spawnReq());
      if (!spawned.ok) throw new Error(spawned.error);

      service.observe({
        type: 'turn-failed',
        identity: children[0]!,
        seq: 1,
        turnId: spawned.value.runId,
        error: 'No available accounts',
        provider: 'openai',
      });
      expect(runtime.retry).not.toHaveBeenCalled();

      // 另一个同 provider 会话成功
      recovery.reportSuccess('openai', 'other-session');
      await advance(0);

      expect(runtime.retry).toHaveBeenCalledTimes(1);
      recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('等待上游恢复期间被 stop 或 cancelOwner 取消后，上游恢复绝不再续跑', async () => {
    vi.useFakeTimers();
    try {
      const { service, runtime, recovery, children, advance } = createSetup();
      const spawned = await service.spawn(spawnReq());
      if (!spawned.ok) throw new Error(spawned.error);

      service.observe({
        type: 'turn-failed',
        identity: children[0]!,
        seq: 1,
        turnId: spawned.value.runId,
        error: '502 Bad Gateway',
        provider: 'openai',
      });

      // 用户停止父会话
      await service.cancelOwner(parent.sessionId);
      expect(recovery.snapshots()).toEqual([]);

      // 就算随后上报 provider 恢复，也绝不 retry
      recovery.reportSuccess('openai', 'other');
      await advance(5 * 60_000);
      expect(runtime.retry).not.toHaveBeenCalled();
      recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('永久错误（401 / 403 IP blocked）立刻失败关闭，不进入上游等待', async () => {
    vi.useFakeTimers();
    try {
      const { service, recovery, children, notify } = createSetup();
      const spawned = await service.spawn(spawnReq());
      if (!spawned.ok) throw new Error(spawned.error);

      service.observe({
        type: 'turn-failed',
        identity: children[0]!,
        seq: 1,
        turnId: spawned.value.runId,
        error: '403 Forbidden: Your IP 203.0.113.42 has been recorded',
        provider: 'anthropic',
      });

      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]![1]).toContain('failed');
      expect(recovery.snapshots()).toEqual([]);
      recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('6 小时退避窗口耗尽后 park 交还父会话，且完整保留 3 次手动 resume 额度', async () => {
    vi.useFakeTimers();
    try {
      const { service, recovery, children, notify, advance } = createSetup();
      const spawned = await service.spawn(spawnReq());
      if (!spawned.ok) throw new Error(spawned.error);

      service.observe({
        type: 'turn-failed',
        identity: children[0]!,
        seq: 1,
        turnId: spawned.value.runId,
        error: '503 No available accounts',
        provider: 'anthropic',
      });

      await advance(TRANSIENT_MAX_WINDOW_MS + 1_000);

      service.observe({
        type: 'turn-failed',
        identity: children[0]!,
        seq: 2,
        turnId: spawned.value.runId,
        error: '503 No available accounts',
        provider: 'anthropic',
      });

      const calls = notify.mock.calls.map((call) => call[1] as string);
      expect(calls.some((text) => text.includes('failed'))).toBe(true);
      // 窗口耗尽后仍可手动 resume（说明没消耗 3 次额度）
      for (let i = 0; i < 3; i++) {
        const resumed = await service.resume({
          context,
          requestId: `res-${i}`,
          agentId: spawned.value.agentId,
        });
        expect(resumed.ok).toBe(true);
        if (!resumed.ok) throw new Error(resumed.error);
        service.observe({
          type: 'turn-failed',
          identity: children.at(-1)!,
          seq: 20 + i,
          turnId: resumed.value.runId,
          error: 'aborted by user',
          aborted: true,
        });
      }
      recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('进入上游等待时立即通知父会话：说明故障、会自动续跑、不需要等', async () => {
    vi.useFakeTimers();
    try {
      const { service, recovery, children, notify } = createSetup();
      const spawned = await service.spawn(spawnReq());
      if (!spawned.ok) throw new Error(spawned.error);

      service.observe({
        type: 'turn-failed',
        identity: children[0]!,
        seq: 1,
        turnId: spawned.value.runId,
        error: '429 insufficient_quota: exceeded your current quota',
        provider: 'anthropic',
      });

      // 进入等待而非失败：父会话必须立刻知情，否则会傻等一个不会来的完成通知
      expect(notify).toHaveBeenCalledTimes(1);
      const [contextArg, text, urgent] = notify.mock.calls[0]!;
      expect(contextArg).toMatchObject({ owner: { ownerId: 'chat-1' } });
      expect(text).toContain(spawned.value.runId);
      expect(text).toContain('quota');
      expect(urgent).toBe(false);
      // 不是终态失败通知：不应谎称 succeeded/failed
      expect(text).not.toContain('succeeded');
      recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('配额错误进入等待后，wait 超时回执的 pending 进度带 upstreamWaiting', async () => {
    vi.useFakeTimers();
    try {
      const { service, recovery, children, advance } = createSetup();
      const spawned = await service.spawn(spawnReq());
      if (!spawned.ok) throw new Error(spawned.error);

      service.observe({
        type: 'turn-failed',
        identity: children[0]!,
        seq: 1,
        turnId: spawned.value.runId,
        error: 'insufficient_quota',
        provider: 'anthropic',
      });

      const waitPromise = service.wait(
        {
          context,
          requestId: 'wait-1',
          runIds: [spawned.value.runId],
          until: 'all',
          timeoutMs: 1_000,
        },
        undefined
      );
      await advance(1_100);
      const waited = await waitPromise;
      expect(waited.ok).toBe(true);
      if (!waited.ok) return;
      expect(waited.value.timedOut).toBe(true);
      const pending = waited.value.pending;
      expect(pending).toBeDefined();
      const entry = pending!.find((run) => run.runId === spawned.value.runId);
      expect(entry?.upstreamWaiting).toMatchObject({
        provider: 'anthropic',
        errorKind: 'quota',
      });
      expect(typeof entry?.upstreamWaiting?.nextAt).toBe('number');
      recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('quota 24 小时窗口耗尽后的失败通知说明自动恢复已放弃', async () => {
    vi.useFakeTimers();
    try {
      const { service, recovery, children, notify, advance } = createSetup();
      const spawned = await service.spawn(spawnReq());
      if (!spawned.ok) throw new Error(spawned.error);

      service.observe({
        type: 'turn-failed',
        identity: children[0]!,
        seq: 1,
        turnId: spawned.value.runId,
        error: 'insufficient_quota',
        provider: 'anthropic',
      });

      // 推进到配额窗口耗尽之后再失败一次（探测依旧撞配额）
      await advance(QUOTA_MAX_WINDOW_MS + 1_000);
      service.observe({
        type: 'turn-failed',
        identity: children[0]!,
        seq: 2,
        turnId: spawned.value.runId,
        error: 'insufficient_quota',
        provider: 'anthropic',
      });

      const failureCall = notify.mock.calls.find((call) => (call[1] as string).includes('failed'));
      expect(failureCall).toBeDefined();
      // 失败文案要让父会话知道：不是第一次失败，是自动恢复已经放弃
      expect((failureCall![1] as string).toLowerCase()).toMatch(/quota|恢复|recovery|retry|重试/);
      recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
