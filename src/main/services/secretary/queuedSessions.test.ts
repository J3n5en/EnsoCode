import { parseProfile } from '@shared/secretary/parse';
import type { AgentSpawnRequest, ProjectAuthority } from '@shared/types/agent';
import type {
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryProfile,
  SecretaryTodo,
} from '@shared/types/secretary';
import type { SessionWorktree } from '@shared/types/worktree';
import { describe, expect, it } from 'vitest';
import type { SecretaryDispatchPorts } from './dispatch';
import { createQueuedSessions, type QueuedOwner, type QueuedSessionPorts } from './queuedSessions';
import type { SecretarySessionStatus } from './readers';

const PROJECT: ProjectAuthority = {
  projectId: 'p1',
  canonicalPath: '/repo/alpha',
  kind: 'local',
  state: 'active',
  version: 1,
};

const WORKTREE: SessionWorktree = {
  conversationId: 'q1',
  projectId: 'p1',
  repoPath: '/repo/alpha',
  path: '/worktrees/q1',
  branch: 'enso/q1',
  baseBranch: 'main',
  baseCommit: 'abc',
  createdAt: 1,
};

const idle: SecretarySessionStatus = { state: 'idle', pendingAsks: 0, pendingApprovals: 0 };
const running: SecretarySessionStatus = { state: 'running', pendingAsks: 0, pendingApprovals: 0 };

function profile(max: number): SecretaryProfile {
  const parsed = parseProfile({ maxRunningDispatches: max });
  if (!parsed) throw new Error('profile');
  return parsed;
}

function queuedRow(
  id: string,
  queuedAt: number,
  extra: Record<string, unknown> = {},
  owner = 's1'
): Record<string, unknown> {
  return {
    id,
    projectId: 'p1',
    title: `标题 ${id}`,
    lastProviderId: 'prov',
    lastModelId: 'm1',
    reasoningEnabled: true,
    thinkingLevel: 'medium',
    approvalMode: 'assistant',
    autoRejectApprovals: true,
    driver: 'main',
    secretaryOrigin: { secretaryConversationId: `sec-${owner}`, secretaryId: owner },
    queuedStart: { queuedAt, text: `做 ${id}`, ...extra },
  };
}

interface OwnerState {
  id: string;
  file: SecretaryDispatchFile;
  todos: SecretaryTodo[];
  audits: SecretaryAuditEntry[];
  max: number;
  unfollowed: string[];
}

function record(conversationId: string, owner: string, lastState: 'running' | 'idle') {
  return {
    conversationId,
    projectId: 'p1',
    secretaryConversationId: `sec-${owner}`,
    createdAt: 1,
    turn: 0,
    lastState,
    lastEventAt: 1,
  };
}

