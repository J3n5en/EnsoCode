import { parseDispatchFile, parseProfile } from '@shared/secretary/parse';
import { patrolAnomalies } from '@shared/secretary/patrol';
import { queuedStartOf } from '@shared/secretary/queuedSession';
import type { AgentSpawnRequest, ProjectAuthority, RendererAgentEvent } from '@shared/types/agent';
import type {
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryProfile,
} from '@shared/types/secretary';
import { nextPendingRetryDelayMs, PENDING_DISPATCH_MAX_RETRIES } from '@shared/upstreamRecovery';
import { describe, expect, it, vi } from 'vitest';
import { type SecretaryDispatchPorts, startPendingDispatches } from './dispatch';
import { createSecretaryHost, type SecretaryHostPorts } from './host';
import { createQueuedSessions, type QueuedOwner, type QueuedSessionPorts } from './queuedSessions';
import type { SecretarySessionStatus } from './readers';
import { buildBoard } from './results';

const PROJECT: ProjectAuthority = {
  projectId: 'p1',
  canonicalPath: '/repo/alpha',
  kind: 'local',
  state: 'active',
  version: 1,
};

const idle: SecretarySessionStatus = { state: 'idle', pendingAsks: 0, pendingApprovals: 0 };

function makeProfile(max = 5): SecretaryProfile {
  const parsed = parseProfile({ maxRunningDispatches: max });
  if (!parsed) throw new Error('profile');
  return parsed;
}

describe('巡检与看板：等待上游恢复的会话不误报停滞、留在进行中列并透传 upstreamRetry', () => {
  it('patrolAnomalies 跳过 upstreamWaiting: true 的会话，不误报 goal-idle-stalled', () => {
    const now = 1_700_000_000_000;
    const anomalies = patrolAnomalies(
      [
        {
          conversationId: 'c1',
          state: 'idle',
          goalStatus: 'waiting',
          pending: 0,
          lastEventAt: now - 30 * 60_000,
          turn: 1,
          stallReported: false,
          upstreamWaiting: true,
        },
      ],
      now
    );
    expect(anomalies).toEqual([]);
  });

  it('buildBoard 将等待上游恢复的会话放在 running 列并附带 upstreamRetry 元数据', () => {
    const retry = {
      reason: 'upstream' as const,
      kind: 'transient' as const,
      provider: 'anthropic',
      attempt: 2,
      since: 1_000,
      at: 181_000,
      lastError: '503 Service Unavailable: No available accounts',
    };
    const file: SecretaryDispatchFile = {
      version: 1,
      dispatched: {
        c1: {
          conversationId: 'c1',
          projectId: 'p1',
          secretaryConversationId: 'sec-1',
          createdAt: 1_000,
          turn: 1,
          lastState: 'idle',
          lastEventAt: 2_000,
        },
      },
      named: [],
      outbox: [],
      proposals: {},
    };
    const board = buildBoard(file, {
      rows: {
        c1: {
          id: 'c1',
          title: '发布任务',
          goal: { text: '发版', status: 'waiting', autoTurns: 1, retry },
        },
      },
      statuses: { c1: idle },
      projects: [PROJECT],
      todos: [],
    });
    expect(board.needsYou).toHaveLength(0);
    expect(board.running).toHaveLength(1);
    const card = board.running[0];
    expect(card?.kind).toBe('session');
    if (card?.kind === 'session') {
      expect(card.upstreamRetry).toEqual(retry);
    }
  });
});

