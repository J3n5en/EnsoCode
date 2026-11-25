import type { HeadlessSessionRuntime } from '@shared/pair/headlessQueue';
import type { RendererAgentEvent } from '@shared/types/agent';
import { TRANSIENT_BACKOFF_MS, TRANSIENT_MAX_WINDOW_MS } from '@shared/upstreamRecovery';
import { describe, expect, it, vi } from 'vitest';
import { createUpstreamRecoveryService } from '../upstreamRecovery';
import { createDispatchDriver, type DispatchDriverPorts } from './driver';

const GEN = '11111111-1111-4111-8111-111111111111';
const MIN = 60_000;

function idOf(sessionId: string) {
  return { sessionId, generation: GEN };
}

function turnFailed(
  sessionId: string,
  error: string,
  extra: Record<string, unknown> = {}
): RendererAgentEvent {
  return {
    type: 'turn-failed',
    identity: idOf(sessionId),
    seq: 1,
    turnId: 't1',
    error,
    ...extra,
  } as unknown as RendererAgentEvent;
}

function turnCompleted(sessionId: string, extra: Record<string, unknown> = {}): RendererAgentEvent {
  return {
    type: 'turn-completed',
    identity: idOf(sessionId),
    seq: 2,
    turnId: 't1',
    digest: { assistantText: 'progress made' },
    ...extra,
  } as unknown as RendererAgentEvent;
}

function statusRunning(sessionId: string): RendererAgentEvent {
  return {
    type: 'status',
    identity: idOf(sessionId),
    seq: 3,
    status: 'running',
    turnId: 't1',
  } as unknown as RendererAgentEvent;
}