function harness(input: {
  rows: Record<string, Record<string, unknown>>;
  owners?: Record<string, { max: number; running?: string[]; queued?: string[] }>;
  maxTotal?: number;
}) {
  const rows = input.rows;
  const statuses = new Map<string, SecretarySessionStatus>();
  const spawns: AgentSpawnRequest[] = [];
  const prompts: { id: string; text: string; images?: unknown[] }[] = [];
  const log: string[] = [];
  const released: string[] = [];
  const flushed: string[] = [];
  let spawnResult: { ok: boolean; error?: string } = { ok: true };
  let promptResult: { ok: boolean; error?: string } = { ok: true };
  let gate: Promise<void> | null = null;
  let ids = 0;
  let now = 1_000;

  const owners = new Map<string, OwnerState>();
  for (const [id, spec] of Object.entries(input.owners ?? { s1: { max: 3 } })) {
    const file: SecretaryDispatchFile = {
      version: 1,
      dispatched: {},
      named: [],
      proposals: {},
      outbox: [],
    };
    for (const conversationId of spec.running ?? []) {
      file.dispatched[conversationId] = record(conversationId, id, 'running');
      rows[conversationId] = { id: conversationId, projectId: 'p1', sessionFile: '/s.jsonl' };
      statuses.set(conversationId, running);
    }
    for (const conversationId of Object.keys(rows)) {
      const origin = rows[conversationId].secretaryOrigin as { secretaryId?: string } | undefined;
      if (origin?.secretaryId === id && !file.dispatched[conversationId])
        file.dispatched[conversationId] = record(conversationId, id, 'idle');
    }
    owners.set(id, { id, file, todos: [], audits: [], max: spec.max, unfollowed: [] });
  }

  const ownerPorts = (state: OwnerState): QueuedOwner => ({
    id: state.id,
    dispatch: {
      profile: () => profile(state.max),
      dispatchFile: () => structuredClone(state.file),
      saveDispatch: (file: SecretaryDispatchFile) => {
        state.file = structuredClone(file);
      },
      todos: () => state.todos,
      saveTodos: (todos: SecretaryTodo[]) => {
        state.todos = todos;
      },
      audit: (entry: SecretaryAuditEntry) => {
        state.audits.push(entry);
      },
      rows: () => rows,
      status: (id: string) => statuses.get(id) ?? idle,
      unfollow: (id: string) => {
        state.unfollowed.push(id);
      },
    } as unknown as SecretaryDispatchPorts,
  });

  const ports: QueuedSessionPorts = {
    launch: {
      project: (id) => (id === 'p1' ? PROJECT : undefined),
      spawn: async (request) => {
        log.push(`spawn ${request.sessionId}`);
        if (gate) await gate;
        spawns.push(request);
        if (spawnResult.ok) rows[request.sessionId] = { ...rows[request.sessionId] };
        return spawnResult;
      },
      prompt: (id, text, _deliveryId, images) => {
        log.push(`prompt ${id}`);
        prompts.push({ id, text, ...(images ? { images } : {}) });
        if (promptResult.ok) statuses.set(id, running);
        return promptResult;
      },
      release: async (id) => {
        released.push(id);
      },
      imageInput: async () => true,
      newId: () => `id-${++ids}`,
    },
    rows: () => rows,
    updateRow: (id, update) => {
      const current = rows[id];
      if (!current) return null;
      const next = update(structuredClone(current));
      if (!next) return null;
      rows[id] = next;
      return next;
    },
    removeWorktree: async (worktree) => {
      log.push(`removeWorktree ${worktree.path}`);
    },
    removeRow: (id) => {
      log.push(`removeRow ${id}`);
      delete rows[id];
    },
    removeConversation: (id) => {
      log.push(`removeConversation ${id}`);
    },
    owner: (id) => {
      const state = owners.get(id);
      return state ? ownerPorts(state) : null;
    },
    owners: () => [...owners.values()].map(ownerPorts),
    maxTotal: () => input.maxTotal ?? 10,
    loadAttachments: async (paths) => ({
      images: paths.map((path) => ({ path, size: 3, data: 'AAAA', mimeType: 'image/png' })),
    }),
    flush: (id) => {
      flushed.push(id);
    },
    now: () => now,
    newId: () => `msg-${++ids}`,
  };
  const queue = createQueuedSessions(ports);
  return {
    queue,
    ports,
    rows,
    statuses,
    spawns,
    prompts,
    log,
    released,
    flushed,
    owner: (id = 's1') => owners.get(id) as OwnerState,
    setSpawn(result: { ok: boolean; error?: string }) {
      spawnResult = result;
    },
    setPrompt(result: { ok: boolean; error?: string }) {
      promptResult = result;
    },
    hold() {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
    tick(ms: number) {
      now += ms;
    },
  };
}

const spawned = (h: ReturnType<typeof harness>) => h.spawns.map((request) => request.sessionId);

describe('排队会话的自动启动', () => {
  it('有空位按排队先后启动，名额满了就停', async () => {
    const h = harness({
      rows: { q3: queuedRow('q3', 30), q1: queuedRow('q1', 10), q2: queuedRow('q2', 20) },
      owners: { s1: { max: 2, running: ['busy'] } },
    });
    await h.queue.drain();
    expect(spawned(h)).toEqual(['q1']);
    expect(h.rows.q1.queuedStart).toBeUndefined();
    expect(h.rows.q2.queuedStart).toBeDefined();
    expect(h.owner().file.dispatched.q1).toMatchObject({
      lastState: 'running',
      stateSince: 1_000,
      lastEventAt: 1_000,
    });

    // busy 结束让出名额：下一次按顺序起 q2
    h.statuses.set('busy', idle);
    h.owner().file.dispatched.busy.lastState = 'idle';
    h.statuses.set('q1', running);
    await h.queue.drain();
    expect(spawned(h)).toEqual(['q1', 'q2']);
  });

  it('启动用的是行上的配置：模型、推理、审批、cwd 取 worktree，目标启动后才写进行', async () => {
    const h = harness({
      rows: {
        q1: queuedRow('q1', 10, { goal: '构建通过', askRelay: { name: '小秘' } }),
      },
    });
    h.rows.q1.worktree = WORKTREE;
    await h.queue.drain();
    expect(h.spawns[0]).toMatchObject({
      sessionId: 'q1',
      providerId: 'prov',
      modelId: 'm1',
      cwd: '/worktrees/q1',
      reasoningEnabled: true,
      thinkingLevel: 'medium',
      approvalMode: 'assistant',
      autoRejectApprovals: true,
      askRelay: { name: '小秘' },
    });
    expect(h.prompts[0].text).toContain('做 q1');
    expect(h.prompts[0].text).toContain('构建通过');
    expect(h.rows.q1.goal).toMatchObject({ text: '构建通过', status: 'active' });
  });

  it('图片在启动时才读，随首条消息带上', async () => {
    const h = harness({ rows: { q1: queuedRow('q1', 10, { attachments: ['/tmp/a.png'] }) } });
    await h.queue.drain();
    expect(h.prompts[0].images).toEqual([{ data: 'AAAA', mimeType: 'image/png' }]);
  });

  it('合计上限满了谁都不启动', async () => {
    const h = harness({
      rows: { q1: queuedRow('q1', 10), q2: queuedRow('q2', 5, {}, 's2') },
      owners: { s1: { max: 3, running: ['a'] }, s2: { max: 3, running: ['b'] } },
      maxTotal: 2,
    });
    await h.queue.drain();
    expect(h.spawns).toEqual([]);
  });

  it('合计只剩一个名额：先排的先起，不论哪个秘书', async () => {
    const h = harness({
      rows: { q1: queuedRow('q1', 10), q2: queuedRow('q2', 5, {}, 's2') },
      owners: { s1: { max: 3 }, s2: { max: 3 } },
      maxTotal: 1,
    });
    await h.queue.drain();
    expect(spawned(h)).toEqual(['q2']);
  });

  it('两次并发 drain：每条只启动一次，也不超过名额', async () => {
    const h = harness({
      rows: { q1: queuedRow('q1', 10), q2: queuedRow('q2', 20), q3: queuedRow('q3', 30) },
      owners: { s1: { max: 2 } },
    });
    const release = h.hold();
    const first = h.queue.drain();
    const second = h.queue.drain();
    const third = h.queue.drain();
    release();
    await Promise.all([first, second, third]);
    expect(spawned(h)).toEqual(['q1', 'q2']);
  });

  it('drain 与手动开始并发：同一条只启动一次', async () => {
    const h = harness({ rows: { q1: queuedRow('q1', 10) } });
    const release = h.hold();
    const drained = h.queue.drain();
    const manual = h.queue.start('q1');
    release();
    await drained;
    expect(await manual).toEqual({ ok: false, error: 'not-queued' });
    expect(spawned(h)).toEqual(['q1']);
  });

  it('spawn 前先落盘认领：启动中的行带 startingAt，占着名额', async () => {
    const h = harness({ rows: { q1: queuedRow('q1', 10) } });
    const release = h.hold();
    const drained = h.queue.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.rows.q1.queuedStart).toMatchObject({ startingAt: 1_000 });
    release();
    await drained;
    expect(h.rows.q1.queuedStart).toBeUndefined();
  });
});