describe('待派发与排队启动的瞬态重试（方案 #5）', () => {
  it('startPendingDispatches 遇到 503 瞬态错误保留 waiting 并退避重试最多 5 次，第 6 次才标 failed', async () => {
    let clock = 1_700_000_000_000;
    const audits: SecretaryAuditEntry[] = [];
    let file: SecretaryDispatchFile = {
      version: 1,
      dispatched: {
        dep1: {
          conversationId: 'dep1',
          projectId: 'p1',
          secretaryConversationId: 'sec-1',
          createdAt: 1,
          turn: 1,
          lastState: 'idle',
          lastEventAt: 2,
          lastResult: { kind: 'goal-complete', at: 2, turn: 1 },
        },
      },
      named: [],
      outbox: [],
      proposals: {},
      pending: {
        pend1: {
          id: 'pend1',
          projectId: 'p1',
          secretaryConversationId: 'sec-1',
          createdAt: clock,
          updatedAt: clock,
          status: 'waiting',
          after: ['dep1'],
          draft: {
            projectId: 'p1',
            prompt: '执行下一步',
            title: '后续任务',
            worktree: false,
          },
        },
      },
    };

    const createSession = vi.fn(async () => ({
      ok: false as const,
      error: '503 Service Unavailable: No available accounts',
    }));
    const ports = {
      profile: async () => makeProfile(5),
      projects: async () => [PROJECT],
      rows: async () => ({ dep1: { id: 'dep1', title: '前置', sessionFile: '/s/dep1.jsonl' } }),
      status: () => idle,
      dispatchFile: () => structuredClone(file),
      saveDispatch: (next: SecretaryDispatchFile) => {
        // 经 parseDispatchFile 往返验证落盘不丢失 retryCount / nextRetryAt / lastError
        file = parseDispatchFile(JSON.parse(JSON.stringify(next)));
      },
      audit: (entry: SecretaryAuditEntry) => audits.push(entry),
      now: () => clock,
      newId: () => 'new-conv',
      createSession,
    } as unknown as SecretaryDispatchPorts;

    // 前 5 次瞬态失败都留在 waiting，不标记 failed
    for (let attempt = 1; attempt <= PENDING_DISPATCH_MAX_RETRIES; attempt++) {
      await startPendingDispatches(ports, ['pend1'], clock);
      const p = file.pending?.pend1;
      expect(p?.status).toBe('waiting');
      expect(p?.retryCount).toBe(attempt);
      expect(p?.nextRetryAt).toBe(clock + nextPendingRetryDelayMs(attempt)!);
      // 未到 nextRetryAt 不会重复尝试
      const callsBefore = createSession.mock.calls.length;
      await startPendingDispatches(ports, ['pend1'], clock + 1_000);
      expect(createSession.mock.calls.length).toBe(callsBefore);
      clock = p!.nextRetryAt!;
    }

    // 第 6 次失败超过 5 次上限，才标 failed
    await startPendingDispatches(ports, ['pend1'], clock);
    expect(file.pending?.pend1?.status).toBe('failed');
    expect(file.pending?.pend1?.problem).toBe('dispatch-failed');
  });

  it('queuedSessions 自动启动遇瞬态 503 放回排队并退避重试最多 5 次，永久 401 立刻失败', async () => {
    let clock = 1_700_000_000_000;
    const rows: Record<string, Record<string, unknown>> = {
      q1: {
        id: 'q1',
        projectId: 'p1',
        title: '排队任务',
        lastProviderId: 'anthropic',
        lastModelId: 'claude',
        driver: 'main',
        secretaryOrigin: { secretaryConversationId: 'sec-s1', secretaryId: 's1' },
        queuedStart: { queuedAt: 100, text: '干活' },
      },
      q2: {
        id: 'q2',
        projectId: 'p1',
        title: '鉴权失败任务',
        lastProviderId: 'anthropic',
        lastModelId: 'claude',
        driver: 'main',
        secretaryOrigin: { secretaryConversationId: 'sec-s1', secretaryId: 's1' },
        queuedStart: { queuedAt: 200, text: '干活 2' },
      },
    };
    let file: SecretaryDispatchFile = {
      version: 1,
      dispatched: {},
      named: [],
      outbox: [],
      proposals: {},
    };
    const audits: SecretaryAuditEntry[] = [];
    const owner: QueuedOwner = {
      id: 's1',
      dispatch: {
        profile: () => makeProfile(5),
        rows: async () => rows,
        status: () => idle,
        dispatchFile: () => structuredClone(file),
        saveDispatch: (next: SecretaryDispatchFile) => {
          file = structuredClone(next);
        },
        audit: (entry: SecretaryAuditEntry) => audits.push(entry),
      } as unknown as SecretaryDispatchPorts,
    };

    const spawnMock = vi.fn(async (req: AgentSpawnRequest) => {
      if (req.sessionId === 'q1') {
        return { ok: false, error: '502 Upstream service temporarily unavailable' };
      }
      return { ok: false, error: '401 Unauthorized: invalid_api_key' };
    });

    const ports: QueuedSessionPorts = {
      owners: () => [owner],
      owner: (id) => (id === 's1' ? owner : null),
      rows: () => rows,
      updateRow: (id, fn) => {
        const current = rows[id];
        if (!current) return null;
        const next = fn(current);
        if (!next) return null;
        rows[id] = next;
        return next;
      },
      removeWorktree: async () => {},
      removeRow: (id: string) => {
        delete rows[id];
      },
      removeConversation: () => {},
      loadAttachments: async () => ({ images: [] }),
      launch: {
        spawn: spawnMock,
        prompt: () => ({ ok: true }),
        newId: () => 'd1',
        project: () => PROJECT,
        release: async () => {},
        imageInput: async () => true,
      },
      now: () => clock,
      newId: () => 'id1',
      maxTotal: () => 10,
    };

    const queued = createQueuedSessions(ports);
    // 1. q1 遇到 502 放回等待并写 retryCount=1, nextRetryAt；q2 遇到 401 立刻标 failed
    await queued.drain();
    const q1After1 = queuedStartOf(rows.q1);
    expect(q1After1?.failed).toBeUndefined();
    expect(q1After1?.retryCount).toBe(1);
    expect(q1After1?.nextRetryAt).toBe(clock + nextPendingRetryDelayMs(1)!);
    expect(queuedStartOf(rows.q2)?.failed?.error).toContain('401');

    // 2. 推进剩余 4 次瞬态失败仍留在排队，第 6 次才标 failed
    for (let attempt = 2; attempt <= PENDING_DISPATCH_MAX_RETRIES; attempt++) {
      clock = queuedStartOf(rows.q1)!.nextRetryAt!;
      await queued.drain();
      expect(queuedStartOf(rows.q1)?.failed).toBeUndefined();
      expect(queuedStartOf(rows.q1)?.retryCount).toBe(attempt);
    }
    clock = queuedStartOf(rows.q1)!.nextRetryAt!;
    await queued.drain();
    expect(queuedStartOf(rows.q1)?.failed?.error).toContain('502');
  });
});