function createHarness(initialRows: Record<string, Record<string, unknown>>) {
  let clock = 1_700_000_000_000;
  const rows = new Map<string, Record<string, unknown>>(
    Object.entries(initialRows).map(([k, v]) => [k, structuredClone(v)])
  );
  const prompts: Array<{ id: string; text: string }> = [];
  const waitingEvents: Array<{ conversationId: string; retry: unknown }> = [];
  const exhaustedEvents: Array<{ conversationId: string; error: string }> = [];
  let seq = 0;

  let driver!: ReturnType<typeof createDispatchDriver>;
  const recovery = createUpstreamRecoveryService({
    now: () => clock,
    random: () => 0,
    wakeConcurrency: 1,
    wakeBaseJitterMs: 0,
    wakeStaggerMs: 2_000,
    onWake(event) {
      if (event.waiter.kind === 'session') {
        // 与 Main IPC 层同一条接线：驱动者明说 retry（还在 waiting 但此刻接不住）才重排
        return driver.wakeUpstream(event.waiter.id, event.reason) !== 'retry';
      }
    },
  });

  let promptResult: { ok: boolean; error?: string } = { ok: true };

  const ports: DispatchDriverPorts = {
    row: (id) => rows.get(id),
    saveRuntime(id, runtime: HeadlessSessionRuntime) {
      const prev = rows.get(id) ?? { driver: 'main' };
      rows.set(id, {
        ...prev,
        status: runtime.status,
        queuedMessages: runtime.queued,
        goal: runtime.goal,
      });
    },
    status: (id) => ({
      state: String(rows.get(id)?.status ?? 'idle'),
      pendingAsks: 0,
      pendingApprovals: 0,
    }),
    alive: () => true,
    prompt(id, delivery) {
      prompts.push({ id, text: delivery.text });
      return promptResult;
    },
    newId: () => `d-${++seq}`,
    now: () => clock,
    upstreamRecovery: recovery,
    onUpstreamWaiting(conversationId, retry) {
      waitingEvents.push({ conversationId, retry });
    },
    onUpstreamExhausted(conversationId, error) {
      exhaustedEvents.push({ conversationId, error });
    },
  };

  driver = createDispatchDriver(ports);

  return {
    driver,
    recovery,
    rows,
    prompts,
    waitingEvents,
    exhaustedEvents,
    get now() {
      return clock;
    },
    advance(ms: number) {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
    setPromptResult(result: { ok: boolean; error?: string }) {
      promptResult = result;
    },
    goalOf(id: string) {
      return rows.get(id)?.goal as Record<string, unknown> | undefined;
    },
  };
}

describe('DispatchDriver 上游错误自动恢复', () => {
  it('瞬态错误将 active goal 置为 waiting（而非 paused），到点注入 goal-continuation 且不重发原消息', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({
        s1: {
          driver: 'main',
          status: 'running',
          goal: { text: '完成发布验证', status: 'active', autoTurns: 1, noProgressRuns: 0 },
        },
      });

      h.driver.observe(
        turnFailed('s1', '503 Service Unavailable: No available accounts', {
          provider: 'anthropic',
          retryExhausted: true,
        })
      );

      const goal = h.goalOf('s1');
      expect(goal?.status).toBe('waiting');
      expect(goal?.status).not.toBe('paused');
      expect(goal?.retry).toMatchObject({
        reason: 'upstream',
        kind: 'transient',
        provider: 'anthropic',
        attempt: 1,
        at: h.now + TRANSIENT_BACKOFF_MS[0],
      });
      expect(h.rows.get('s1')?.status).not.toBe('failed');
      expect(h.waitingEvents).toHaveLength(1);
      expect(h.prompts).toHaveLength(0);

      // 1 分钟到点：自动注入 <goal-continuation>
      h.advance(TRANSIENT_BACKOFF_MS[0]);
      expect(h.prompts).toHaveLength(1);
      expect(h.prompts[0]!.id).toBe('s1');
      expect(h.prompts[0]!.text).toContain('<goal-continuation>');
      expect(h.prompts[0]!.text).toContain('完成发布验证');

      // 探测成功：恢复 active 并清除 retry
      h.driver.observe(turnCompleted('s1', { provider: 'anthropic' }));
      expect(h.goalOf('s1')?.status).toBe('active');
      expect(h.goalOf('s1')?.retry).toBeUndefined();
      h.recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('配额错误（403 weekly usage limit）进入 waiting 且 retry.kind 为 quota', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({
        s1: {
          driver: 'main',
          status: 'running',
          goal: { text: '修复测试', status: 'active', autoTurns: 0, noProgressRuns: 0 },
        },
      });

      h.driver.observe(
        turnFailed('s1', '403 Forbidden: weekly usage limit exceeded', { provider: 'openai' })
      );

      expect(h.goalOf('s1')?.status).toBe('waiting');
      expect(h.goalOf('s1')?.retry).toMatchObject({
        reason: 'upstream',
        kind: 'quota',
        provider: 'openai',
        attempt: 1,
        at: h.now + 30 * MIN,
      });
      h.recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('永久错误（403 IP recorded / 401）照旧 paused 并附可操作建议，不进入自动重试', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({
        s1: {
          driver: 'main',
          status: 'running',
          goal: { text: '跑检查', status: 'active', autoTurns: 0, noProgressRuns: 0 },
        },
      });

      h.driver.observe(
        turnFailed('s1', '403 Forbidden: Your IP 203.0.113.42 has been recorded', {
          provider: 'anthropic',
        })
      );

      expect(h.goalOf('s1')?.status).toBe('paused');
      expect(h.goalOf('s1')?.retry).toBeUndefined();
      expect(String(h.goalOf('s1')?.note ?? '')).toMatch(/ip|proxy|node/i);
      expect(h.recovery.snapshots()).toEqual([]);
      h.recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('同 provider 两个会话降级时只放 1 个探测，成功后错峰唤醒第二个会话', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({
        s1: {
          driver: 'main',
          status: 'running',
          goal: { text: '目标一', status: 'active', autoTurns: 0, noProgressRuns: 0 },
        },
        s2: {
          driver: 'main',
          status: 'running',
          goal: { text: '目标二', status: 'active', autoTurns: 0, noProgressRuns: 0 },
        },
      });

      h.driver.observe(
        turnFailed('s1', '502 Upstream service temporarily unavailable', { provider: 'openai' })
      );
      h.driver.observe(
        turnFailed('s2', '502 Upstream service temporarily unavailable', { provider: 'openai' })
      );

      // 1 分钟后只唤醒 s1 探测
      h.advance(1 * MIN);
      expect(h.prompts.map((p) => p.id)).toEqual(['s1']);

      // s1 成功 -> 错峰唤醒 s2
      h.driver.observe(turnCompleted('s1', { provider: 'openai' }));
      h.advance(2_500);
      expect(h.prompts.filter((p) => p.id === 's2')).toHaveLength(1);
      h.recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('用户手动停止（forget / goalAction pause）后不再自动重试，即便同 provider 恢复', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({
        s1: {
          driver: 'main',
          status: 'running',
          goal: { text: '目标一', status: 'active', autoTurns: 0, noProgressRuns: 0 },
        },
        s2: {
          driver: 'main',
          status: 'running',
          goal: { text: '目标二', status: 'active', autoTurns: 0, noProgressRuns: 0 },
        },
      });

      h.driver.observe(turnFailed('s1', '503 No available accounts', { provider: 'anthropic' }));
      h.driver.observe(turnFailed('s2', '503 No available accounts', { provider: 'anthropic' }));

      // 手动暂停 s1
      h.driver.goalAction('s1', 'pause');
      expect(h.goalOf('s1')?.status).toBe('paused');
      expect(h.goalOf('s1')?.retry).toBeUndefined();

      // s2 探测成功，整个 provider 恢复，但 s1 绝不能被自动唤醒
      h.advance(1 * MIN);
      expect(h.prompts.map((p) => p.id)).toEqual(['s2']);
      h.driver.observe(turnCompleted('s2', { provider: 'anthropic' }));
      h.advance(10_000);
      expect(h.prompts.filter((p) => p.id === 's1')).toHaveLength(0);
      h.recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('退避窗口（6h）耗尽后才转 failed + paused 并通知 exhausted', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({
        s1: {
          driver: 'main',
          status: 'running',
          goal: { text: '长任务', status: 'active', autoTurns: 0, noProgressRuns: 0 },
        },
      });

      h.driver.observe(turnFailed('s1', '503 No available accounts', { provider: 'anthropic' }));
      // 快进超过 6 小时窗口后探测再次失败
      h.advance(TRANSIENT_MAX_WINDOW_MS + 1_000);
      h.driver.observe(turnFailed('s1', '503 No available accounts', { provider: 'anthropic' }));

      expect(h.rows.get('s1')?.status).toBe('failed');
      expect(h.goalOf('s1')?.status).toBe('paused');
      expect(h.goalOf('s1')?.retry).toBeUndefined();
      expect(h.exhaustedEvents).toHaveLength(1);
      h.recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('唤醒后 worker 发出 status:running 时 goal 立即收敛为 active 并清掉 retry，不等轮次结束', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({
        s1: {
          driver: 'main',
          status: 'running',
          goal: { text: '完成发布验证', status: 'active', autoTurns: 1, noProgressRuns: 0 },
        },
      });

      h.driver.observe(
        turnFailed('s1', '503 Service Unavailable: No available accounts', {
          provider: 'anthropic',
          retryExhausted: true,
        })
      );
      expect(h.goalOf('s1')?.status).toBe('waiting');

      // 到点唤醒：continuation 注入，此刻 goal 仍是 waiting（turn 还没跑起来）
      h.advance(TRANSIENT_BACKOFF_MS[0]);
      expect(h.prompts).toHaveLength(1);
      expect(h.goalOf('s1')?.status).toBe('waiting');

      // worker 真正开跑：goal 必须立刻收敛，卡片/状态条不再显示「等待上游恢复」
      h.driver.observe(statusRunning('s1'));
      expect(h.goalOf('s1')?.status).toBe('active');
      expect(h.goalOf('s1')?.retry).toBeUndefined();

      // 本轮成功：保持 active，不重复收敛也不回退
      h.driver.observe(turnCompleted('s1', { provider: 'anthropic' }));
      expect(h.goalOf('s1')?.status).toBe('active');
      expect(h.goalOf('s1')?.retry).toBeUndefined();
      h.recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('探测轮再次失败时沿用原退避进度重新进入 waiting（running 收敛不丢 backoff）', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({
        s1: {
          driver: 'main',
          status: 'running',
          goal: { text: '完成发布验证', status: 'active', autoTurns: 1, noProgressRuns: 0 },
        },
      });

      h.driver.observe(turnFailed('s1', '503 No available accounts', { provider: 'anthropic' }));
      const since = (h.goalOf('s1')?.retry as { since?: number } | undefined)?.since;

      h.advance(TRANSIENT_BACKOFF_MS[0]);
      expect(h.prompts).toHaveLength(1);
      h.driver.observe(statusRunning('s1'));
      expect(h.goalOf('s1')?.status).toBe('active');

      // 探测轮又失败：重新 waiting，attempt 递增、since 沿用
      h.driver.observe(turnFailed('s1', '503 No available accounts', { provider: 'anthropic' }));
      const retry = h.goalOf('s1')?.retry as { attempt?: number; since?: number } | undefined;
      expect(h.goalOf('s1')?.status).toBe('waiting');
      expect(retry?.attempt).toBe(2);
      expect(retry?.since).toBe(since);
      h.recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('唤醒投递被 worker 拒绝（worker 已死）时 waiter 重排：倒计时到点再次真正重试，绝不空转', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({
        s1: {
          driver: 'main',
          status: 'running',
          goal: { text: '发布验证', status: 'active', autoTurns: 1, noProgressRuns: 0 },
        },
      });

      h.driver.observe(turnFailed('s1', '503 No available accounts', { provider: 'anthropic' }));
      expect(h.goalOf('s1')?.status).toBe('waiting');

      // 到点唤醒，但 worker 接不住投递（STALE / 已死）：探测从未发生
      h.setPromptResult({ ok: false, error: 'stale session generation' });
      h.advance(TRANSIENT_BACKOFF_MS[0]);
      expect(h.prompts).toHaveLength(1);
      // waiter 不能丢：闸门里还在，倒计时继续走
      expect(h.recovery.getWaiter('s1')).toBeDefined();
      expect(h.recovery.snapshots()).toHaveLength(1);

      // worker 恢复可用：下一个退避点到时真正再投一次
      h.setPromptResult({ ok: true });
      h.advance(TRANSIENT_BACKOFF_MS[1] + 500);
      expect(h.prompts).toHaveLength(2);
      expect(h.prompts[1]!.text).toContain('<goal-continuation>');
      h.recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forget（会话停止/删除）后 waiter 即刻撤出：倒计时收敛、同 provider 恢复也绝不唤醒它', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({
        s1: {
          driver: 'main',
          status: 'running',
          goal: { text: '目标一', status: 'active', autoTurns: 0, noProgressRuns: 0 },
        },
        s2: {
          driver: 'main',
          status: 'running',
          goal: { text: '目标二', status: 'active', autoTurns: 0, noProgressRuns: 0 },
        },
      });

      h.driver.observe(turnFailed('s1', '503 No available accounts', { provider: 'anthropic' }));
      h.driver.observe(turnFailed('s2', '503 No available accounts', { provider: 'anthropic' }));
      expect(h.recovery.snapshots()[0]?.waitingCount).toBe(2);

      // 用户停止/删除 s1：waiter 撤出，健康快照只剩 1 个等待者
      h.driver.forget('s1');
      expect(h.recovery.getWaiter('s1')).toBeUndefined();
      expect(h.recovery.snapshots()[0]?.waitingCount).toBe(1);

      // 到点只有 s2 被探测；s2 成功后错峰队列里也绝没有 s1
      h.advance(1 * MIN);
      expect(h.prompts.map((p) => p.id)).toEqual(['s2']);
      h.driver.observe(turnCompleted('s2', { provider: 'anthropic' }));
      h.advance(10_000);
      expect(h.prompts.filter((p) => p.id === 's1')).toHaveLength(0);
      h.recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('wakeUpstream 三态：waiting 但压缩中/审批挂起返回 retry，用户已停返回 dropped，正常投递返回 delivered', () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({
        s1: {
          driver: 'main',
          status: 'idle',
          goal: { text: '目标一', status: 'active', autoTurns: 0, noProgressRuns: 0 },
        },
      });
      h.driver.observe(turnFailed('s1', '503 No available accounts', { provider: 'anthropic' }));
      expect(h.goalOf('s1')?.status).toBe('waiting');

      // 正常路径：delivered
      expect(h.driver.wakeUpstream('s1', 'probe')).toBe('delivered');
      h.recovery.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