describe('排队会话启动失败', () => {
  it('spawn 失败：保留会话与 worktree，标失败、推给秘书，之后不再自动重试', async () => {
    const h = harness({ rows: { q1: queuedRow('q1', 10) } });
    h.rows.q1.worktree = WORKTREE;
    h.setSpawn({ ok: false, error: 'model credentials unavailable' });
    await h.queue.drain();
    expect(h.rows.q1.worktree).toEqual(WORKTREE);
    expect(h.rows.q1.queuedStart).toEqual({
      queuedAt: 10,
      text: '做 q1',
      failed: { at: 1_000, error: 'model credentials unavailable' },
    });
    expect(h.log).not.toContain('removeRow q1');
    expect(h.owner().file.outbox).toEqual([
      expect.objectContaining({
        kind: 'queued',
        status: 'failed',
        conversationId: 'q1',
        secretaryConversationId: 'sec-s1',
      }),
    ]);
    expect(h.flushed).toEqual(['s1']);

    h.spawns.length = 0;
    h.setSpawn({ ok: true });
    await h.queue.drain();
    expect(h.spawns).toEqual([]);

    // 用户立即开始：失败的也能重试
    expect(await h.queue.start('q1')).toEqual({ ok: true });
    expect(spawned(h)).toEqual(['q1']);
    expect(h.rows.q1.queuedStart).toBeUndefined();
  });

  it('首条消息被拒：释放已 spawn 的会话再标失败', async () => {
    const h = harness({ rows: { q1: queuedRow('q1', 10) } });
    h.setPrompt({ ok: false, error: 'stale' });
    await h.queue.drain();
    expect(h.released).toEqual(['q1']);
    expect(h.rows.q1.queuedStart).toMatchObject({ failed: { error: 'stale' } });
    expect(h.owner().file.dispatched.q1.lastState).toBe('idle');
  });
});