describe('SecretaryHost 上游恢复通知收敛', () => {
  it('瞬态上游故障进入 waiting 后不向秘书和用户推 failed，改写状态摘要；永久/耗尽时照常推 failed', () => {
    const retryAt = new Date(2026, 4, 1, 14, 30, 0).getTime();
    let file: SecretaryDispatchFile = {
      version: 1,
      dispatched: {
        c1: {
          conversationId: 'c1',
          projectId: 'p1',
          secretaryConversationId: 'sec-1',
          createdAt: 1,
          turn: 0,
          lastState: 'running',
          lastEventAt: 1,
        },
      },
      named: [],
      proposals: {},
      outbox: [],
    };
    const rows: Record<string, Record<string, unknown>> = {
      c1: {
        id: 'c1',
        title: '自动发布',
        goal: {
          text: '完成发布',
          status: 'waiting',
          autoTurns: 1,
          retry: {
            reason: 'upstream',
            kind: 'transient',
            provider: 'anthropic',
            attempt: 1,
            since: retryAt - 60_000,
            at: retryAt,
            lastError: '503 Service Unavailable: No available accounts',
          },
        },
      },
    };
    const notifications: Array<{ title: string; body: string }> = [];
    const host = createSecretaryHost({
      enabled: () => true,
      profile: () => makeProfile(5),
      file: () => structuredClone(file),
      save: (next: SecretaryDispatchFile) => {
        file = structuredClone(next);
      },
      rows: () => rows,
      status: () => ({ state: 'error', pendingAsks: 0, pendingApprovals: 0 }),
      projects: () => [PROJECT],
      todos: () => [],
      saveTodos: () => {},
      schedules: () => [],
      saveSchedules: () => {},
      notify: (build: (lang: 'zh' | 'en') => { title: string; body: string }) =>
        notifications.push(build('zh')),
      publish: () => {},
      audit: () => {},
      prompt: () => ({ ok: true }),
      alive: () => true,
      now: () => retryAt - 60_000,
      newId: () => 'd1',
      viewedSession: () => null,
      sessionMuted: () => false,
      backgroundTasks: () => [],
      subagentsRunning: () => false,
      reminders: () => [],
    } as unknown as SecretaryHostPorts);

    // 1. driver 已将 goal 落为 waiting(upstream)：host 不推 failed，改记「上游不可用，自动重试中（下次 14:30）」
    host.onAgentEvent(
      {
        type: 'turn-failed',
        identity: { sessionId: 'c1', generation: 'g1' },
        seq: 1,
        turnId: 't1',
        error: '503 Service Unavailable: No available accounts',
        retryExhausted: true,
      } as RendererAgentEvent,
      [
        {
          sessionId: 'c1',
          state: 'error',
          previous: 'running',
          pendingAsks: 0,
          pendingApprovals: 0,
        },
      ]
    );
    expect(file.dispatched.c1?.lastResult).toBeUndefined();
    expect(file.outbox).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(file.dispatched.c1?.lastText).toBe('上游不可用，自动重试中（下次 14:30）');

    // 2. 退避耗尽或永久错误时 goal 变为 paused（无 retry）：host 照常推 failed
    rows.c1.goal = { text: '完成发布', status: 'paused', note: '401 Unauthorized', autoTurns: 1 };
    host.onAgentEvent(
      {
        type: 'turn-failed',
        identity: { sessionId: 'c1', generation: 'g1' },
        seq: 2,
        turnId: 't2',
        error: '401 Unauthorized: invalid_api_key',
      } as RendererAgentEvent,
      [
        {
          sessionId: 'c1',
          state: 'error',
          previous: 'running',
          pendingAsks: 0,
          pendingApprovals: 0,
        },
      ]
    );
    expect(file.dispatched.c1?.lastResult?.kind).toBe('failed');
    expect(file.outbox.some((u) => u.kind === 'failed')).toBe(true);
  });
});