describe('立即开始', () => {
  it('不看上限插队；排队期间的消息进会话队列，首条消息先发', async () => {
    const h = harness({
      rows: { q1: queuedRow('q1', 10), q2: queuedRow('q2', 20, { goal: '修好' }) },
      owners: { s1: { max: 1, running: ['busy'] } },
    });
    const result = await h.queue.start('q2', { text: '顺便看下日志' });
    expect(result).toEqual({ ok: true });
    expect(spawned(h)).toEqual(['q2']);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].text).toContain('做 q2');
    expect(h.rows.q2.queuedMessages).toEqual([{ id: 'msg-1', text: '顺便看下日志', at: 1_000 }]);
    expect(h.rows.q1.queuedStart).toBeDefined();
    expect(h.owner().audits.at(-1)).toMatchObject({ op: 'queued_start', detail: 'manual' });
  });

  it('已经开始的会话不能再立即开始', async () => {
    const h = harness({ rows: { q1: queuedRow('q1', 10) } });
    await h.queue.drain();
    expect(await h.queue.start('q1')).toEqual({ ok: false, error: 'not-queued' });
    expect(spawned(h)).toEqual(['q1']);
  });
});

describe('取消排队会话', () => {
  it('直接删掉会话：worktree、行、权威记录；记录按停止处理，待办标停止，用户取消时告诉秘书', async () => {
    const h = harness({ rows: { q1: queuedRow('q1', 10) } });
    h.rows.q1.worktree = WORKTREE;
    h.owner().todos = [
      { id: 't1', text: '修构建', createdAt: 1, updatedAt: 1, conversationId: 'q1' },
    ];
    expect(await h.queue.cancel('q1', null)).toEqual({ ok: true });
    expect(h.log).toEqual([
      'removeWorktree /worktrees/q1',
      'removeRow q1',
      'removeConversation q1',
    ]);
    expect(h.owner().file.dispatched.q1).toMatchObject({ lastState: 'idle', stoppedAt: 1_000 });
    expect(h.owner().todos[0]).toMatchObject({ problem: 'stopped' });
    expect(h.owner().file.outbox).toEqual([
      expect.objectContaining({ kind: 'queued', status: 'cancelled', conversationId: 'q1' }),
    ]);
    expect(h.owner().unfollowed).toEqual(['q1']);
  });

  it('秘书自己取消的不再回传', async () => {
    const h = harness({ rows: { q1: queuedRow('q1', 10) } });
    expect(await h.queue.cancel('q1', 'sec-s1')).toEqual({ ok: true });
    expect(h.owner().file.outbox).toEqual([]);
  });

  it('已经开始的拒绝，什么都不删', async () => {
    const h = harness({ rows: { q1: queuedRow('q1', 10) } });
    await h.queue.drain();
    expect(await h.queue.cancel('q1', null)).toEqual({ ok: false, error: 'not-queued' });
    expect(h.rows.q1).toBeDefined();
  });

  it('启动进行中的取消排在启动之后，看到的是已开始，拒绝', async () => {
    const h = harness({ rows: { q1: queuedRow('q1', 10) } });
    const release = h.hold();
    const drained = h.queue.drain();
    const cancelled = h.queue.cancel('q1', null);
    release();
    await drained;
    expect(await cancelled).toEqual({ ok: false, error: 'not-queued' });
    expect(h.log).not.toContain('removeRow q1');
  });
});

describe('重启恢复', () => {
  it('认领了但 agent 没起来：放回队列，顺序不变', async () => {
    const h = harness({
      rows: {
        q1: queuedRow('q1', 10, { startingAt: 900 }),
        q2: queuedRow('q2', 20),
      },
      owners: { s1: { max: 1 } },
    });
    h.queue.recover();
    expect(h.rows.q1.queuedStart).toEqual({ queuedAt: 10, text: '做 q1' });
    await h.queue.drain();
    expect(spawned(h)).toEqual(['q1']);
  });

  it('认领了且 agent 已起来：按已启动收尾，不再 spawn', async () => {
    const h = harness({
      rows: { q1: queuedRow('q1', 10, { startingAt: 900, goal: '修好' }) },
    });
    h.rows.q1.sessionFile = '/s/q1.jsonl';
    h.queue.recover();
    expect(h.rows.q1.queuedStart).toBeUndefined();
    expect(h.rows.q1.goal).toMatchObject({ text: '修好', status: 'active' });
    expect(h.owner().file.dispatched.q1.lastState).toBe('running');
    await h.queue.drain();
    expect(h.spawns).toEqual([]);
  });
});
