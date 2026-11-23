import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDispatchFile, parseProfile } from '@shared/secretary/parse';
import type { DispatchBaseFacts } from '@shared/secretary/policy';
import type { ConversationAuthority, ProjectAuthority } from '@shared/types/agent';
import type {
  CleanupItem,
  DispatchDraft,
  DispatchModelRef,
  DispatchRecord,
  PendingDispatch,
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryProfile,
  SecretaryProfileDraft,
  SecretaryRelayAsk,
  SecretarySkillDraft,
  SecretaryTodo,
  SecretaryToolDraft,
} from '@shared/types/secretary';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretaryTools, normalizeSecretaryParams } from '../../../agent/tools/secretary';
import type { ObservedTask } from '../backgroundTaskTracker';
import {
  buildSecretaryState,
  createSecretaryDispatchHandlers,
  dismissPending,
  dismissResult,
  grantTakeover,
  listTakeovers,
  listUntracked,
  markResult,
  mutateTodo,
  NOT_OPERABLE_ERROR,
  resolveProposal,
  revokeTakeover,
  type SecretaryDispatchPorts,
  type SecretaryQueuedMessage,
  saveCleanupProposal,
  startPendingDispatches,
  stopLeftoverTasks,
  untrack,
} from './dispatch';
import {
  type FollowDeps,
  FollowingStore,
  recordPhoneFollow,
  renameFollowedTarget,
  unfollowTarget,
} from './following';
import type { SecretarySessionStatus } from './readers';
import { buildBoard } from './results';
import type { MainSessionRequest, MainSessionResult } from './sessionFactory';
import type { SecretaryOpHandler } from './tools';

const ctx = { secretaryConversationId: 'sec-1' };
const NOW = 1_000;

/** 24 字节的 png 头（4x3）：只按文件头判格式，够用 */
const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 3, 8, 6, 0, 0,
  0,
]);

const localProject = (projectId = 'p1', overrides: Partial<ProjectAuthority> = {}) =>
  ({
    projectId,
    canonicalPath: `/repo/${projectId === 'p1' ? 'alpha' : projectId}`,
    state: 'active',
    version: 1,
    ...overrides,
  }) as ProjectAuthority;

const rootConversation = (
  conversationId: string,
  projectId = 'p1',
  overrides: Partial<ConversationAuthority> = {}
) =>
  ({
    conversationId,
    projectId,
    kind: 'root',
    lifecycle: 'ready',
    version: 1,
    ...overrides,
  }) as ConversationAuthority;

const baseProfile = (): SecretaryProfile => {
  const parsed = parseProfile({});
  if (!parsed) throw new Error('secretary default profile');
  return parsed;
};

const profile = (overrides: Partial<SecretaryProfile> = {}): SecretaryProfile => ({
  ...baseProfile(),
  ...overrides,
});

const idle: SecretarySessionStatus = { state: 'idle', pendingAsks: 0, pendingApprovals: 0 };
const running: SecretarySessionStatus = { state: 'running', pendingAsks: 0, pendingApprovals: 0 };

const emptyFile = (): SecretaryDispatchFile => ({
  version: 1,
  dispatched: {},
  named: [],
  proposals: {},
  outbox: [],
});

const dispatchedFile = (
  conversationId = 'c1',
  lastState: 'running' | 'idle' = 'idle'
): SecretaryDispatchFile => ({
  ...emptyFile(),
  dispatched: {
    [conversationId]: {
      conversationId,
      projectId: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: 900,
      turn: 0,
      lastState,
      lastEventAt: 900,
    },
  },
});

interface Harness {
  ports: SecretaryDispatchPorts;
  handlers: ReturnType<typeof createSecretaryDispatchHandlers>;
  file: SecretaryDispatchFile;
  todos: SecretaryTodo[];
  audits: SecretaryAuditEntry[];
  created: MainSessionRequest[];
  prompts: {
    conversationId: string;
    text: string;
    deliveryId: string;
    images?: { data: string; mimeType: string }[];
  }[];
  resumes: string[];
  aborts: string[];
  queued: { conversationId: string; message: SecretaryQueuedMessage }[];
  steers: {
    conversationId: string;
    text: string;
    deliveryId: string;
    images?: { data: string; mimeType: string }[];
  }[];
  pausedGoals: string[];
  /** attachGoal 的调用记录；缺省都成功 */
  attachedGoals: { conversationId: string; goal: string }[];
  attachGoalOk: boolean;
  profileValue: SecretaryProfile | null;
  appliedProfiles: SecretaryProfileDraft[];
  appliedSkills: SecretarySkillDraft[];
  appliedTools: SecretaryToolDraft[];
  projects: ProjectAuthority[];
  conversations: ConversationAuthority[];
  statuses: Map<string, SecretarySessionStatus>;
  rows: Record<string, Record<string, unknown>>;
  createResult: MainSessionResult;
  changed: number;
  /** 基线校验的既成事实；测试按需覆盖 */
  baseFacts: DispatchBaseFacts;
  baseFactsCalls: { projectPath: string; checkout?: string; baseRef?: string; branch?: string }[];
  forgotten: string[];
  archived: { conversationId: string; at: number }[];
  answers: { conversationId: string; askId: string; answer: string; name: string }[];
  relays: { conversationId: string; relay: { name: string } | null }[];
  /** 会话的后台任务投影与停任务记录 */
  tasks: Map<string, ObservedTask[]>;
  stoppedTasks: { conversationId: string; taskId: string }[];
  /** 派发模型的解析请求：按调用顺序记下 */
  resolvedModels: DispatchModelRef[];
}

function harness(
  options: {
    profile?: SecretaryProfile | null;
    projects?: ProjectAuthority[];
    conversations?: ConversationAuthority[];
    statuses?: Record<string, SecretarySessionStatus>;
    rows?: Record<string, Record<string, unknown>>;
    todos?: SecretaryTodo[];
    file?: SecretaryDispatchFile;
    createResult?: MainSessionResult;
    baseFacts?: Partial<DispatchBaseFacts>;
    waitStopped?: 'running' | 'idle' | 'waiting' | 'error';
    tasks?: Record<string, ObservedTask[]>;
    /** 可用模型白名单（`providerId/modelId`）；缺省表示都可用 */
    models?: string[];
    /** 目标会话的模型能否看图；缺省表示还不知道 */
    imageInput?: boolean;
  } = {}
): Harness {
  let ids = 0;
  const h: Harness = {
    file: options.file ?? emptyFile(),
    todos: options.todos ?? [],
    audits: [],
    created: [],
    prompts: [],
    resumes: [],
    aborts: [],
    queued: [],
    steers: [],
    pausedGoals: [],
    attachedGoals: [],
    attachGoalOk: true,
    profileValue: options.profile === undefined ? profile() : options.profile,
    appliedProfiles: [],
    appliedSkills: [],
    appliedTools: [],
    projects: options.projects ?? [localProject()],
    conversations: options.conversations ?? [rootConversation('c1')],
    statuses: new Map(Object.entries(options.statuses ?? {})),
    rows: options.rows ?? {},
    createResult: options.createResult ?? { ok: true, conversationId: 'new-1' },
    changed: 0,
    baseFacts: {
      knownCheckout: true,
      sameRepo: true,
      baseRefExists: true,
      branchExists: false,
      branchValid: true,
      ...options.baseFacts,
    },
    baseFactsCalls: [],
    forgotten: [],
    archived: [],
    answers: [],
    relays: [],
    tasks: new Map(Object.entries(options.tasks ?? {})),
    stoppedTasks: [],
    resolvedModels: [],
    ports: undefined as unknown as SecretaryDispatchPorts,
    handlers: undefined as unknown as ReturnType<typeof createSecretaryDispatchHandlers>,
  };
  h.ports = {
    profile: () => h.profileValue,
    applyProfile: async (draft) => {
      h.appliedProfiles.push(draft);
      return { ok: true };
    },
    applySkill: async (draft) => {
      h.appliedSkills.push(draft);
      return { ok: true };
    },
    applyTool: async (draft) => {
      h.appliedTools.push(draft);
      return { ok: true };
    },
    persona: () => '',
    // 与磁盘一致：每次读出的是新对象，改了不保存就不生效
    dispatchFile: () => structuredClone(h.file),
    saveDispatch: (file) => {
      h.file = structuredClone(file);
    },
    todos: () => h.todos,
    saveTodos: (todos) => {
      h.todos = todos;
    },
    audit: (entry) => {
      h.audits.push(entry);
    },
    projects: () => h.projects,
    conversations: () => h.conversations,
    rows: () => h.rows,
    status: (conversationId) => h.statuses.get(conversationId) ?? idle,
    createSession: async (request) => {
      h.created.push(request);
      return h.createResult;
    },
    prompt: (conversationId, text, deliveryId, images) => {
      h.prompts.push({ conversationId, text, deliveryId, ...(images ? { images } : {}) });
      return { ok: true };
    },
    resume: async (conversationId) => {
      h.resumes.push(conversationId);
      return { ok: true };
    },
    alive: () => true,
    abort: (conversationId) => {
      h.aborts.push(conversationId);
    },
    steer: (conversationId, text, deliveryId, images) => {
      h.steers.push({ conversationId, text, deliveryId, ...(images ? { images } : {}) });
      return { ok: true };
    },
    imageInput: () => options.imageInput,
    appendQueued: (conversationId, message) => {
      h.queued.push({ conversationId, message });
      const row = h.rows[conversationId] ?? {};
      const queued = Array.isArray(row.queuedMessages) ? row.queuedMessages : [];
      h.rows[conversationId] = { ...row, queuedMessages: [...queued, message] };
      return true;
    },
    dropQueued: (conversationId, messageIds) => {
      const row = h.rows[conversationId];
      const queued = Array.isArray(row?.queuedMessages) ? row.queuedMessages : [];
      const kept = queued.filter(
        (item) => !messageIds.includes((item as { id?: string }).id ?? '')
      );
      const removed = queued.length - kept.length;
      if (row && removed > 0) h.rows[conversationId] = { ...row, queuedMessages: kept };
      return removed;
    },
    pauseGoal: (conversationId) => {
      h.pausedGoals.push(conversationId);
    },
    attachGoal: (conversationId, goal, replaceable = []) => {
      h.attachedGoals.push({ conversationId, goal });
      const current = h.rows[conversationId]?.goal as
        | { text?: string; status?: string }
        | undefined;
      const live =
        current && typeof current === 'object' && current.status && current.status !== 'completed'
          ? current
          : undefined;
      const blocked = live && !(replaceable as readonly string[]).includes(live.status as string);
      if (!h.attachGoalOk || blocked) return { ok: false, error: 'goal-active' };
      const row = h.rows[conversationId] ?? {};
      h.rows[conversationId] = {
        ...row,
        goal: { text: goal, status: 'active', autoTurns: 0, noProgressRuns: 0 },
      };
      return {
        ok: true,
        ...(live ? { replaced: { text: live.text ?? '', status: live.status as string } } : {}),
      };
    },
    closeGoal: (conversationId, statuses) => {
      const row = h.rows[conversationId];
      const goal = row?.goal as { text: string; status: string; note?: string } | undefined;
      if (!row || !goal || !(statuses as readonly string[]).includes(goal.status)) return null;
      h.rows[conversationId] = { ...row, goal: undefined };
      return {
        text: goal.text,
        status: goal.status as 'blocked' | 'paused',
        ...(goal.note ? { note: goal.note } : {}),
      };
    },
    restoreGoal: (conversationId, goal) => {
      const row = h.rows[conversationId];
      if (!row || row.goal) return false;
      h.rows[conversationId] = {
        ...row,
        goal: { ...goal, autoTurns: 0, noProgressRuns: 0 },
      };
      return true;
    },
    cleanup: {
      git: async () => ({ code: 1, stdout: '', stderr: '' }),
      realpath: async (target) => target,
      worktreeRoots: () => [],
      size: async () => null,
      mergedPulls: async () => [],
      projects: () => h.projects,
      rows: () => h.rows,
      dispatchFile: () => structuredClone(h.file),
      removeWorktree: async () => ({ status: 'failed', reason: 'rename-failed' }),
      archive: (conversationId, at) => {
        h.archived.push({ conversationId, at });
      },
      audit: (entry) => {
        h.audits.push(entry);
      },
      now: () => NOW,
    },
    newId: () => `id-${++ids}`,
    now: () => NOW,
    baseFacts: async (input) => {
      h.baseFactsCalls.push(input);
      return h.baseFacts;
    },
    waitStopped: async () => options.waitStopped ?? 'idle',
    forget: (conversationId) => {
      h.forgotten.push(conversationId);
    },
    answer: async (conversationId, askId, answer, name) => {
      h.answers.push({ conversationId, askId, answer, name });
      return { ok: true };
    },
    relayAsk: (conversationId, relay) => {
      h.relays.push({ conversationId, relay });
    },
    tasks: (conversationId) => h.tasks.get(conversationId) ?? [],
    stopTask: async (conversationId, taskId) => {
      h.stoppedTasks.push({ conversationId, taskId });
      return { ok: true };
    },
    // 可用模型白名单：不传则全部可用；不可用的按真实报错文案拒绝
    resolveModel: async (ref) => {
      h.resolvedModels.push(ref);
      const key = `${ref.providerId}/${ref.modelId}`;
      if (options.models && !options.models.includes(key))
        return { ok: false, error: 'Model is unavailable: model-missing' };
      return { ok: true, model: ref };
    },
  };
  h.handlers = createSecretaryDispatchHandlers(h.ports);
  return h;
}

/** 旧版本留在盘上的待确认派发卡：派发不再出卡，但已有的卡照样能确认或拒绝 */
function legacyDispatchCard(
  h: Harness,
  draft: Partial<DispatchDraft> & { projectId: string; prompt: string }
): { proposalId: string } {
  const proposalId = `legacy-${Object.keys(h.file.proposals).length + 1}`;
  h.file.proposals[proposalId] = {
    id: proposalId,
    secretaryConversationId: 'sec-1',
    createdAt: NOW,
    updatedAt: NOW,
    status: 'pending',
    kind: 'dispatch',
    draft: { worktree: false, ...draft },
  };
  return { proposalId };
}

const call = (handler: SecretaryOpHandler, params: Record<string, unknown> = {}) =>
  handler(params, ctx);

async function run(
  handler: SecretaryOpHandler,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const result = await call(handler, params);
  if (!result.ok) throw new Error(`unexpected failure: ${result.error}`);
  return result.result;
}

describe('session_create', () => {
  it('派发不出确认卡：默认档案直接建会话', async () => {
    const h = harness();
    const result = await call(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(result).toEqual({ ok: true, result: { status: 'created', conversationId: 'new-1' } });
    expect(Object.keys(h.file.proposals)).toEqual([]);
    expect(h.audits).toEqual([
      {
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'session_create',
        targetId: 'new-1',
        ok: true,
        detail: 'created',
      },
    ]);
  });

  it('未设置档案时同样直接建会话', async () => {
    const h = harness({ profile: null });
    const result = await call(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(result).toMatchObject({ ok: true, result: { status: 'created' } });
    expect(h.created).toHaveLength(1);
  });

  it('旧档案写着 ask-first、关了静音和无人值守：照样直接派，派出的会话仍静音且无人值守', async () => {
    const old = parseProfile({
      autonomy: 'ask-first',
      autoApproveProjectIds: [],
      dispatchWorktree: 'always',
      dispatchMuted: false,
      dispatchUnattended: false,
    });
    const h = harness({ profile: old });
    const result = await call(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(result).toMatchObject({ ok: true, result: { status: 'created' } });
    expect(h.created[0]).toMatchObject({ worktree: false, muted: true, unattended: true });
  });

  it('直接建会话并记派出', async () => {
    const h = harness();
    const result = await call(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '修构建',
      goal: '构建通过',
    });
    expect(result).toEqual({ ok: true, result: { status: 'created', conversationId: 'new-1' } });
    expect(h.created).toEqual([
      {
        projectId: 'p1',
        prompt: '修构建',
        worktree: false,
        goal: '构建通过',
        secretaryOrigin: { secretaryConversationId: 'sec-1' },
        muted: true,
        unattended: true,
        askRelay: { name: h.profileValue?.name },
      },
    ]);
    expect(h.file.dispatched['new-1']).toEqual({
      conversationId: 'new-1',
      projectId: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: NOW,
      turn: 0,
      lastState: 'running',
      lastEventAt: NOW,
      stateSince: NOW,
      goal: '构建通过',
    });
    expect(h.audits.map((entry) => entry.op)).toEqual(['session_create']);
  });

  it('达到并发上限时照常建出排队会话：不报错、不运行，返回 queued 与位次', async () => {
    const file = emptyFile();
    for (const id of ['a', 'b', 'c']) {
      file.dispatched[id] = {
        conversationId: id,
        projectId: 'p1',
        secretaryConversationId: 'sec-1',
        createdAt: 1,
        turn: 0,
        lastState: 'running',
        lastEventAt: 1,
      };
    }
    const h = harness({
      file,
      profile: profile(),
      rows: {
        a: { title: 'a', sessionFile: '/a' },
        b: { title: 'b', sessionFile: '/b' },
        c: { title: 'c', sessionFile: '/c' },
      },
      statuses: { a: running, b: running, c: running },
    });
    const result = await call(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '修构建',
      goal: '构建通过',
    });
    expect(result).toMatchObject({
      ok: true,
      result: { status: 'queued', conversationId: 'new-1', position: 1, reason: 'dispatch-limit' },
    });
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ queued: true, goal: '构建通过' });
    // 排队会话记成空闲：重启恢复不会报中断，也不占派出名额
    expect(h.file.dispatched['new-1']).toMatchObject({ lastState: 'idle', goal: '构建通过' });
    expect(h.audits).toEqual([
      {
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'session_create',
        targetId: 'new-1',
        ok: true,
        detail: 'queued #1 dispatch-limit',
      },
    ]);
  });

  it('没超限的派发不排队：createSession 不带 queued，照常 created', async () => {
    const h = harness({ profile: profile() });
    const result = await call(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(result).toEqual({ ok: true, result: { status: 'created', conversationId: 'new-1' } });
    expect(h.created[0]).not.toHaveProperty('queued');
    expect(h.file.dispatched['new-1']).toMatchObject({ lastState: 'running' });
  });

  it('已有排队会话时新派发排在后面，位次接着数', async () => {
    const h = harness({
      profile: profile({ maxRunningDispatches: 1 }),
      rows: {
        q1: {
          projectId: 'p1',
          secretaryOrigin: { secretaryConversationId: 'sec-1' },
          queuedStart: { queuedAt: 10, text: '先排的' },
        },
      },
    });
    const result = await call(h.handlers.session_create, { projectId: 'p1', prompt: '后来的' });
    expect(result).toMatchObject({ ok: true, result: { status: 'queued', position: 2 } });
  });

  it('排队会话带图：只校验并存真实路径，开始时再读', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'queued-img-'));
    try {
      const shot = join(dir, 'shot.png');
      writeFileSync(shot, PNG);
      const h = harness({ profile: profile() });
      h.ports.runningTotal = () => ({ running: 10, max: 10 });
      h.handlers = createSecretaryDispatchHandlers(h.ports);
      const result = await call(h.handlers.session_create, {
        projectId: 'p1',
        prompt: '看图',
        attachments: [shot],
      });
      expect(result).toMatchObject({ ok: true, result: { status: 'queued' } });
      expect(h.created[0]).toMatchObject({ queued: true, attachmentPaths: [realpathSync(shot)] });
      expect(h.created[0]).not.toHaveProperty('attachments');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('基线校验在排队前就做：分支重名直接报错，不建排队会话', async () => {
    const h = harness({ profile: profile(), baseFacts: { branchExists: true } });
    h.ports.runningTotal = () => ({ running: 10, max: 10 });
    h.handlers = createSecretaryDispatchHandlers(h.ports);
    const result = await call(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '修构建',
      worktree: true,
      branch: 'feat/x',
    });
    expect(result).toEqual({ ok: false, error: 'branch-exists' });
    expect(h.created).toEqual([]);
  });

  it('全部秘书合计到上限时排队，本秘书自己的名额还有也一样', async () => {
    const h = harness({ profile: profile() });
    h.ports.runningTotal = () => ({ running: 10, max: 10 });
    h.handlers = createSecretaryDispatchHandlers(h.ports);
    const result = await call(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(result).toMatchObject({
      ok: true,
      result: { status: 'queued', reason: 'dispatch-limit-total' },
    });
    expect(h.created[0]).toMatchObject({ queued: true });
  });

  it('派出的会话带上秘书 id：之后靠它认归属', async () => {
    const h = harness({ profile: profile() });
    h.ports.secretaryId = 's-two';
    h.handlers = createSecretaryDispatchHandlers(h.ports);
    await call(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(h.created[0]).toMatchObject({
      secretaryOrigin: { secretaryConversationId: 'sec-1', secretaryId: 's-two' },
    });
  });

  it('空闲但还在等后台或自动续跑的会话也占派出名额，做完的不占', async () => {
    const waiting = emptyFile();
    waiting.dispatched.a = {
      conversationId: 'a',
      projectId: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: 1,
      turn: 1,
      lastState: 'idle',
      lastEventAt: 1,
      backgroundRunning: true,
    };
    const blocked = harness({
      file: waiting,
      profile: profile({
        maxRunningDispatches: 1,
      }),
      rows: {
        a: { title: '等后台', sessionFile: '/a', goal: { status: 'waiting', text: '等后台' } },
      },
      statuses: { a: idle },
    });
    expect(
      await call(blocked.handlers.session_create, { projectId: 'p1', prompt: '再派一个' })
    ).toMatchObject({ ok: true, result: { status: 'queued', reason: 'dispatch-limit' } });

    const finished = emptyFile();
    finished.dispatched.a = {
      ...waiting.dispatched.a,
      backgroundRunning: undefined,
      lastResult: { kind: 'goal-complete', turn: 1, at: 1 },
    };
    const open = harness({
      file: finished,
      profile: profile({
        maxRunningDispatches: 1,
      }),
      rows: {
        a: { title: '做完', sessionFile: '/a', goal: { status: 'completed', text: '做完' } },
      },
      statuses: { a: idle },
    });
    expect(
      await call(open.handlers.session_create, { projectId: 'p1', prompt: '再派一个' })
    ).toMatchObject({ ok: true, result: { status: 'created' } });
  });

  it('目标停在 waiting 却已经没有后台任务，不再占派出名额', async () => {
    const stale = emptyFile();
    stale.dispatched.a = {
      conversationId: 'a',
      projectId: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: 1,
      turn: 1,
      lastState: 'idle',
      lastEventAt: 1,
    };
    const h = harness({
      file: stale,
      profile: profile({
        maxRunningDispatches: 1,
      }),
      rows: {
        a: { title: '等验收', sessionFile: '/a', goal: { status: 'waiting', text: '等验收' } },
      },
      statuses: { a: idle },
    });
    expect(
      await call(h.handlers.session_create, { projectId: 'p1', prompt: '再派一个' })
    ).toMatchObject({ ok: true, result: { status: 'created' } });
  });

  it('项目不可见时拒绝', async () => {
    const h = harness({ profile: profile({ visibleProjectIds: ['p2'] }) });
    const result = await call(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(result).toEqual({ ok: false, error: 'project-not-visible' });
    expect(h.created).toEqual([]);
  });
});

describe('session_send', () => {
  it('模型拿到的 schema 字段 Main 全部认得，必填项一致', async () => {
    const tools = createSecretaryTools({ invoke: async () => ({}) } as never);
    const sample: Record<string, string> = { conversationId: 'c1', message: '继续' };
    for (const op of ['session_send', 'session_stop'] as const) {
      const schema = tools.find((tool) => tool.name === op)?.parameters as unknown as {
        properties: Record<string, unknown>;
        required: string[];
      };
      const h = harness({ file: dispatchedFile() });
      const params = Object.fromEntries(
        Object.keys(schema.properties).map((key) => [key, sample[key]])
      );
      expect((await call(h.handlers[op], params)).ok, op).toBe(true);
      for (const key of schema.required) {
        const { [key]: _omitted, ...rest } = params;
        const result = await call(harness({ file: dispatchedFile() }).handlers[op], rest);
        expect(result.ok ? '' : result.error, `${op} 缺 ${key}`).toContain(`"${key}" is required`);
      }
    }
  });

  it('未派出且未点名的会话拒绝发送', async () => {
    const h = harness();
    const result = await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' });
    expect(result).toEqual({ ok: false, error: NOT_OPERABLE_ERROR });
    // 拒绝原因要说清，并指出可以申请接管
    expect(NOT_OPERABLE_ERROR).toMatch(/^permission denied \(not-operable\): /u);
    expect(NOT_OPERABLE_ERROR).toContain('session_takeover_propose');
    expect(NOT_OPERABLE_ERROR).not.toContain('invalid arguments');
    expect(h.prompts).toEqual([]);
    expect(h.audits.map((entry) => [entry.ok, entry.detail])).toEqual([[false, 'not-operable']]);
  });

  it('秘书派出的会话：模型侧参数经归一化后直接发到 Main 能发出', async () => {
    for (const raw of [
      { conversationId: 'c1', message: 'test' },
      { conversationId: 'c1', text: '请继续把构建修好'.repeat(40) },
      { sessionId: 'c1', content: '继续' },
    ]) {
      const h = harness({ file: dispatchedFile() });
      const params = normalizeSecretaryParams('session_send', raw) as Record<string, unknown>;
      const result = await call(h.handlers.session_send, params);
      expect(result).toEqual({ ok: true, result: { status: 'sent' } });
      expect(h.prompts).toEqual([
        { conversationId: 'c1', text: params.message as string, deliveryId: 'id-1' },
      ]);
    }
  });

  it('项目不可见时给出明确的拒绝原因', async () => {
    const h = harness({ file: dispatchedFile(), profile: profile({ visibleProjectIds: ['p2'] }) });
    const result = await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^permission denied \(not-visible\): /u);
    expect(h.prompts).toEqual([]);
  });

  it.each([
    ['缺 conversationId', { message: '继续' }, 'conversationId'],
    ['conversationId 为空', { conversationId: '', message: '继续' }, 'conversationId'],
    ['conversationId 非字符串', { conversationId: 42, message: '继续' }, 'conversationId'],
    ['conversationId 超长', { conversationId: 'x'.repeat(201), message: '继续' }, 'conversationId'],
    ['缺 message', { conversationId: 'c1' }, 'message'],
    ['message 全是空白', { conversationId: 'c1', message: '   ' }, 'message'],
    ['message 非字符串', { conversationId: 'c1', message: ['继续'] }, 'message'],
    ['message 超长', { conversationId: 'c1', message: 'x'.repeat(8001) }, 'message'],
    ['未归一化的旧字段 text', { conversationId: 'c1', text: '继续' }, 'text'],
  ])('参数不合法时指出字段：%s', async (_label, params, field) => {
    const h = harness({ file: dispatchedFile() });
    const result = await call(h.handlers.session_send, params);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^invalid arguments: /u);
    expect(result.error).toContain(field);
    expect(h.prompts).toEqual([]);
    expect(h.queued).toEqual([]);
  });

  it('目标有待审批时拒绝并提示需要用户', async () => {
    const h = harness({
      file: dispatchedFile(),
      statuses: { c1: { state: 'waiting', pendingAsks: 0, pendingApprovals: 1 } },
    });
    const result = await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^refused \(needs-user\): /u);
    expect(h.prompts).toEqual([]);
  });

  it('运行中把消息追加到排队', async () => {
    const h = harness({
      file: dispatchedFile(),
      statuses: { c1: { state: 'running', pendingAsks: 0, pendingApprovals: 0 } },
    });
    const result = await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' });
    expect(result).toEqual({ ok: true, result: { status: 'queued' } });
    expect(h.queued).toEqual([
      {
        conversationId: 'c1',
        message: { id: 'id-1', text: '继续', origin: 'secretary', by: 'sec-1', at: NOW },
      },
    ]);
    expect(h.prompts).toEqual([]);
  });

  it('空闲且 worker 活着时直接发消息', async () => {
    const h = harness({ file: dispatchedFile() });
    const result = await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' });
    expect(result).toEqual({ ok: true, result: { status: 'sent' } });
    expect(h.resumes).toEqual([]);
    expect(h.prompts).toEqual([{ conversationId: 'c1', text: '继续', deliveryId: 'id-1' }]);
  });

  it('worker 已释放时先恢复再发', async () => {
    const h = harness({ file: dispatchedFile() });
    h.ports.alive = () => false;
    const result = await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' });
    expect(result).toEqual({ ok: true, result: { status: 'sent' } });
    expect(h.resumes).toEqual(['c1']);
    expect(h.prompts).toHaveLength(1);
  });

  it('完成后被重新唤起，记录回到运行中，关联待办也回到进行中', async () => {
    const file = dispatchedFile();
    file.dispatched.c1.lastResult = { kind: 'goal-complete', turn: 2, at: 900 };
    const h = harness({
      file,
      rows: { c1: { title: '记忆', sessionFile: '/c1', projectId: 'p1' } },
      statuses: { c1: idle },
      todos: [
        {
          id: 't1',
          text: '改记忆',
          createdAt: 1,
          updatedAt: 1,
          conversationId: 'c1',
          doneAt: 900,
        },
      ],
    });
    const before = await buildSecretaryState(h.ports, { enabled: true, projectId: 'sec' });
    expect(before.board.running).toEqual([]);
    expect(
      await call(h.handlers.session_send, { conversationId: 'c1', message: '接着做' })
    ).toEqual({
      ok: true,
      result: { status: 'sent' },
    });
    expect(h.file.dispatched.c1.lastState).toBe('running');
    expect(h.todos[0].doneAt).toBeUndefined();
    const after = await buildSecretaryState(h.ports, { enabled: true, projectId: 'sec' });
    expect(
      after.board.running.map((card) => (card.kind === 'session' ? card.conversationId : ''))
    ).toEqual(['c1']);
    expect(after.board.todos.map((todo) => todo.phase)).toEqual(['active']);
  });

  it('恢复失败时不发消息', async () => {
    const h = harness({ file: dispatchedFile() });
    h.ports.alive = () => false;
    h.ports.resume = async () => ({ ok: false, error: 'no session file' });
    const result = await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' });
    expect(result).toEqual({ ok: false, error: 'no session file' });
    expect(h.prompts).toEqual([]);
  });

  it('mode=steer 在运行中插话，不排到回合后面', async () => {
    const h = harness({
      file: dispatchedFile(),
      statuses: { c1: { state: 'running', pendingAsks: 0, pendingApprovals: 0 } },
    });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '先修这个',
      mode: 'steer',
    });
    expect(result).toEqual({ ok: true, result: { status: 'steered' } });
    expect(h.steers).toEqual([{ conversationId: 'c1', text: '先修这个', deliveryId: 'id-1' }]);
    expect(h.queued).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(h.audits).toEqual([
      {
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'session_send',
        targetId: 'c1',
        ok: true,
        detail: 'steered (dispatched)',
      },
    ]);
  });

  it('mode=steer 时目标空闲就开新轮，没有活轮可插', async () => {
    const h = harness({ file: dispatchedFile() });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '换个方向',
      mode: 'steer',
    });
    expect(result).toEqual({ ok: true, result: { status: 'sent' } });
    expect(h.steers).toEqual([]);
    expect(h.prompts).toEqual([{ conversationId: 'c1', text: '换个方向', deliveryId: 'id-1' }]);
  });

  it('mode=steer 时目标在等用户也拒绝', async () => {
    const h = harness({
      file: dispatchedFile(),
      statuses: { c1: { state: 'running', pendingAsks: 1, pendingApprovals: 0 } },
    });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '先修这个',
      mode: 'steer',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^refused \(needs-user\): /u);
    expect(h.steers).toEqual([]);
    expect(h.queued).toEqual([]);
  });

  it('带 goal 且目标已完成：把新目标挂回会话行，会话按这个目标继续跑', async () => {
    const h = harness({
      file: dispatchedFile(),
      rows: { c1: { id: 'c1', driver: 'main', goal: undefined } },
    });
    h.file.dispatched.c1.lastResult = { kind: 'goal-complete', turn: 2, at: 900 };
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '再查一遍安装脚本',
      goal: '查清安装脚本有没有真的执行',
    });
    expect(result).toEqual({ ok: true, result: { status: 'sent' } });
    expect(h.rows.c1.goal).toEqual({
      text: '查清安装脚本有没有真的执行',
      status: 'active',
      autoTurns: 0,
      noProgressRuns: 0,
    });
    expect(h.file.dispatched.c1.goal).toBe('查清安装脚本有没有真的执行');
  });

  it('没有目标的会话带 goal 同样挂上', async () => {
    const h = harness({
      file: dispatchedFile(),
      rows: { c1: { id: 'c1', driver: 'main' } },
    });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '接着做',
      goal: '把构建修好',
    });
    expect(result).toEqual({ ok: true, result: { status: 'sent' } });
    expect(h.rows.c1.goal).toMatchObject({ text: '把构建修好', status: 'active' });
  });

  it('原来的目标还没完成时带 goal 被拒绝，目标原样保留', async () => {
    const live = { text: '把构建修好', status: 'active', autoTurns: 3, noProgressRuns: 0 };
    const h = harness({
      file: dispatchedFile(),
      rows: { c1: { id: 'c1', driver: 'main', goal: live } },
    });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '换个目标',
      goal: '另一个目标',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^refused \(goal-active\): /u);
    expect(h.rows.c1.goal).toEqual(live);
    expect(h.prompts).toEqual([]);
  });

  it('目标在等外部条件（waiting）时带 goal 同样被拒绝', async () => {
    const parked = { text: '等 CI', status: 'waiting', autoTurns: 1, noProgressRuns: 0 };
    const h = harness({
      file: dispatchedFile(),
      rows: { c1: { id: 'c1', driver: 'main', goal: parked } },
    });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '换个目标',
      goal: '另一个目标',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^refused \(goal-active\): /u);
    expect(h.rows.c1.goal).toEqual(parked);
    expect(h.prompts).toEqual([]);
  });

  it('受阻或暂停的目标可以被带 goal 的追加替换，审计记下被替换的旧目标', async () => {
    for (const status of ['blocked', 'paused']) {
      const h = harness({
        file: dispatchedFile(),
        rows: { c1: { id: 'c1', driver: 'main', goal: { text: '旧目标', status } } },
      });
      const result = await call(h.handlers.session_send, {
        conversationId: 'c1',
        message: '改一下文案',
        goal: '把文案改好并推送',
      });
      expect(result).toEqual({ ok: true, result: { status: 'sent' } });
      expect(h.rows.c1.goal).toMatchObject({ text: '把文案改好并推送', status: 'active' });
      expect(h.file.dispatched.c1.goal).toBe('把文案改好并推送');
      expect(h.audits).toContainEqual({
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'session_goal_replace',
        targetId: 'c1',
        ok: true,
        detail: `${status}: 旧目标`,
      });
    }
  });

  /** 追加任务重新打开跟踪：带旧终态与旧停滞标记的记录 */
  const closed = (lastResult: NonNullable<DispatchRecord['lastResult']>) => {
    const file = dispatchedFile();
    file.dispatched.c1 = {
      ...file.dispatched.c1,
      turn: 2,
      lastResult,
      stalledTurn: 2,
      patrol: { reason: 'goal-idle-stalled', turn: 2, at: 950 },
    };
    return file;
  };

  it('goal-complete、failed、interrupted、stalled 之后再发消息：撤下旧终态重新跟踪', async () => {
    const results: NonNullable<DispatchRecord['lastResult']>[] = [
      { kind: 'goal-complete', turn: 2, at: 950 },
      { kind: 'failed', turn: 2, at: 950 },
      { kind: 'interrupted', turn: 2, at: 950 },
      { kind: 'stalled', turn: 2, at: 950 },
    ];
    for (const lastResult of results) {
      const h = harness({ file: closed(lastResult), rows: { c1: { id: 'c1', driver: 'main' } } });
      const result = await call(h.handlers.session_send, {
        conversationId: 'c1',
        message: '再改一处',
      });
      expect(result).toEqual({ ok: true, result: { status: 'sent' } });
      const record = h.file.dispatched.c1;
      expect(record.lastResult).toBeUndefined();
      expect(record).toMatchObject({ lastState: 'running', reopenedAt: NOW });
      // 旧的停滞标记不能把这一轮的停滞去重掉
      expect(record.stalledTurn).toBeUndefined();
      expect(record.patrol).toBeUndefined();
    }
  });

  it('重新打开的标记落盘再读回仍在', async () => {
    const h = harness({
      file: closed({ kind: 'goal-complete', turn: 2, at: 950, manual: true }),
      rows: { c1: { id: 'c1', driver: 'main' } },
    });
    await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '再改一处',
      goal: '补完下一处修改',
    });
    const restored = parseDispatchFile(JSON.parse(JSON.stringify(h.file)));
    expect(restored.dispatched.c1.reopenedAt).toBe(NOW);
  });

  it('mark_done 收掉受阻目标，之后带 goal 的追加能挂上', async () => {
    const h = harness({
      file: dispatchedFile(),
      rows: {
        c1: {
          id: 'c1',
          driver: 'main',
          goal: { text: '旧目标', status: 'blocked', note: '等审批' },
        },
      },
    });
    expect(await markResult(h.ports, 'c1', 'done')).toEqual({ ok: true });
    expect(h.rows.c1.goal).toBeUndefined();
    expect(h.file.dispatched.c1.closedGoal).toEqual({
      text: '旧目标',
      status: 'blocked',
      note: '等审批',
    });
    expect(h.audits.at(-1)).toMatchObject({
      op: 'result_mark_done',
      detail: 'manual; goal closed (blocked)',
    });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '追加一个修改',
      goal: '改完并推送',
    });
    expect(result).toEqual({ ok: true, result: { status: 'sent' } });
    expect(h.rows.c1.goal).toMatchObject({ text: '改完并推送', status: 'active' });
    // 重新跟踪后手动标记已经不在，收掉的旧目标也不再能恢复
    expect(h.file.dispatched.c1.closedGoal).toBeUndefined();
  });

  it('mark_undo 恢复被收掉的目标', async () => {
    const h = harness({
      file: dispatchedFile(),
      rows: { c1: { id: 'c1', driver: 'main', goal: { text: '旧目标', status: 'paused' } } },
    });
    await markResult(h.ports, 'c1', 'done');
    expect(await markResult(h.ports, 'c1', 'undo')).toEqual({ ok: true });
    expect(h.rows.c1.goal).toMatchObject({ text: '旧目标', status: 'paused' });
    expect(h.file.dispatched.c1.closedGoal).toBeUndefined();
    expect(h.file.dispatched.c1.lastResult).toBeUndefined();
    expect(h.audits.at(-1)).toMatchObject({
      op: 'result_mark_undo',
      detail: 'manual; goal restored (paused)',
    });
  });

  it('mark_done 不动正在跑或在等的目标', async () => {
    for (const status of ['active', 'waiting']) {
      const goal = { text: '目标', status };
      const h = harness({
        file: dispatchedFile(),
        rows: { c1: { id: 'c1', driver: 'main', goal } },
      });
      expect(await markResult(h.ports, 'c1', 'done')).toEqual({ ok: true });
      expect(h.rows.c1.goal).toEqual(goal);
      expect(h.file.dispatched.c1.closedGoal).toBeUndefined();
    }
  });

  it('goal 为空或超长时指出字段，不改目标', async () => {
    for (const goal of ['   ', 'x'.repeat(4001)]) {
      const h = harness({ file: dispatchedFile(), rows: { c1: { id: 'c1', driver: 'main' } } });
      const result = await call(h.handlers.session_send, {
        conversationId: 'c1',
        message: '继续',
        goal,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/^invalid arguments: /u);
      expect(result.error).toContain('goal');
      expect(h.prompts).toEqual([]);
    }
  });

  it('mode 只认 queue 与 steer', async () => {
    const h = harness({ file: dispatchedFile() });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '继续',
      mode: 'interrupt',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^invalid arguments: /u);
    expect(result.error).toContain('mode');
    expect(h.queued).toEqual([]);
    expect(h.steers).toEqual([]);
  });
});

describe('session_send 转发图片', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'enso-attach-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** 真文件：白名单校验走的是真实路径与文件头，不模拟 */
  function image(name: string, bytes: Uint8Array = PNG): string {
    const file = join(dir, name);
    writeFileSync(file, bytes);
    // 白名单按真实路径判定：macOS 上 /var 是 /private/var 的符号链接
    return realpathSync(file);
  }

  it('带 attachments 时把图片引用追加到消息末尾，并审计路径与大小', async () => {
    const shot = image('shot.png');
    const h = harness({ file: dispatchedFile() });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '这个界面丑，按图改',
      attachments: [shot],
    });
    expect(result).toEqual({ ok: true, result: { status: 'sent' } });
    const text = h.prompts[0]?.text ?? '';
    expect(text).toContain('这个界面丑，按图改');
    expect(text).toContain(`[图片 1] ${shot}`);
    expect(text).toContain('用 image_view 查看这些图片。');
    const audit = h.audits.find((entry) => entry.op === 'session_send' && entry.ok);
    expect(audit?.detail).toContain(`images: ${shot} (${PNG.length} B)`);
  });

  it('排队与插话也带上图片引用', async () => {
    const shot = image('shot.png');
    const queued = harness({ file: dispatchedFile(), statuses: { c1: running } });
    await call(queued.handlers.session_send, {
      conversationId: 'c1',
      message: '按图改',
      attachments: [shot],
    });
    expect(queued.queued[0]?.message.text).toContain(`[图片 1] ${shot}`);

    const steered = harness({ file: dispatchedFile(), statuses: { c1: running } });
    await call(steered.handlers.session_send, {
      conversationId: 'c1',
      message: '按图改',
      mode: 'steer',
      attachments: [shot],
    });
    expect(steered.steers[0]?.text).toContain(`[图片 1] ${shot}`);
  });

  it('目标会话没有 image_view 时说明看不了图', async () => {
    const shot = image('shot.png');
    const h = harness({ file: dispatchedFile(), rows: { c1: { tools: ['read', 'bash'] } } });
    await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '按图改',
      attachments: [shot],
    });
    expect(h.prompts[0]?.text).toContain('当前会话无法查看图片');
  });

  it('路径越界时指出是哪一张、为什么，且什么都不发', async () => {
    const h = harness({ file: dispatchedFile() });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '按图改',
      attachments: [image('ok.png'), '/etc/hosts'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('attachments[2] /etc/hosts');
    expect(result.error).toContain('out of scope');
    expect(h.prompts).toEqual([]);
    expect(h.queued).toEqual([]);
    expect(h.audits.some((entry) => entry.op === 'session_send' && !entry.ok)).toBe(true);
  });

  it('文件不存在时拒绝', async () => {
    const h = harness({ file: dispatchedFile() });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '按图改',
      attachments: [join(dir, 'missing.png')],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('no such file');
    expect(h.prompts).toEqual([]);
  });

  it('不是图片时拒绝', async () => {
    const h = harness({ file: dispatchedFile() });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '按图改',
      attachments: [image('fake.png', Uint8Array.from([1, 2, 3, 4]))],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('not a supported image');
  });

  it('超过 5 张直接拒绝', async () => {
    const h = harness({ file: dispatchedFile() });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '按图改',
      attachments: Array.from({ length: 6 }, (_unused, index) => image(`a${index}.png`)),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('max 5 images per call');
    expect(h.prompts).toEqual([]);
  });

  it('空白条目直接丢弃，不让整次调用失败；全空等同没传', async () => {
    const empty = harness({ file: dispatchedFile() });
    const none = await call(empty.handlers.session_send, {
      conversationId: 'c1',
      message: '按图改',
      attachments: [''],
    });
    expect(none).toEqual({ ok: true, result: { status: 'sent' } });
    expect(empty.prompts[0]?.text).not.toContain('[图片');

    const a = image('a.png');
    const b = image('b.png');
    const one = harness({ file: dispatchedFile() });
    expect(
      await call(one.handlers.session_send, {
        conversationId: 'c1',
        message: '按图改',
        attachments: ['  ', a],
      })
    ).toEqual({ ok: true, result: { status: 'sent' } });
    expect(one.prompts[0]?.text).toContain(`[图片 1] ${a}`);
    expect(one.prompts[0]?.text).not.toContain('[图片 2]');

    const two = harness({ file: dispatchedFile() });
    expect(
      await call(two.handlers.session_send, {
        conversationId: 'c1',
        message: '按图改',
        attachments: [a, '', b],
      })
    ).toEqual({ ok: true, result: { status: 'sent' } });
    const text = two.prompts[0]?.text ?? '';
    expect(text).toContain(`[图片 1] ${a}`);
    expect(text).toContain(`[图片 2] ${b}`);
  });

  it('空白条目不占张数上限', async () => {
    const h = harness({ file: dispatchedFile() });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '按图改',
      attachments: [...Array.from({ length: 5 }, (_unused, index) => image(`a${index}.png`)), ''],
    });
    expect(result).toEqual({ ok: true, result: { status: 'sent' } });
    expect(h.prompts[0]?.text).toContain('[图片 5]');
  });

  it('非字符串条目与超长路径仍然拒绝', async () => {
    for (const [attachments, expected] of [
      [[123], 'must be a string, got number'],
      [['', 'x'.repeat(1025)], 'entry 2 is 1025 characters, max 1024'],
    ] as const) {
      const h = harness({ file: dispatchedFile() });
      const result = await call(h.handlers.session_send, {
        conversationId: 'c1',
        message: '按图改',
        attachments,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/^invalid arguments: /u);
      expect(result.error).toContain(expected);
      expect(h.prompts).toEqual([]);
    }
  });

  const block = (data: Uint8Array = PNG) => ({
    data: Buffer.from(data).toString('base64'),
    mimeType: 'image/png',
  });

  it('模型能看图时作为图片块随消息发出，正文末尾留路径行，不再让它调 image_view', async () => {
    const shot = image('shot.png');
    const h = harness({ file: dispatchedFile(), imageInput: true });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '这个界面丑，按图改',
      attachments: [shot],
    });
    expect(result).toEqual({ ok: true, result: { status: 'sent' } });
    expect(h.prompts[0]?.images).toEqual([block()]);
    expect(h.prompts[0]?.text).toBe(`这个界面丑，按图改\n\n[图片 1] ${shot}`);
  });

  it('插话与排队同样带图片块', async () => {
    const shot = image('shot.png');
    const steered = harness({
      file: dispatchedFile(),
      statuses: { c1: running },
      imageInput: true,
    });
    await call(steered.handlers.session_send, {
      conversationId: 'c1',
      message: '按图改',
      mode: 'steer',
      attachments: [shot],
    });
    expect(steered.steers[0]?.images).toEqual([block()]);
    expect(steered.steers[0]?.text).toBe(`按图改\n\n[图片 1] ${shot}`);

    const queued = harness({ file: dispatchedFile(), statuses: { c1: running }, imageInput: true });
    await call(queued.handlers.session_send, {
      conversationId: 'c1',
      message: '按图改',
      attachments: [shot],
    });
    expect(queued.queued[0]?.message.images).toEqual([block()]);
    expect(queued.queued[0]?.message.text).toBe(`按图改\n\n[图片 1] ${shot}`);
  });

  it('模型不能看图时不发图片块，退回路径加 image_view', async () => {
    const shot = image('shot.png');
    const h = harness({ file: dispatchedFile(), imageInput: false });
    await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '按图改',
      attachments: [shot],
    });
    expect(h.prompts[0]?.images).toBeUndefined();
    expect(h.prompts[0]?.text).toContain(`[图片 1] ${shot}`);
    expect(h.prompts[0]?.text).toContain('用 image_view 查看这些图片。');
  });

  it('超过 10MB 时整条拒绝并说明原因', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    const h = harness({ file: dispatchedFile(), imageInput: true });
    const result = await call(h.handlers.session_send, {
      conversationId: 'c1',
      message: '按图改',
      attachments: [image('big.png', big)],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('attachments[1]');
    expect(result.error).toContain('too large');
    expect(h.prompts).toEqual([]);
  });

  it('session_create 带图：图片读好交给建会话，跟着第一条 prompt 进去', async () => {
    const shot = image('shot.png');
    const h = harness();
    const result = await call(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '按图改首页',
      attachments: [shot],
    });
    expect(result).toMatchObject({ ok: true, result: { status: 'created' } });
    expect(h.created[0]?.attachments).toEqual({
      images: [{ path: shot, size: PNG.length, ...block() }],
    });
  });

  it('session_create 的图不合法时整条拒绝，不建会话', async () => {
    const h = harness();
    const result = await call(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '按图改首页',
      attachments: ['/etc/hosts'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('attachments[1] /etc/hosts');
    expect(h.created).toEqual([]);
  });

  it('todo_item_dispatch 带图', async () => {
    const shot = image('shot.png');
    const h = harness({
      todos: [{ id: 't1', text: '首页改版', createdAt: 1, updatedAt: 1, projectId: 'p1' }],
    });
    const result = await call(h.handlers.todo_item_dispatch, {
      todoId: 't1',
      attachments: [shot],
    });
    expect(result).toMatchObject({ ok: true, result: { status: 'created' } });
    expect(h.created[0]?.attachments?.images).toEqual([
      { path: shot, size: PNG.length, ...block() },
    ]);
  });

  describe('等依赖的派发', () => {
    const dependencyDone = () =>
      harness({
        rows: { c1: { projectId: 'p1', title: 'c1', sessionFile: '/s/c1.jsonl' } },
        statuses: { c1: idle },
        file: {
          ...emptyFile(),
          dispatched: {
            c1: {
              conversationId: 'c1',
              projectId: 'p1',
              secretaryConversationId: 'sec-1',
              createdAt: 1,
              turn: 1,
              lastState: 'idle',
              lastEventAt: 1,
              lastResult: { kind: 'turn-ended', turn: 1, at: 1 },
            },
          },
        },
      });

    it('只存路径，真正开始时才读图', async () => {
      const shot = image('shot.png');
      const h = dependencyDone();
      const payload = (await run(h.handlers.session_create, {
        projectId: 'p1',
        prompt: '接着改',
        after: ['c1'],
        attachments: [shot],
      })) as { pendingId: string };
      const stored = parseDispatchFile(JSON.parse(JSON.stringify(h.file)));
      expect(stored.pending?.[payload.pendingId]?.draft.attachments).toEqual([shot]);
      // 等待期间图片换了内容：开始时读到的是新的
      const later = Uint8Array.from([...PNG, 0]);
      writeFileSync(shot, later);
      h.file = stored;
      await startPendingDispatches(h.ports, [payload.pendingId], NOW);
      expect(h.created[0]?.attachments).toEqual({
        images: [{ path: shot, size: later.length, ...block(later) }],
      });
    });

    it('开始时图片已不在：照常派发，注明哪张不可用', async () => {
      const shot = image('shot.png');
      const h = dependencyDone();
      const payload = (await run(h.handlers.session_create, {
        projectId: 'p1',
        prompt: '接着改',
        after: ['c1'],
        attachments: [shot],
      })) as { pendingId: string };
      unlinkSync(shot);
      await startPendingDispatches(h.ports, [payload.pendingId], NOW);
      expect(h.created).toHaveLength(1);
      expect(h.created[0]?.attachments?.images).toEqual([]);
      expect(h.created[0]?.attachments?.unavailable).toEqual([
        { path: shot, reason: expect.stringContaining('no such file') },
      ]);
    });
  });
});

describe('秘书自己的排队消息', () => {
  const queuedRow = (queued: unknown[]) => ({
    c1: { title: '在跑', sessionFile: '/c1', queuedMessages: queued },
  });
  const mine = { id: 'q-sec', text: '秘书排的', origin: 'secretary', by: 'sec-1', at: 900 };
  const other = { id: 'q-sec-2', text: '别的秘书排的', origin: 'secretary', by: 'sec-2', at: 901 };
  const user = { id: 'q-user', text: '用户排的' };

  it('只列出秘书自己排的消息，用户的只报条数', async () => {
    const h = harness({ file: dispatchedFile(), rows: queuedRow([user, mine, other]) });
    const result = await call(h.handlers.session_queue_list, { conversationId: 'c1' });
    expect(result).toEqual({
      ok: true,
      result: {
        conversationId: 'c1',
        queued: [{ id: 'q-sec', text: '秘书排的', at: 900 }],
        others: 2,
      },
    });
  });

  it('撤回自己排的消息并记审计', async () => {
    const h = harness({ file: dispatchedFile(), rows: queuedRow([user, mine]) });
    const result = await call(h.handlers.session_queue_cancel, {
      conversationId: 'c1',
      messageId: 'q-sec',
    });
    expect(result).toEqual({
      ok: true,
      result: { status: 'cancelled', conversationId: 'c1', messageId: 'q-sec' },
    });
    expect(h.rows.c1.queuedMessages).toEqual([user]);
    expect(h.audits).toEqual([
      {
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'session_queue_cancel',
        targetId: 'q-sec',
        ok: true,
        detail: 'cancelled',
      },
    ]);
  });

  it('用户排的与别的秘书排的都不能撤回', async () => {
    const h = harness({ file: dispatchedFile(), rows: queuedRow([user, other]) });
    for (const messageId of ['q-user', 'q-sec-2']) {
      const result = await call(h.handlers.session_queue_cancel, {
        conversationId: 'c1',
        messageId,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/^refused \(not-yours\): /u);
    }
    expect(h.rows.c1.queuedMessages).toEqual([user, other]);
    expect(h.audits.map((entry) => entry.detail)).toEqual(['not-yours', 'not-yours']);
  });

  it('已经投递掉的消息撤回时报 not found', async () => {
    const h = harness({ file: dispatchedFile(), rows: queuedRow([]) });
    const result = await call(h.handlers.session_queue_cancel, {
      conversationId: 'c1',
      messageId: 'q-gone',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^not found: /u);
  });
});

describe('session_stop', () => {
  it('停止会话，有目标时置为暂停', async () => {
    const file = dispatchedFile();
    file.dispatched.c1.goal = '构建通过';
    const h = harness({ file });
    const result = await call(h.handlers.session_stop, { conversationId: 'c1' });
    expect(result).toEqual({ ok: true, result: { status: 'stopped' } });
    expect(h.aborts).toEqual(['c1']);
    expect(h.pausedGoals).toEqual(['c1']);
    expect(h.audits.map((entry) => entry.op)).toEqual(['session_stop']);
  });

  it('停止后清掉残留的运行中与后台任务记录，不再算在跑', async () => {
    const file = dispatchedFile();
    file.dispatched.c1.lastState = 'running';
    file.dispatched.c1.backgroundRunning = true;
    const h = harness({ file, rows: { c1: { title: '在跑', sessionFile: '/c1' } } });
    await call(h.handlers.session_stop, { conversationId: 'c1' });
    expect(h.file.dispatched.c1.lastState).toBe('idle');
    expect(h.file.dispatched.c1.backgroundRunning).toBeUndefined();
    // 停止要留一个看板能认出来的标记：只写 idle 会被当成「报过结果又没给新结果」直接算完成
    expect(h.file.dispatched.c1.stoppedAt).toBe(NOW);
  });

  it('未派出的会话拒绝停止', async () => {
    const h = harness();
    const result = await call(h.handlers.session_stop, { conversationId: 'c1' });
    expect(result).toEqual({ ok: false, error: NOT_OPERABLE_ERROR });
    expect(h.aborts).toEqual([]);
  });

  it('模型侧参数经归一化后能停止派出的会话', async () => {
    const h = harness({ file: dispatchedFile() });
    const params = normalizeSecretaryParams('session_stop', { sessionId: 'c1' }) as Record<
      string,
      unknown
    >;
    const result = await call(h.handlers.session_stop, params);
    expect(result).toEqual({ ok: true, result: { status: 'stopped' } });
    expect(h.aborts).toEqual(['c1']);
  });

  it('默认保留队列：秘书排的和用户排的都还在', async () => {
    const queued = [
      { id: 'q-user', text: '用户排的' },
      { id: 'q-sec', text: '秘书排的', origin: 'secretary', by: 'sec-1', at: 900 },
    ];
    const h = harness({
      file: dispatchedFile(),
      rows: { c1: { title: '在跑', sessionFile: '/c1', queuedMessages: queued } },
    });
    const result = await call(h.handlers.session_stop, { conversationId: 'c1' });
    expect(result).toEqual({ ok: true, result: { status: 'stopped' } });
    expect(h.rows.c1.queuedMessages).toEqual(queued);
    expect(h.audits.map((entry) => entry.detail)).toEqual(['stopped (dispatched)']);
  });

  it('clearQueue 只清秘书自己排的，用户排的一条不动', async () => {
    const user = { id: 'q-user', text: '用户排的' };
    const other = {
      id: 'q-sec-2',
      text: '别的秘书排的',
      origin: 'secretary',
      by: 'sec-2',
      at: 901,
    };
    const mine = { id: 'q-sec', text: '秘书排的', origin: 'secretary', by: 'sec-1', at: 900 };
    const h = harness({
      file: dispatchedFile(),
      rows: { c1: { title: '在跑', sessionFile: '/c1', queuedMessages: [user, other, mine] } },
    });
    const result = await call(h.handlers.session_stop, {
      conversationId: 'c1',
      clearQueue: true,
    });
    expect(result).toEqual({ ok: true, result: { status: 'stopped', clearedQueued: 1 } });
    expect(h.rows.c1.queuedMessages).toEqual([user, other]);
    expect(h.audits.map((entry) => entry.detail)).toEqual([
      'stopped (dispatched), cleared 1 queued',
    ]);
    expect(h.aborts).toEqual(['c1']);
  });

  it.each([
    ['缺 conversationId', {}, 'conversationId'],
    ['conversationId 全是空白', { conversationId: '  ' }, 'conversationId'],
    ['多余字段', { conversationId: 'c1', force: true }, 'force'],
  ])('参数不合法时指出字段：%s', async (_label, params, field) => {
    const h = harness({ file: dispatchedFile() });
    const result = await call(h.handlers.session_stop, params);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^invalid arguments: /u);
    expect(result.error).toContain(field);
    expect(h.aborts).toEqual([]);
  });
});

describe('session_answer', () => {
  const relayFile = (overrides: Partial<SecretaryRelayAsk> = {}): SecretaryDispatchFile => ({
    ...dispatchedFile(),
    relays: {
      'c1|ask-1': {
        conversationId: 'c1',
        askId: 'ask-1',
        question: '用哪个方案？',
        options: ['A', 'B'],
        at: 900,
        status: 'pending',
        ...overrides,
      },
    },
  });

  it('秘书代答：答案送进原会话，记录收尾并审计', async () => {
    const h = harness({ file: relayFile() });
    const result = await call(h.handlers.session_answer, {
      conversationId: 'c1',
      askId: 'ask-1',
      answer: 'A',
    });
    expect(result).toEqual({
      ok: true,
      result: { status: 'answered', conversationId: 'c1', askId: 'ask-1' },
    });
    expect(h.answers).toEqual([
      { conversationId: 'c1', askId: 'ask-1', answer: 'A', name: h.profileValue?.name },
    ]);
    expect(h.file.relays?.['c1|ask-1']).toMatchObject({
      status: 'answered',
      answer: 'A',
      answeredAt: NOW,
    });
    expect(h.audits).toMatchObject([
      { op: 'session_answer', targetId: 'c1', ok: true, detail: 'ask-1' },
    ]);
  });

  it('用户已经直接答过：拒绝，不再送答案', async () => {
    const h = harness({ file: relayFile({ status: 'user-answered', answer: 'B' }) });
    const result = await call(h.handlers.session_answer, {
      conversationId: 'c1',
      askId: 'ask-1',
      answer: 'A',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('the user answered it directly');
    expect(h.answers).toEqual([]);
  });

  it('没有这个提问时拒绝', async () => {
    const h = harness({ file: relayFile() });
    const result = await call(h.handlers.session_answer, {
      conversationId: 'c1',
      askId: 'ask-9',
      answer: 'A',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('not-found');
    expect(h.answers).toEqual([]);
  });

  it('已经超时：按超时收尾并拒绝，不再送答案', async () => {
    const h = harness({ file: relayFile({ expiresAt: NOW - 1 }) });
    const result = await call(h.handlers.session_answer, {
      conversationId: 'c1',
      askId: 'ask-1',
      answer: 'A',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('timed-out');
    expect(h.file.relays?.['c1|ask-1'].status).toBe('timed-out');
    expect(h.file.outbox).toMatchObject([{ kind: 'ask-relay', status: 'timed-out' }]);
    expect(h.answers).toEqual([]);
  });

  it('不是秘书管着的会话：拒绝', async () => {
    const h = harness({
      file: relayFile(),
      conversations: [rootConversation('c1'), rootConversation('c2')],
    });
    const result = await call(h.handlers.session_answer, {
      conversationId: 'c2',
      askId: 'ask-1',
      answer: 'A',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('not-operable');
    expect(h.answers).toEqual([]);
  });

  it.each([
    ['缺 askId', { conversationId: 'c1', answer: 'A' }, 'askId'],
    ['缺 answer', { conversationId: 'c1', askId: 'ask-1' }, 'answer'],
  ])('参数不合法时指出字段：%s', async (_label, params, field) => {
    const h = harness({ file: relayFile() });
    const result = await call(h.handlers.session_answer, params);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(field);
    expect(h.answers).toEqual([]);
  });

  it('派出的会话一律把 ask_user 转给秘书', async () => {
    const h = harness({
      profile: profile(),
    });
    await call(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(h.created[0]).toMatchObject({ askRelay: { name: h.profileValue?.name } });
  });
});

describe('接管', () => {
  const takeoverHarness = (options: Parameters<typeof harness>[0] = {}) =>
    harness({
      projects: [localProject(), localProject('sec-proj', { kind: 'secretary' })],
      conversations: [rootConversation('c1'), rootConversation('sec-chat', 'sec-proj')],
      rows: {
        c1: { projectId: 'p1', title: '修构建', sessionFile: '/s/c1.jsonl' },
        'sec-chat': { projectId: 'sec-proj', lastActiveAt: 10 },
      },
      ...options,
    });

  const propose = (h: Harness, params: Record<string, unknown> = {}) =>
    call(h.handlers.session_takeover_propose, { conversationId: 'c1', ...params });

  it('秘书只能提出接管：出待确认卡，不授权', async () => {
    const h = takeoverHarness();
    const result = await propose(h, { reason: '帮你盯构建' });
    expect(result).toEqual({
      ok: true,
      result: { status: 'awaiting_confirmation', proposalId: 'id-1' },
    });
    expect(h.file.proposals['id-1']).toMatchObject({
      kind: 'takeover',
      status: 'pending',
      secretaryConversationId: 'sec-1',
      draft: { conversationId: 'c1', projectId: 'p1', title: '修构建', reason: '帮你盯构建' },
    });
    expect(h.file.dispatched).toEqual({});
    expect(h.audits).toMatchObject([
      { op: 'session_takeover_propose', targetId: 'id-1', ok: true },
    ]);
    // 同一会话再提一次复用同一张卡
    expect(await propose(h)).toEqual({
      ok: true,
      result: {
        status: 'awaiting_confirmation',
        proposalId: 'id-1',
        reused: true,
        note: expect.stringContaining('proposalId=id-1'),
      },
    });
    expect(Object.keys(h.file.proposals)).toEqual(['id-1']);
  });

  it('秘书会话、子会话、已归档、已有秘书管着的会话都不能接管', async () => {
    const cases: [Parameters<typeof harness>[0], string, string][] = [
      [{}, 'sec-chat', 'secretary-session'],
      [{ rows: { c1: { projectId: 'p1', parentId: 'root' } } }, 'c1', 'child-session'],
      [{ rows: { c1: { projectId: 'p1', archived: true } } }, 'c1', 'archived'],
      [{ file: dispatchedFile() }, 'c1', 'already-managed'],
      [{ profile: profile({ visibleProjectIds: ['other'] }) }, 'c1', 'not-visible'],
      [{}, 'missing', 'not-found'],
    ];
    for (const [options, conversationId, error] of cases) {
      const h = takeoverHarness(options);
      expect(await propose(h, { conversationId }), error).toEqual({ ok: false, error });
      expect(Object.keys(h.file.proposals), error).toEqual([]);
      expect(h.audits.at(-1), error).toMatchObject({ ok: false, detail: error });
      expect(await grantTakeover(h.ports, conversationId, 'user', null), error).toEqual({
        ok: false,
        error,
      });
    }
  });

  it('别的秘书在管的会话：接管、授权、发消息都拒绝，原因与本秘书已管区分开', async () => {
    const h = takeoverHarness({ profile: profile({ takeoverScope: { mode: 'all' } }) });
    h.ports.managedElsewhere = (conversationId) => (conversationId === 'c1' ? '阿财' : null);
    h.handlers = createSecretaryDispatchHandlers(h.ports);
    expect(await propose(h)).toEqual({ ok: false, error: 'managed-by-other' });
    expect(await grantTakeover(h.ports, 'c1', 'user', null)).toEqual({
      ok: false,
      error: 'managed-by-other',
    });
    // 接管范围覆盖这个项目也不行：一个会话只归一个秘书
    const sent = await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' });
    expect(sent.ok ? '' : sent.error).toMatch(/^permission denied \(managed-by-other\)/u);
    expect(h.file.dispatched.c1).toBeUndefined();
  });

  it('授权后把 ask_user 转给秘书，撤销后恢复成直接问用户', async () => {
    const h = takeoverHarness();
    await propose(h);
    expect(await resolveProposal(h.ports, 'id-1', 'confirm')).toMatchObject({ ok: true });
    expect(h.relays).toEqual([{ conversationId: 'c1', relay: { name: h.profileValue?.name } }]);
    expect(revokeTakeover(h.ports, 'c1', 'session')).toEqual({ ok: true });
    expect(h.relays.at(-1)).toEqual({ conversationId: 'c1', relay: null });
  });

  it('用户确认后授权：秘书能发消息、能停止，状态进工作台与接管清单', async () => {
    const h = takeoverHarness({
      statuses: { c1: { state: 'idle', pendingAsks: 0, pendingApprovals: 0 } },
    });
    await propose(h);
    const resolved = await resolveProposal(h.ports, 'id-1', 'confirm');
    expect(resolved).toMatchObject({ ok: true, proposal: { status: 'succeeded' } });
    expect(h.file.dispatched.c1).toEqual({
      conversationId: 'c1',
      projectId: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: NOW,
      turn: 0,
      lastState: 'idle',
      lastEventAt: NOW,
      takeover: { grantedAt: NOW, via: 'proposal' },
    });
    expect(h.file.outbox.at(-1)).toMatchObject({ kind: 'proposal', proposalId: 'id-1' });
    expect(h.file.outbox.at(-1)?.text).toContain('session:c1');
    expect(h.audits.map((entry) => [entry.op, entry.detail])).toEqual(
      expect.arrayContaining([
        ['proposal_confirm', 'accepted'],
        ['takeover_grant', 'proposal'],
        ['proposal_confirm', 'succeeded'],
      ])
    );

    expect(await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' })).toEqual({
      ok: true,
      result: { status: 'sent' },
    });
    expect(h.audits.at(-1)).toMatchObject({
      op: 'session_send',
      targetId: 'c1',
      detail: 'sent (granted)',
    });

    const state = await buildSecretaryState(h.ports, { enabled: true, projectId: 'sec-proj' });
    expect(state.board.running[0]).toMatchObject({ conversationId: 'c1', takeover: true });
    expect(state.board.done).toEqual([]);
    expect(state.takeovers).toEqual([
      {
        conversationId: 'c1',
        projectId: 'p1',
        projectName: 'alpha',
        title: '修构建',
        grantedAt: NOW,
        via: 'proposal',
        secretaryConversationId: 'sec-1',
      },
    ]);
    expect(await listTakeovers(h.ports)).toEqual(state.takeovers);

    // 自带目标的会话被秘书停下时目标一并暂停
    expect(await call(h.handlers.session_stop, { conversationId: 'c1' })).toEqual({
      ok: true,
      result: { status: 'stopped' },
    });
    expect(h.pausedGoals).toEqual(['c1']);
  });

  it('会话在等用户时拒绝秘书发消息', async () => {
    const h = takeoverHarness({
      statuses: { c1: { state: 'waiting', pendingAsks: 1, pendingApprovals: 0 } },
    });
    expect(await grantTakeover(h.ports, 'c1', 'user', null)).toEqual({ ok: true });
    const result = await call(h.handlers.session_send, { conversationId: 'c1', message: '选 A' });
    expect(result.ok ? '' : result.error).toMatch(/^refused \(needs-user\): /u);
    expect(h.prompts).toEqual([]);
  });

  it('界面直接授权绑最近的秘书会话；没有秘书会话时拒绝', async () => {
    const h = takeoverHarness();
    expect(await grantTakeover(h.ports, 'c1', 'user', null)).toEqual({ ok: true });
    expect(h.file.dispatched.c1).toMatchObject({
      secretaryConversationId: 'sec-chat',
      takeover: { via: 'user' },
    });
    expect(h.audits.at(-1)).toMatchObject({
      op: 'takeover_grant',
      secretaryConversationId: 'sec-chat',
      ok: true,
      detail: 'user',
    });
    // 已接管的再授权一次被拒，不覆盖原记录
    expect(await grantTakeover(h.ports, 'c1', 'user', null)).toEqual({
      ok: false,
      error: 'already-managed',
    });

    const lonely = harness({ rows: { c1: { projectId: 'p1' } } });
    expect(await grantTakeover(lonely.ports, 'c1', 'user', null)).toEqual({
      ok: false,
      error: 'no-secretary-conversation',
    });
    expect(lonely.file.dispatched).toEqual({});
  });

  it('接管的会话不占派出并发上限', async () => {
    const h = takeoverHarness({
      profile: profile({
        maxRunningDispatches: 1,
      }),
      statuses: { c1: { state: 'running', pendingAsks: 0, pendingApprovals: 0 } },
    });
    await grantTakeover(h.ports, 'c1', 'user', null);
    expect(h.file.dispatched.c1.lastState).toBe('running');
    const result = await call(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(result).toMatchObject({ ok: true, result: { status: 'created' } });
  });

  it('撤销后秘书再发消息被拒；点名授权一并收回，未投递的结果丢掉', async () => {
    const h = takeoverHarness();
    await grantTakeover(h.ports, 'c1', 'user', null);
    h.file.named.push('c1');
    h.file.outbox.push({
      key: 'c1|turn-ended|1',
      at: NOW,
      kind: 'turn-ended',
      conversationId: 'c1',
      text: 'x',
    });
    expect(revokeTakeover(h.ports, 'c1', 'session')).toEqual({ ok: true });
    expect(h.file.dispatched).toEqual({});
    expect(h.file.named).toEqual([]);
    expect(h.file.outbox).toEqual([]);
    expect(h.audits.at(-1)).toMatchObject({
      op: 'takeover_revoke',
      targetId: 'c1',
      secretaryConversationId: 'sec-chat',
      ok: true,
      detail: 'session',
    });
    expect(await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' })).toEqual({
      ok: false,
      error: NOT_OPERABLE_ERROR,
    });
    expect(await listTakeovers(h.ports)).toEqual([]);
  });

  it('派出的会话不能当接管撤销', () => {
    const h = harness({ file: dispatchedFile() });
    expect(revokeTakeover(h.ports, 'c1', 'settings')).toEqual({ ok: false, error: 'not-found' });
    expect(h.file.dispatched.c1).toBeDefined();
    expect(h.audits).toMatchObject([{ op: 'takeover_revoke', ok: false }]);
  });

  it('确认时会话已被归档则提案失败，不授权', async () => {
    const h = takeoverHarness();
    await propose(h);
    h.rows.c1 = { ...h.rows.c1, archived: true };
    const resolved = await resolveProposal(h.ports, 'id-1', 'confirm');
    expect(resolved).toMatchObject({ ok: true, proposal: { status: 'failed', error: 'archived' } });
    expect(h.file.dispatched).toEqual({});
  });
});

describe('接管范围', () => {
  const scopeHarness = (options: Parameters<typeof harness>[0] = {}) =>
    harness({
      conversations: [rootConversation('c1'), rootConversation('c2', 'p2')],
      rows: {
        c1: { projectId: 'p1', title: '修构建', sessionFile: '/s/c1.jsonl' },
        c2: { projectId: 'p2', title: '别的活', sessionFile: '/s/c2.jsonl' },
      },
      ...options,
    });

  const scoped = (projectIds: string[] = ['p1']) =>
    profile({ takeoverScope: { mode: 'projects', projectIds } });

  it('范围内的会话不用逐个授权就能发消息，从这一刻起才跟踪它', async () => {
    const h = scopeHarness({ profile: scoped() });
    // 发之前不建记录：范围只给权限，不把范围内会话的状态推给秘书
    const before = await buildSecretaryState(h.ports, { enabled: true, projectId: 'sec-proj' });
    expect(before.takeovers).toEqual([]);
    expect(before.board.running).toEqual([]);

    expect(await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' })).toEqual({
      ok: true,
      result: { status: 'sent' },
    });
    expect(h.prompts).toEqual([{ conversationId: 'c1', text: '继续', deliveryId: 'id-1' }]);
    expect(h.file.dispatched.c1).toMatchObject({
      projectId: 'p1',
      secretaryConversationId: 'sec-1',
      takeover: { grantedAt: NOW, via: 'scope' },
    });
    expect(h.audits.map((entry) => [entry.op, entry.detail])).toEqual([
      ['takeover_grant', 'scope'],
      ['session_send', 'sent (scope)'],
    ]);

    const after = await buildSecretaryState(h.ports, { enabled: true, projectId: 'sec-proj' });
    expect(after.takeovers).toEqual([
      expect.objectContaining({ conversationId: 'c1', via: 'scope', title: '修构建' }),
    ]);
    expect(after.board.running[0]).toMatchObject({ conversationId: 'c1', takeover: true });
    // 范围里的其他会话仍然不跟踪，也不进接管清单
    expect(after.takeovers.some((entry) => entry.conversationId === 'c2')).toBe(false);
  });

  it('范围外的会话仍然被拒，提示改设置或申请接管', async () => {
    const h = scopeHarness({ profile: scoped(['p2']) });
    const result = await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' });
    expect(result).toEqual({ ok: false, error: NOT_OPERABLE_ERROR });
    expect(NOT_OPERABLE_ERROR).toContain('takeover scope in settings');
    expect(NOT_OPERABLE_ERROR).toContain('session_takeover_propose');
    expect(h.prompts).toEqual([]);
    expect(h.file.dispatched).toEqual({});
  });

  it('选「所有可见项目」时，不可见项目照样拒绝', async () => {
    const h = scopeHarness({
      profile: profile({ takeoverScope: { mode: 'all' }, visibleProjectIds: ['p2'] }),
    });
    const result = await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' });
    expect(result.ok ? '' : result.error).toMatch(/^permission denied \(not-visible\): /u);
    expect(h.prompts).toEqual([]);
    expect(h.file.dispatched).toEqual({});
  });

  it('子会话、归档会话、别的秘书的会话照样拒绝', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ projectId: 'p1', parentId: 'root' }, '子会话'],
      [{ projectId: 'p1', btwParentId: 'root' }, 'btw 子会话'],
      [{ projectId: 'p1', archived: true }, '归档会话'],
      [{ projectId: 'p1', secretaryOrigin: { secretaryConversationId: 'other' } }, '别的秘书'],
    ];
    for (const [row, label] of cases) {
      const h = scopeHarness({
        profile: profile({ takeoverScope: { mode: 'all' } }),
        rows: { c1: row },
      });
      expect(
        await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' }),
        label
      ).toEqual({ ok: false, error: NOT_OPERABLE_ERROR });
      expect(await call(h.handlers.session_stop, { conversationId: 'c1' }), label).toEqual({
        ok: false,
        error: NOT_OPERABLE_ERROR,
      });
      expect(h.prompts, label).toEqual([]);
      expect(h.aborts, label).toEqual([]);
      expect(h.file.dispatched, label).toEqual({});
    }
  });

  it('会话在等用户时范围接管照样拒绝发消息', async () => {
    const h = scopeHarness({
      profile: profile({ takeoverScope: { mode: 'all' } }),
      statuses: { c1: { state: 'waiting', pendingAsks: 1, pendingApprovals: 0 } },
    });
    const result = await call(h.handlers.session_send, { conversationId: 'c1', message: '选 A' });
    expect(result.ok ? '' : result.error).toMatch(/^refused \(needs-user\): /u);
    expect(h.prompts).toEqual([]);
    expect(h.file.dispatched).toEqual({});
  });

  it('停止范围内的会话同样建立跟踪，审计写明来源', async () => {
    const h = scopeHarness({ profile: profile({ takeoverScope: { mode: 'all' } }) });
    expect(await call(h.handlers.session_stop, { conversationId: 'c1' })).toEqual({
      ok: true,
      result: { status: 'stopped' },
    });
    expect(h.aborts).toEqual(['c1']);
    expect(h.file.dispatched.c1.takeover).toEqual({ grantedAt: NOW, via: 'scope' });
    expect(h.audits.map((entry) => [entry.op, entry.detail])).toEqual([
      ['takeover_grant', 'scope'],
      ['session_stop', 'stopped (scope)'],
    ]);
  });

  it('默认档案等价于旧行为：范围为空时普通会话仍被拒', async () => {
    const h = scopeHarness();
    expect(h.profileValue?.takeoverScope).toEqual({ mode: 'projects', projectIds: [] });
    expect(await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' })).toEqual({
      ok: false,
      error: NOT_OPERABLE_ERROR,
    });
    expect(h.file.dispatched).toEqual({});
  });

  it('审计分别写明 dispatched 与 granted', async () => {
    const dispatched = harness({ file: dispatchedFile() });
    await call(dispatched.handlers.session_send, { conversationId: 'c1', message: '继续' });
    expect(dispatched.audits.at(-1)).toMatchObject({ detail: 'sent (dispatched)' });

    const granted = harness({
      projects: [localProject(), localProject('sec-proj', { kind: 'secretary' })],
      conversations: [rootConversation('c1'), rootConversation('sec-chat', 'sec-proj')],
      rows: {
        c1: { projectId: 'p1', title: '修构建' },
        'sec-chat': { projectId: 'sec-proj', lastActiveAt: 10 },
      },
    });
    expect(await grantTakeover(granted.ports, 'c1', 'user', null)).toEqual({ ok: true });
    await call(granted.handlers.session_send, { conversationId: 'c1', message: '继续' });
    expect(granted.audits.at(-1)).toMatchObject({ detail: 'sent (granted)' });
  });
});

describe('不再跟踪', () => {
  const untrackedHarness = (options: Parameters<typeof harness>[0] = {}) =>
    harness({
      profile: profile({ takeoverScope: { mode: 'projects', projectIds: ['p1'] } }),
      conversations: [rootConversation('c1'), rootConversation('sec-chat', 'sec-proj')],
      projects: [localProject(), localProject('sec-proj', { kind: 'secretary' })],
      rows: {
        c1: { projectId: 'p1', title: '修构建', sessionFile: '/s/c1.jsonl' },
        'sec-chat': { projectId: 'sec-proj', lastActiveAt: 10 },
      },
      ...options,
    });

  it('用户点 × 之后范围权限失效，发消息与停止都被拒并说明原因', async () => {
    const h = untrackedHarness();
    // 范围接管的会话被真正用过一次，才有记录可撤销
    expect(await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' })).toEqual({
      ok: true,
      result: { status: 'sent' },
    });
    expect(revokeTakeover(h.ports, 'c1', 'session')).toEqual({ ok: true });
    expect(h.file.dispatched).toEqual({});
    expect(h.file.untracked).toEqual(['c1']);

    const send = await call(h.handlers.session_send, { conversationId: 'c1', message: '再来' });
    expect(send.ok ? '' : send.error).toMatch(/^permission denied \(untracked\): /u);
    expect(send.ok ? '' : send.error).toContain('untracked list in the secretary settings');
    expect(await call(h.handlers.session_stop, { conversationId: 'c1' })).toMatchObject({
      ok: false,
    });
    // 被拒之后不再自动建记录，秘书也不能靠范围把它管回来
    expect(h.file.dispatched).toEqual({});
    expect(h.prompts).toHaveLength(1);
    expect(h.aborts).toEqual([]);
  });

  it('确认卡逐个授权照常可用，确认后从名单里移除', async () => {
    const h = untrackedHarness({ file: { ...emptyFile(), untracked: ['c1'] } });
    const proposed = await call(h.handlers.session_takeover_propose, { conversationId: 'c1' });
    expect(proposed).toMatchObject({ ok: true, result: { status: 'awaiting_confirmation' } });
    const resolved = await resolveProposal(h.ports, 'id-1', 'confirm');
    expect(resolved).toMatchObject({ ok: true, proposal: { status: 'succeeded' } });
    expect(h.file.untracked).toEqual([]);
    expect(await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' })).toEqual({
      ok: true,
      result: { status: 'sent' },
    });
  });

  it('设置页移除后恢复范围权限，移除不存在的会话报 not-found', async () => {
    const h = untrackedHarness({ file: { ...emptyFile(), untracked: ['c1'] } });
    expect(await listUntracked(h.ports)).toEqual([
      { conversationId: 'c1', projectId: 'p1', projectName: 'alpha', title: '修构建' },
    ]);
    expect(untrack(h.ports, 'c1')).toEqual({ ok: true });
    expect(h.file.untracked).toEqual([]);
    expect(await listUntracked(h.ports)).toEqual([]);
    expect(untrack(h.ports, 'c1')).toEqual({ ok: false, error: 'not-found' });
    expect(await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' })).toEqual({
      ok: true,
      result: { status: 'sent' },
    });
  });

  it('名单只挡范围权限，派出的会话照旧可以发消息', async () => {
    const h = untrackedHarness({ file: { ...dispatchedFile(), untracked: ['c1'] } });
    expect(await call(h.handlers.session_send, { conversationId: 'c1', message: '继续' })).toEqual({
      ok: true,
      result: { status: 'sent' },
    });
  });
});

describe('待办', () => {
  it('新增待办并审计', async () => {
    const h = harness();
    const result = await call(h.handlers.todo_item_add, {
      text: '看构建',
      dueAt: 5_000,
      projectId: 'p1',
    });
    expect(result).toEqual({
      ok: true,
      result: { todoId: 'id-1', text: '看构建', dueAt: 5_000, projectId: 'p1' },
    });
    expect(h.todos).toEqual([
      { id: 'id-1', text: '看构建', dueAt: 5_000, projectId: 'p1', createdAt: NOW, updatedAt: NOW },
    ]);
    expect(h.audits.map((entry) => entry.op)).toEqual(['todo_item_add']);
  });

  it('更新待办文本与完成状态', async () => {
    const h = harness({
      todos: [{ id: 't1', text: '看构建', createdAt: 1, updatedAt: 1 }],
    });
    const result = await call(h.handlers.todo_item_update, {
      todoId: 't1',
      text: '看发布',
      done: true,
    });
    expect(result).toEqual({
      ok: true,
      result: {
        todoId: 't1',
        before: { text: '看构建', done: false },
        after: { text: '看发布', done: true },
      },
    });
    expect(h.todos).toEqual([
      { id: 't1', text: '看发布', createdAt: 1, updatedAt: NOW, doneAt: NOW },
    ]);
  });

  it('待办不存在时报错', async () => {
    const h = harness();
    expect(await call(h.handlers.todo_item_update, { todoId: 'missing', text: 'x' })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('派出待办直接建会话：不传 worktree 时默认开，带上待办 id', async () => {
    const h = harness({
      todos: [{ id: 't1', text: '看构建', projectId: 'p1', createdAt: 1, updatedAt: 1 }],
    });
    const result = await call(h.handlers.todo_item_dispatch, { todoId: 't1' });
    expect(result).toEqual({ ok: true, result: { status: 'created', conversationId: 'new-1' } });
    expect(Object.keys(h.file.proposals)).toEqual([]);
    expect(h.created[0]).toMatchObject({
      projectId: 'p1',
      title: '看构建',
      worktree: true,
      prompt: '看构建',
      goal: '看构建',
    });
    expect(h.created[0].prompt).not.toMatch(/不推送|不合并|项目：|不要改主检出/);
    expect(h.file.dispatched['new-1']).toMatchObject({ todoId: 't1', goal: '看构建' });
    expect(h.todos[0].conversationId).toBe('new-1');
  });

  it('派出待办传入 prompt 时以 prompt 为准，末尾附带待办原文背景且不注入推送合并禁令', async () => {
    const h = harness({
      todos: [
        {
          id: 't1',
          text: '上游错误恢复：429 自动退避与健康门控',
          projectId: 'p1',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    const prompt = '修复上游错误恢复并补测试，开 PR，CI 绿后 squash 合并。';
    await call(h.handlers.todo_item_dispatch, {
      todoId: 't1',
      prompt,
      goal: '修好上游错误恢复并 squash 合进 main',
    });
    expect(h.created[0]).toMatchObject({
      prompt: `${prompt}\n\n待办原文（背景）：\n上游错误恢复：429 自动退避与健康门控`,
      goal: '修好上游错误恢复并 squash 合进 main',
    });
    expect(h.created[0].prompt.startsWith(prompt)).toBe(true);
    expect(h.created[0].prompt).not.toMatch(/不推送|不合并|独立目录和空闲端口|不要改主检出/);
    expect(h.file.dispatched['new-1']).toMatchObject({
      todoId: 't1',
      goal: '修好上游错误恢复并 squash 合进 main',
    });
  });

  it('派出待办的会话标题用待办文本而不是 prompt 开头，可用 title 覆盖', async () => {
    const h = harness({
      profile: profile(),
      todos: [
        {
          id: 't1',
          text: '\n  修复通知误报\n顺带补单测',
          projectId: 'p1',
          createdAt: 1,
          updatedAt: 1,
        },
        { id: 't2', text: '修标题', projectId: 'p1', createdAt: 1, updatedAt: 1 },
      ],
    });
    await call(h.handlers.todo_item_dispatch, { todoId: 't1', prompt: '背景：秘书功能在开发' });
    await call(h.handlers.todo_item_dispatch, {
      todoId: 't2',
      prompt: '背景：秘书功能在开发',
      title: '待办标题',
    });
    expect(h.created.map((request) => request.title)).toEqual(['修复通知误报', '待办标题']);
  });

  it('免确认时直接派出并把待办关联到会话', async () => {
    const h = harness({
      profile: profile(),
      todos: [{ id: 't1', text: '看构建', projectId: 'p1', createdAt: 1, updatedAt: 1 }],
    });
    const result = await call(h.handlers.todo_item_dispatch, { todoId: 't1' });
    expect(result).toEqual({ ok: true, result: { status: 'created', conversationId: 'new-1' } });
    expect(h.todos[0].conversationId).toBe('new-1');
  });

  it('待办没有项目时要求指定项目', async () => {
    const h = harness({ todos: [{ id: 't1', text: '看构建', createdAt: 1, updatedAt: 1 }] });
    expect(await call(h.handlers.todo_item_dispatch, { todoId: 't1' })).toEqual({
      ok: false,
      error: 'project-required',
    });
  });

  it('免确认派出落关联时重读，不盖掉同时改的文字和完成', async () => {
    const h = harness({
      profile: profile(),
      todos: [{ id: 't1', text: '看构建', projectId: 'p1', createdAt: 1, updatedAt: 1 }],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.ports.createSession = async (request) => {
      h.created.push(request);
      await gate;
      return h.createResult;
    };
    const pending = call(h.handlers.todo_item_dispatch, { todoId: 't1' });
    for (let i = 0; i < 30 && h.created.length === 0; i += 1) await Promise.resolve();
    expect(h.created).toHaveLength(1);
    await call(h.handlers.todo_item_update, { todoId: 't1', text: '看发布', done: true });
    release();
    expect(await pending).toEqual({
      ok: true,
      result: { status: 'created', conversationId: 'new-1' },
    });
    expect(h.todos[0]).toMatchObject({
      text: '看发布',
      doneAt: NOW,
      conversationId: 'new-1',
    });
  });

  it('旧的待确认卡确认后关联待办，不覆盖确认前的修改', async () => {
    const h = harness({
      todos: [{ id: 't1', text: '看构建', projectId: 'p1', createdAt: 1, updatedAt: 1 }],
    });
    const payload = legacyDispatchCard(h, {
      projectId: 'p1',
      prompt: '看构建',
      todoId: 't1',
      worktree: true,
    });
    expect(h.todos[0].conversationId).toBeUndefined();
    await call(h.handlers.todo_item_update, { todoId: 't1', text: '看发布', done: true });
    await resolveProposal(h.ports, payload.proposalId, 'confirm');
    expect(h.todos[0]).toMatchObject({
      text: '看发布',
      doneAt: NOW,
      conversationId: 'new-1',
    });
  });

  it('todo_list 看到状态并可筛选，正文是不可信内容', async () => {
    const h = harness({
      projects: [localProject('p1'), localProject('p2')],
      rows: { c1: { title: '在跑的会话', projectId: 'p1', sessionFile: '/tmp/c1' } },
      statuses: { c1: { state: 'running', pendingAsks: 0, pendingApprovals: 0 } },
      todos: [
        { id: 't1', text: '看构建', projectId: 'p1', createdAt: 1, updatedAt: 1 },
        { id: 't2', text: '已完成', projectId: 'p1', createdAt: 1, updatedAt: 1, doneAt: 2 },
        {
          id: 't3',
          text: '在跑',
          projectId: 'p1',
          createdAt: 1,
          updatedAt: 1,
          conversationId: 'c1',
        },
        { id: 't4', text: '另一个项目', projectId: 'p2', createdAt: 1, updatedAt: 1 },
      ],
    });
    const listed = (await run(h.handlers.todo_list, {})) as {
      todos: {
        id: string;
        status: string;
        text: string;
        sessionState?: string;
        sessionTitle?: string;
      }[];
    };
    expect(listed.todos.map((item) => [item.id, item.status])).toEqual([
      ['t1', 'todo'],
      ['t2', 'done'],
      ['t3', 'active'],
      ['t4', 'todo'],
    ]);
    expect(listed.todos[0].text).toContain('<untrusted-content source="todo:t1">');
    expect(listed.todos[2].sessionState).toBe('running');
    expect(listed.todos[2].sessionTitle).toContain('在跑的会话');
    expect(
      (
        (await run(h.handlers.todo_list, { status: 'done', projectId: 'p1' })) as {
          todos: { id: string }[];
        }
      ).todos.map((item) => item.id)
    ).toEqual(['t2']);
    expect(await call(h.handlers.todo_list, { projectId: 'missing' })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(await call(h.handlers.todo_list, { status: 'later' })).toEqual({
      ok: false,
      error: 'invalid arguments',
    });
  });

  it('todo_list 有别名时项目名用别名', async () => {
    const h = harness({
      todos: [{ id: 't1', text: '看构建', projectId: 'p1', createdAt: 1, updatedAt: 1 }],
    });
    h.ports.projectAliases = () => ({ p1: '官网前端' });
    const listed = (await run(h.handlers.todo_list, {})) as {
      todos: { projectName?: string }[];
    };
    expect(listed.todos[0].projectName).toBe('官网前端');
  });
});

describe('清理提案', () => {
  it('确认后才执行，结果摘要写回提案', async () => {
    const h = harness({ rows: { 'c-done': { title: '写发布说明' } } });
    const proposalId = 'cleanup-1';
    h.file.proposals[proposalId] = {
      id: proposalId,
      secretaryConversationId: 'sec-1',
      createdAt: NOW,
      updatedAt: NOW,
      status: 'pending',
      kind: 'cleanup',
      draft: {
        items: [{ id: 'session|c-done', kind: 'session', name: '写发布说明' }],
      },
    };
    // 还没确认：什么都没归档
    expect(h.archived).toEqual([]);

    const resolved = await resolveProposal(h.ports, proposalId, 'confirm');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.proposal.status).toBe('succeeded');
    expect(resolved.proposal.kind === 'cleanup' && resolved.proposal.report).toContain(
      'archived 1'
    );
    expect(h.archived).toEqual([{ conversationId: 'c-done', at: NOW }]);
    expect(h.audits.some((entry) => entry.op === 'cleanup_session')).toBe(true);
  });

  it('拒绝时一条都不动', async () => {
    const h = harness({ rows: { 'c-done': { title: '写发布说明' } } });
    h.file.proposals['cleanup-2'] = {
      id: 'cleanup-2',
      secretaryConversationId: 'sec-1',
      createdAt: NOW,
      updatedAt: NOW,
      status: 'pending',
      kind: 'cleanup',
      draft: { items: [{ id: 'session|c-done', kind: 'session', name: '写发布说明' }] },
    };
    const rejected = await resolveProposal(h.ports, 'cleanup-2', 'reject');
    expect(rejected.ok && rejected.proposal.status).toBe('rejected');
    expect(h.archived).toEqual([]);
  });
});

describe('确认卡去重', () => {
  const cleanupItems = (name: string): CleanupItem[] => [
    { id: `branch|${name}`, kind: 'branch', name },
  ];

  it('清理：同类同参再调用返回已有提案，不新建', () => {
    const h = harness();
    const first = saveCleanupProposal(cleanupItems('feat/a'), 'sec-1', h.ports);
    const second = saveCleanupProposal(cleanupItems('feat/a'), 'sec-1', h.ports);

    expect(first.reused).toBe(false);
    expect(second.proposalId).toBe(first.proposalId);
    expect(second.reused).toBe(true);
    expect(second.note).toContain(`proposalId=${first.proposalId}`);
    expect(Object.keys(h.file.proposals)).toEqual([first.proposalId]);
  });

  it('清理：参数不同另开一张，并提示上一张还没处理', () => {
    const h = harness();
    const first = saveCleanupProposal(cleanupItems('feat/a'), 'sec-1', h.ports);
    const second = saveCleanupProposal(cleanupItems('feat/b'), 'sec-1', h.ports);

    expect(second.proposalId).not.toBe(first.proposalId);
    expect(second.reused).toBe(false);
    expect(second.otherPendingId).toBe(first.proposalId);
    expect(second.note).toContain(`proposalId=${first.proposalId}`);
    expect(Object.keys(h.file.proposals).sort()).toEqual(
      [first.proposalId, second.proposalId].sort()
    );
  });
});

describe('确认卡的两段式回传', () => {
  it('点确认后立刻推「已确认，正在执行」，执行完再推完成', async () => {
    const h = harness({ rows: { 'c-done': { title: '写发布说明' } } });
    h.file.proposals['cleanup-1'] = {
      id: 'cleanup-1',
      secretaryConversationId: 'sec-1',
      createdAt: NOW,
      updatedAt: NOW,
      status: 'pending',
      kind: 'cleanup',
      draft: { items: [{ id: 'session|c-done', kind: 'session', name: '写发布说明' }] },
    };

    const pending = resolveProposal(h.ports, 'cleanup-1', 'confirm');
    // 执行体还没跑完：秘书这边已经能看到「已确认」
    expect(h.file.outbox.map((update) => update.text)).toEqual(['已确认，正在执行清理']);

    const resolved = await pending;
    expect(resolved.ok && resolved.proposal.status).toBe('succeeded');
    expect(h.file.outbox.map((update) => update.text)).toEqual([
      '已确认，正在执行清理',
      expect.stringContaining('清理完成'),
    ]);
    expect(h.file.outbox.map((update) => update.key)).toEqual([
      'proposal:cleanup-1:executing',
      'proposal:cleanup-1:succeeded',
    ]);
  });

  it('取消时立刻推「已取消」', async () => {
    const h = harness({ rows: { 'c-done': { title: '写发布说明' } } });
    h.file.proposals['cleanup-2'] = {
      id: 'cleanup-2',
      secretaryConversationId: 'sec-1',
      createdAt: NOW,
      updatedAt: NOW,
      status: 'pending',
      kind: 'cleanup',
      draft: { items: [{ id: 'session|c-done', kind: 'session', name: '写发布说明' }] },
    };

    await resolveProposal(h.ports, 'cleanup-2', 'reject');

    expect(h.file.outbox.map((update) => update.text)).toEqual(['用户取消了这次清理，什么都没删']);
    expect(h.archived).toEqual([]);
  });
});

describe('resolveProposal', () => {
  it('同一提案确认两次只执行一次', async () => {
    const h = harness();
    const { proposalId } = legacyDispatchCard(h, { projectId: 'p1', prompt: '修构建' });

    const first = await resolveProposal(h.ports, proposalId, 'confirm');
    const second = await resolveProposal(h.ports, proposalId, 'confirm');

    expect(first.ok).toBe(true);
    expect(first.ok && first.proposal.status).toBe('succeeded');
    expect(second).toEqual({ ok: false, error: 'not-pending' });
    expect(h.created).toHaveLength(1);
  });

  it('档案里的上限改了之后，确认提案立即按新上限检查', async () => {
    const file = emptyFile();
    file.dispatched.a = {
      conversationId: 'a',
      projectId: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: 1,
      turn: 0,
      lastState: 'running',
      lastEventAt: 1,
    };
    const h = harness({
      file,
      rows: { a: { title: 'a', sessionFile: '/a' } },
      statuses: { a: running },
    });
    const propose = () => legacyDispatchCard(h, { projectId: 'p1', prompt: '修构建' }).proposalId;

    const blocked = propose();
    h.profileValue = profile({ maxRunningDispatches: 1 });
    const queued = await resolveProposal(h.ports, blocked, 'confirm');
    expect(queued.ok && queued.proposal.status).toBe('succeeded');
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ queued: true });

    h.profileValue = profile({ maxRunningDispatches: 2 });
    const allowed = propose();
    const confirmed = await resolveProposal(h.ports, allowed, 'confirm');
    expect(confirmed.ok && confirmed.proposal.status).toBe('succeeded');
    expect(h.created).toHaveLength(2);
    expect(h.created[1]).not.toHaveProperty('queued');
  });

  it('两端同时确认也只执行一次', async () => {
    const h = harness();
    const { proposalId } = legacyDispatchCard(h, { projectId: 'p1', prompt: '修构建' });

    const results = await Promise.all([
      resolveProposal(h.ports, proposalId, 'confirm'),
      resolveProposal(h.ports, proposalId, 'confirm'),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, error: 'not-pending' }]);
    expect(h.created).toHaveLength(1);
  });

  it('并发确认只留一条执行记录，与落盘的接受记录分开', async () => {
    const h = harness();
    const { proposalId } = legacyDispatchCard(h, { projectId: 'p1', prompt: '修构建' });

    await Promise.all([
      resolveProposal(h.ports, proposalId, 'confirm'),
      resolveProposal(h.ports, proposalId, 'confirm'),
    ]);

    const confirms = h.audits.filter((entry) => entry.op === 'proposal_confirm');
    expect(confirms.map((entry) => [entry.detail, entry.ok])).toEqual([
      ['accepted', true],
      ['succeeded', true],
    ]);
  });

  it('重新校验失败时记失败并给原因', async () => {
    const h = harness();
    const { proposalId } = legacyDispatchCard(h, { projectId: 'p1', prompt: '修构建' });
    h.projects = [];

    const result = await resolveProposal(h.ports, proposalId, 'confirm');

    expect(result.ok && result.proposal.status).toBe('failed');
    expect(result.ok && result.proposal.error).toBe('project-missing');
    expect(h.created).toEqual([]);
    // 点确认先推一条「已确认，正在执行」，执行失败再推一条
    expect(h.file.outbox.map((update) => update.kind)).toEqual(['proposal', 'proposal']);
    expect(h.file.outbox[0]).toMatchObject({ proposalId, status: 'executing' });
    expect(h.file.outbox.at(-1)).toMatchObject({ proposalId, status: 'failed' });
  });

  it('拒绝提案不执行', async () => {
    const h = harness();
    const { proposalId } = legacyDispatchCard(h, { projectId: 'p1', prompt: '修构建' });

    const result = await resolveProposal(h.ports, proposalId, 'reject');

    expect(result.ok && result.proposal.status).toBe('rejected');
    expect(h.created).toEqual([]);
    expect(h.file.outbox[0]).toMatchObject({ proposalId, status: 'rejected' });
  });

  it('确认时用编辑后的草案', async () => {
    const h = harness();
    const { proposalId } = legacyDispatchCard(h, { projectId: 'p1', prompt: '修构建' });

    await resolveProposal(h.ports, proposalId, 'confirm', { prompt: '修发布', title: '发布' });

    expect(h.created[0]).toMatchObject({ prompt: '修发布', title: '发布' });
  });

  it('未知提案返回 not-found', async () => {
    const h = harness();
    expect(await resolveProposal(h.ports, 'missing', 'confirm')).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('确认 profile 提案时走同一套保存逻辑', async () => {
    const h = harness();
    const draft: SecretaryProfileDraft = { name: '小秘', patrolEnabled: false };
    h.file.proposals.p1 = {
      id: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: NOW,
      updatedAt: NOW,
      status: 'pending',
      kind: 'profile',
      draft,
    };

    const result = await resolveProposal(h.ports, 'p1', 'confirm');

    expect(result.ok && result.proposal.status).toBe('succeeded');
    expect(h.appliedProfiles).toEqual([draft]);
    expect(h.file.outbox.at(-1)).toMatchObject({ proposalId: 'p1', status: 'succeeded' });
    expect(h.created).toEqual([]);
  });

  it('卡片上就地改过的档案草案整份替换', async () => {
    const h = harness();
    h.file.proposals.p1 = {
      id: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: NOW,
      updatedAt: NOW,
      status: 'pending',
      kind: 'profile',
      draft: { name: '小秘' },
    };

    await resolveProposal(h.ports, 'p1', 'confirm', undefined, {
      name: '小秘',
      maxRunningDispatches: 5,
    });

    expect(h.appliedProfiles).toEqual([{ name: '小秘', maxRunningDispatches: 5 }]);
  });

  it('拒绝 profile 提案不写档案', async () => {
    const h = harness();
    h.file.proposals.p1 = {
      id: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: NOW,
      updatedAt: NOW,
      status: 'pending',
      kind: 'profile',
      draft: { name: '小秘' },
    };

    const result = await resolveProposal(h.ports, 'p1', 'reject');

    expect(result.ok && result.proposal.status).toBe('rejected');
    expect(h.appliedProfiles).toEqual([]);
  });

  it('保存失败时提案记失败并带原因', async () => {
    const h = harness();
    h.ports.applyProfile = async () => ({ ok: false, error: 'invalid notify' });
    h.file.proposals.p1 = {
      id: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: NOW,
      updatedAt: NOW,
      status: 'pending',
      kind: 'profile',
      draft: { name: '小秘' },
    };

    const result = await resolveProposal(h.ports, 'p1', 'confirm');

    expect(result.ok && result.proposal.status).toBe('failed');
    expect(result.ok && result.proposal.error).toBe('invalid notify');
  });

  it('确认 skill 提案时交给 skill 服务写盘', async () => {
    const h = harness();
    const draft = { name: 'deploy-check', description: '发布前跑一遍', body: '# 步骤' };
    h.file.proposals.p1 = {
      id: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: NOW,
      updatedAt: NOW,
      status: 'pending',
      kind: 'skill',
      draft,
    };

    const result = await resolveProposal(h.ports, 'p1', 'confirm');

    expect(result.ok && result.proposal.status).toBe('succeeded');
    expect(h.appliedSkills).toEqual([draft]);
    expect(h.file.outbox.at(-1)).toMatchObject({ proposalId: 'p1', status: 'succeeded' });
    expect(h.created).toEqual([]);
  });

  it('拒绝 skill 提案不写盘', async () => {
    const h = harness();
    h.file.proposals.p1 = {
      id: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: NOW,
      updatedAt: NOW,
      status: 'pending',
      kind: 'skill',
      draft: { name: 'deploy-check', description: 'd', body: 'b' },
    };

    const result = await resolveProposal(h.ports, 'p1', 'reject');

    expect(result.ok && result.proposal.status).toBe('rejected');
    expect(h.appliedSkills).toEqual([]);
  });

  it('skill 写盘失败时提案记失败并带原因', async () => {
    const h = harness();
    h.ports.applySkill = async () => ({ ok: false, error: 'invalid skill name' });
    h.file.proposals.p1 = {
      id: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: NOW,
      updatedAt: NOW,
      status: 'pending',
      kind: 'skill',
      draft: { name: 'deploy-check', description: 'd', body: 'b' },
    };

    const result = await resolveProposal(h.ports, 'p1', 'confirm');

    expect(result.ok && result.proposal.status).toBe('failed');
    expect(result.ok && result.proposal.error).toBe('invalid skill name');
  });

  it('确认工具提案才写盘，拒绝不写', async () => {
    const h = harness();
    const draft: SecretaryToolDraft = {
      name: 'upper-text',
      description: '把文本转成大写',
      runtime: 'node',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      readOnly: true,
      code: 'process.stdout.write("x")',
    };
    h.file.proposals.p1 = {
      id: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: NOW,
      updatedAt: NOW,
      status: 'pending',
      kind: 'tool',
      draft,
    };
    h.file.proposals.p2 = { ...h.file.proposals.p1, id: 'p2' };

    expect((await resolveProposal(h.ports, 'p2', 'reject')).ok).toBe(true);
    expect(h.appliedTools).toEqual([]);

    const result = await resolveProposal(h.ports, 'p1', 'confirm');
    expect(result.ok && result.proposal.status).toBe('succeeded');
    expect(h.appliedTools).toEqual([draft]);
    expect(h.created).toEqual([]);
  });
});

describe('mutateTodo', () => {
  it('界面删除待办', async () => {
    const h = harness({ todos: [{ id: 't1', text: '看构建', createdAt: 1, updatedAt: 1 }] });
    expect(await mutateTodo(h.ports, { action: 'remove', todoId: 't1' })).toEqual({
      ok: true,
      todoId: 't1',
    });
    expect(h.todos).toEqual([]);
  });

  it('界面派出待办时用最近的秘书会话作为发起方', async () => {
    const h = harness({
      profile: profile(),
      projects: [localProject(), localProject('sec-proj', { kind: 'secretary' })],
      conversations: [rootConversation('sec-chat', 'sec-proj')],
      rows: { 'sec-chat': { projectId: 'sec-proj', lastActiveAt: 10 } },
      todos: [{ id: 't1', text: '看构建', projectId: 'p1', createdAt: 1, updatedAt: 1 }],
    });
    const result = await mutateTodo(h.ports, { action: 'dispatch', todoId: 't1' });
    expect(result).toEqual({ ok: true, todoId: 't1' });
    expect(h.created[0].secretaryOrigin).toEqual({ secretaryConversationId: 'sec-chat' });
    expect(h.created[0].worktree).toBe(true);
    expect(h.created[0].prompt).toBe('看构建');
    expect(h.created[0].goal).toBe('看构建');
    expect(h.created[0].prompt).not.toMatch(/不推送|不合并/);
    expect(h.todos[0].conversationId).toBe('new-1');
  });

  it('秘书传入的完整说明原样派出，显式不要 worktree 时也不建', async () => {
    const brief = '只读排查通知逻辑，不改代码。\n修通知';
    const h = harness({
      todos: [{ id: 't1', text: '修通知', projectId: 'p1', createdAt: 1, updatedAt: 1 }],
    });
    await call(h.handlers.todo_item_dispatch, { todoId: 't1', prompt: brief, worktree: false });
    expect(h.created[0].prompt).toBe(brief);
    expect(h.created[0].worktree).toBe(false);
  });
});

describe('dismissResult', () => {
  const failedFile = (over: Partial<DispatchRecord> = {}): SecretaryDispatchFile => ({
    ...emptyFile(),
    dispatched: {
      c1: {
        conversationId: 'c1',
        projectId: 'p1',
        secretaryConversationId: 'sec-1',
        createdAt: 900,
        turn: 2,
        lastState: 'error',
        lastEventAt: 900,
        lastResult: { kind: 'failed', turn: 1, at: 950 },
        ...over,
      },
    },
  });

  it('把需要你处理的结果标成已清掉并写审计', () => {
    const h = harness({ file: failedFile() });
    expect(dismissResult(h.ports, 'c1')).toEqual({ ok: true });
    expect(h.file.dispatched.c1.lastResult).toEqual({
      kind: 'failed',
      turn: 1,
      at: 950,
      dismissed: true,
    });
    expect(h.audits).toEqual([
      {
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'result_dismiss',
        targetId: 'c1',
        ok: true,
      },
    ]);
  });

  it('没有派出记录、没有结果、结果不需要处理时都拒绝', () => {
    expect(dismissResult(harness({}).ports, 'c1')).toEqual({ ok: false, error: 'not-found' });

    const noResult = harness({ file: failedFile({ lastResult: undefined }) });
    expect(dismissResult(noResult.ports, 'c1')).toEqual({ ok: false, error: 'not-dismissible' });

    const completed = harness({
      file: failedFile({ lastResult: { kind: 'goal-complete', turn: 1, at: 950 } }),
    });
    expect(dismissResult(completed.ports, 'c1')).toEqual({
      ok: false,
      error: 'not-dismissible',
    });
    expect(completed.file.dispatched.c1.lastResult).toEqual({
      kind: 'goal-complete',
      turn: 1,
      at: 950,
    });
    expect(completed.audits).toEqual([]);
  });
});

describe('dismissPending', () => {
  const pendingOf = (id: string, over: Partial<PendingDispatch> = {}): PendingDispatch => ({
    id,
    projectId: 'p1',
    secretaryConversationId: 'sec-1',
    createdAt: 100,
    updatedAt: 500,
    status: 'failed',
    problem: 'dependency-failed',
    failedDependency: 'c1',
    after: ['c1'],
    draft: { projectId: 'p1', prompt: '接着改', worktree: false },
    ...over,
  });
  const fileWith = (...items: PendingDispatch[]): SecretaryDispatchFile => ({
    ...emptyFile(),
    pending: Object.fromEntries(items.map((item) => [item.id, item])),
  });
  const needsYou = (file: SecretaryDispatchFile) =>
    buildBoard(file, { rows: {}, statuses: {}, projects: [localProject()], todos: [] }).needsYou;

  it('出问题的等待派发：移除并写审计，之后不再出现在需要你处理', () => {
    const h = harness({ file: fileWith(pendingOf('pend-1')) });
    h.file.outbox = [{ key: 'k', at: 1, text: 't' } as SecretaryDispatchFile['outbox'][number]];
    expect(needsYou(h.file).map((card) => card.kind)).toEqual(['pending']);

    expect(dismissPending(h.ports, 'pend-1')).toEqual({ ok: true });
    expect(h.file.pending).toBeUndefined();
    expect(needsYou(h.file)).toEqual([]);
    // 秘书那边已经排队的结果照常投递
    expect(h.file.outbox).toHaveLength(1);
    expect(h.audits).toEqual([
      {
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'pending_dismiss',
        targetId: 'pend-1',
        ok: true,
        detail: 'dependency-failed',
      },
    ]);
  });

  it('只移除点名的那条：等待中的和其他出问题的都保留', () => {
    const h = harness({
      file: fileWith(
        pendingOf('pend-1'),
        pendingOf('pend-2', { problem: 'dispatch-failed' }),
        pendingOf('wait-1', { status: 'waiting', problem: undefined, failedDependency: undefined })
      ),
    });
    expect(dismissPending(h.ports, 'pend-1')).toEqual({ ok: true });
    expect(Object.keys(h.file.pending ?? {}).sort()).toEqual(['pend-2', 'wait-1']);
  });

  it('等待中的不能忽略，不存在的拒绝，都不写盘不审计', () => {
    const waiting = pendingOf('wait-1', { status: 'waiting', problem: undefined });
    const h = harness({ file: fileWith(waiting) });
    expect(dismissPending(h.ports, 'wait-1')).toEqual({ ok: false, error: 'not-dismissible' });
    expect(dismissPending(h.ports, 'nope')).toEqual({ ok: false, error: 'not-found' });
    expect(h.file.pending).toEqual({ 'wait-1': waiting });
    expect(h.audits).toEqual([]);
  });

  it('秘书取消另一条等待派发时，不会把用户刚忽略的那条写回来', async () => {
    const h = harness({
      file: fileWith(
        pendingOf('pend-1'),
        pendingOf('wait-1', { status: 'waiting', problem: undefined, failedDependency: undefined })
      ),
    });
    const projects = h.ports.projects;
    // 取消流程等项目列表的间隙里，用户点了忽略
    h.ports.projects = () => {
      dismissPending(h.ports, 'pend-1');
      return projects();
    };
    expect(await run(h.handlers.session_stop, { conversationId: 'wait-1' })).toEqual({
      status: 'cancelled',
      pendingId: 'wait-1',
    });
    expect(h.file.pending).toBeUndefined();
  });
});

describe('markResult', () => {
  const file = (over: Partial<DispatchRecord> = {}): SecretaryDispatchFile => ({
    ...emptyFile(),
    dispatched: {
      c1: {
        conversationId: 'c1',
        projectId: 'p1',
        secretaryConversationId: 'sec-1',
        createdAt: 900,
        turn: 2,
        lastState: 'running',
        lastEventAt: 900,
        ...over,
      },
    },
  });

  it('手动标记完成：收口成完成并标 manual，审计写明是手动', async () => {
    const h = harness({ file: file({ backgroundRunning: true }) });
    expect(await markResult(h.ports, 'c1', 'done')).toEqual({ ok: true });
    expect(h.file.dispatched.c1).toMatchObject({
      lastState: 'idle',
      lastResult: { kind: 'goal-complete', turn: 2, at: NOW, manual: true },
    });
    expect(h.file.dispatched.c1.backgroundRunning).toBeUndefined();
    expect(h.audits).toEqual([
      {
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'result_mark_done',
        targetId: 'c1',
        ok: true,
        detail: 'manual',
      },
    ]);
  });

  it('撤销标记：放回进行中，只对用户手动标的结果生效', async () => {
    const manual = harness({
      file: file({ lastResult: { kind: 'goal-complete', turn: 2, at: 950, manual: true } }),
    });
    expect(await markResult(manual.ports, 'c1', 'undo')).toEqual({ ok: true });
    expect(manual.file.dispatched.c1.lastResult).toBeUndefined();
    expect(manual.file.dispatched.c1).toMatchObject({ lastState: 'running', manualUndoneAt: NOW });
    expect(manual.audits[0]).toMatchObject({ op: 'result_mark_undo', detail: 'manual' });

    // 会话自己给出的结果不能被界面抹掉
    const real = harness({
      file: file({ lastResult: { kind: 'goal-complete', turn: 2, at: 950 } }),
    });
    expect(await markResult(real.ports, 'c1', 'undo')).toEqual({ ok: false, error: 'not-manual' });
    expect(real.file.dispatched.c1.lastResult).toMatchObject({ kind: 'goal-complete' });
    expect(real.audits).toEqual([]);
  });

  it('普通会话没有派发记录：不动也不写审计', async () => {
    const h = harness({});
    expect(await markResult(h.ports, 'other', 'done')).toEqual({ ok: false, error: 'not-found' });
    expect(h.audits).toEqual([]);
  });

  it('移出：只从看板上拿掉，不标完成，会话记录还在', async () => {
    const h = harness({
      file: file({ lastState: 'idle', stoppedAt: 950, backgroundRunning: true }),
    });
    expect(await markResult(h.ports, 'c1', 'dismiss')).toEqual({ ok: true });
    expect(h.file.dispatched.c1.lastResult).toBeUndefined();
    expect(h.file.dispatched.c1).toMatchObject({ lastState: 'idle', dismissedFromBoard: true });
    expect(h.file.dispatched.c1.backgroundRunning).toBeUndefined();
    expect(h.audits[0]).toMatchObject({ op: 'result_dismiss_board', detail: 'manual' });
  });

  it('移出后再标记完成：按完成收口，移出标记清掉', async () => {
    const h = harness({ file: file({ dismissedFromBoard: true, stoppedAt: 950 }) });
    expect(await markResult(h.ports, 'c1', 'done')).toEqual({ ok: true });
    expect(h.file.dispatched.c1.lastResult).toMatchObject({ kind: 'goal-complete', manual: true });
    expect(h.file.dispatched.c1.dismissedFromBoard).toBeUndefined();
  });
});

describe('buildSecretaryState', () => {
  it('待确认提案进 needsYou，派出会话按状态分组', async () => {
    const h = harness({
      file: dispatchedFile('c1', 'running'),
      rows: { c1: { projectId: 'p1', title: '修构建', sessionFile: '/s/c1.jsonl' } },
      statuses: { c1: { state: 'running', pendingAsks: 0, pendingApprovals: 0 } },
    });
    h.file.proposals.p1 = {
      id: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: 900,
      updatedAt: 900,
      status: 'pending',
      kind: 'dispatch',
      draft: { projectId: 'p1', prompt: '修构建', worktree: false },
    };

    const state = await buildSecretaryState(h.ports, { enabled: true, projectId: 'sec-proj' });

    expect(state).toMatchObject({ enabled: true, projectId: 'sec-proj' });
    expect(state.board.needsYou.map((card) => card.kind)).toEqual(['proposal']);
    expect(state.board.running).toHaveLength(1);
    expect(state.board.running[0]).toMatchObject({
      kind: 'session',
      conversationId: 'c1',
      projectName: 'alpha',
      state: 'running',
    });
    expect(state.board.done).toEqual([]);
  });
});

describe('派出会话的默认静音与无人值守', () => {
  const createNow = (options: Parameters<typeof harness>[0] = {}) => harness(options);

  it('默认档案派出的会话默认静音并且无人值守', async () => {
    const h = createNow();
    await call(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(h.created[0]).toMatchObject({ muted: true, unattended: true });
  });

  it('待办派出的会话同样带上两个默认值', async () => {
    const h = createNow({
      todos: [{ id: 't1', text: '看构建', projectId: 'p1', createdAt: 1, updatedAt: 1 }],
    });
    await call(h.handlers.todo_item_dispatch, { todoId: 't1' });
    expect(h.created[0]).toMatchObject({ muted: true, unattended: true });
  });

  it('旧的待确认卡确认派出时也套用默认值', async () => {
    const h = harness();
    const payload = legacyDispatchCard(h, { projectId: 'p1', prompt: '修构建' });
    await resolveProposal(h.ports, payload.proposalId, 'confirm');
    expect(h.created[0]).toMatchObject({ muted: true, unattended: true });
  });

  it('旧档案里关掉的两个开关不再生效，派出的会话照样静音且无人值守', async () => {
    const h = createNow({
      profile: parseProfile({ dispatchMuted: false, dispatchUnattended: false }),
    });
    await call(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(h.created[0]).toMatchObject({ muted: true, unattended: true });
  });

  it('接管的会话不建新会话，也不改它原来的静音与无人值守', async () => {
    const h = harness({
      projects: [localProject(), localProject('sec-proj', { kind: 'secretary' })],
      conversations: [rootConversation('c1'), rootConversation('sec-chat', 'sec-proj')],
      rows: {
        c1: { projectId: 'p1', title: '修构建', sessionFile: '/s/c1.jsonl', muted: false },
        'sec-chat': { projectId: 'sec-proj', lastActiveAt: 10 },
      },
    });
    await call(h.handlers.session_takeover_propose, { conversationId: 'c1' });
    expect(await resolveProposal(h.ports, 'id-1', 'confirm')).toMatchObject({ ok: true });
    expect(h.file.dispatched.c1).toMatchObject({ takeover: { via: 'proposal' } });
    expect(h.created).toEqual([]);
    expect(h.rows.c1).toEqual({
      projectId: 'p1',
      title: '修构建',
      sessionFile: '/s/c1.jsonl',
      muted: false,
    });
  });
});

describe('派发基线', () => {
  const direct = () => harness();

  it('checkout/baseRef/branch 原样带给建会话，并记在派出记录上', async () => {
    const h = direct();
    const payload = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '接着改',
      worktree: true,
      checkout: '/repo/alpha-secretary',
      baseRef: 'feat/secretary-agent',
      branch: 'feat/secretary-dispatch-plus',
    })) as { status: string; conversationId: string };
    expect(payload.status).toBe('created');
    expect(h.created[0]).toMatchObject({
      worktree: true,
      checkout: '/repo/alpha-secretary',
      baseRef: 'feat/secretary-agent',
      branch: 'feat/secretary-dispatch-plus',
    });
    expect(h.file.dispatched[payload.conversationId]).toMatchObject({
      baseRef: 'feat/secretary-agent',
      branch: 'feat/secretary-dispatch-plus',
      checkout: '/repo/alpha-secretary',
    });
    expect(h.baseFactsCalls).toEqual([
      {
        projectPath: '/repo/alpha',
        checkout: '/repo/alpha-secretary',
        baseRef: 'feat/secretary-agent',
        branch: 'feat/secretary-dispatch-plus',
      },
    ]);
  });

  it('checkout 越界、baseRef 不存在、分支重名都在建会话之前拒绝', async () => {
    const cases: [Partial<DispatchBaseFacts>, string][] = [
      [{ knownCheckout: false }, 'checkout-not-in-project'],
      [{ sameRepo: false }, 'checkout-other-repo'],
      [{ baseRefExists: false }, 'base-ref-missing'],
      [{ branchExists: true }, 'branch-exists'],
      [{ branchValid: false }, 'branch-invalid'],
    ];
    for (const [facts, error] of cases) {
      const h = harness({
        profile: profile(),
        baseFacts: facts,
      });
      const result = await call(h.handlers.session_create, {
        projectId: 'p1',
        prompt: '接着改',
        worktree: true,
        checkout: '/repo/alpha-secretary',
        baseRef: 'feat/secretary-agent',
        branch: 'feat/x',
      });
      expect(result).toEqual({ ok: false, error });
      expect(h.created).toEqual([]);
      expect(h.file.dispatched).toEqual({});
    }
  });

  it('不建 worktree 时带基线直接拒绝，不假装隔离生效', async () => {
    const h = direct();
    const result = await call(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '接着改',
      worktree: false,
      baseRef: 'feat/secretary-agent',
    });
    expect(result).toEqual({ ok: false, error: 'base-requires-worktree' });
    expect(h.created).toEqual([]);
  });

  it('待办派发的说明写明实际用到的基线与分支', async () => {
    const h = harness({
      profile: profile(),
      todos: [{ id: 't1', text: '看构建', projectId: 'p1', createdAt: 1, updatedAt: 1 }],
    });
    await run(h.handlers.todo_item_dispatch, {
      todoId: 't1',
      worktree: true,
      baseRef: 'feat/secretary-agent',
      branch: 'feat/secretary-dispatch-plus',
    });
    expect(h.created[0]).toMatchObject({
      prompt: '看构建',
      goal: '看构建',
      baseRef: 'feat/secretary-agent',
      branch: 'feat/secretary-dispatch-plus',
    });
  });
});

describe('派发先后依赖', () => {
  const direct = (options: Parameters<typeof harness>[0] = {}) =>
    harness({
      profile: profile(),
      ...options,
    });

  const depRow = (id: string) => ({ projectId: 'p1', title: id, sessionFile: `/s/${id}.jsonl` });

  const finished = (id: string, kind: 'goal-complete' | 'turn-ended' = 'turn-ended') => ({
    conversationId: id,
    projectId: 'p1',
    secretaryConversationId: 'sec-1',
    createdAt: 1,
    turn: 1,
    lastState: 'idle' as const,
    lastEventAt: 1,
    lastResult: { kind, turn: 1, at: 1 },
  });

  it('带 after 的派发先等依赖：不建会话、不占运行名额', async () => {
    const h = direct({
      profile: profile({
        maxRunningDispatches: 1,
      }),
      file: dispatchedFile('busy', 'running'),
      rows: { busy: depRow('busy'), c1: depRow('c1') },
      statuses: { busy: running },
    });
    const payload = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '接着改',
      after: ['c1'],
    })) as { status: string; pendingId: string };
    expect(payload.status).toBe('waiting');
    expect(h.created).toEqual([]);
    expect(h.file.pending?.[payload.pendingId]).toMatchObject({
      status: 'waiting',
      after: ['c1'],
      projectId: 'p1',
      secretaryConversationId: 'sec-1',
    });
  });

  it('依赖真正结束后才开始，并从等待表里移走', async () => {
    const h = direct({
      rows: { c1: depRow('c1') },
      statuses: { c1: idle },
      file: { ...emptyFile(), dispatched: { c1: finished('c1') } },
    });
    const payload = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '接着改',
      after: ['c1'],
    })) as { pendingId: string };
    await startPendingDispatches(h.ports, [payload.pendingId], NOW);
    expect(h.created).toHaveLength(1);
    expect(h.file.pending).toBeUndefined();
    expect(h.file.dispatched['new-1']).toMatchObject({ projectId: 'p1' });
    expect(h.audits.at(-1)).toMatchObject({ op: 'dispatch_pending', ok: true });
  });

  it('依赖还在跑就继续等，不建会话', async () => {
    const h = direct({
      rows: { c1: depRow('c1') },
      statuses: { c1: running },
      file: { ...emptyFile(), dispatched: { c1: { ...finished('c1'), lastState: 'running' } } },
    });
    const payload = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '接着改',
      after: ['c1'],
    })) as { pendingId: string };
    await startPendingDispatches(h.ports, [payload.pendingId], NOW);
    expect(h.created).toEqual([]);
    expect(h.file.pending?.[payload.pendingId]?.status).toBe('waiting');
  });

  it('依赖失败、被停止或被删除都不启动，标成出问题并推一条结果', async () => {
    const cases: [string, Parameters<typeof harness>[0], string][] = [
      [
        'dependency-failed',
        {
          rows: { c1: depRow('c1') },
          statuses: { c1: idle },
          file: {
            ...emptyFile(),
            dispatched: {
              c1: { ...finished('c1'), lastResult: { kind: 'failed', turn: 1, at: 1 } },
            },
          },
        },
        'dependency-failed',
      ],
      [
        'dependency-stopped',
        {
          rows: { c1: depRow('c1') },
          statuses: { c1: idle },
          file: { ...emptyFile(), dispatched: { c1: { ...finished('c1'), stoppedAt: 5 } } },
        },
        'dependency-stopped',
      ],
      ['dependency-deleted', { rows: {}, statuses: {} }, 'dependency-deleted'],
    ];
    for (const [name, options, problem] of cases) {
      const h = direct(options);
      const payload = (await run(h.handlers.session_create, {
        projectId: 'p1',
        prompt: '接着改',
        after: ['c1'],
      })) as { pendingId: string };
      await startPendingDispatches(h.ports, [payload.pendingId], NOW);
      expect(h.created).toEqual([]);
      expect(h.file.pending?.[payload.pendingId]).toMatchObject({
        status: 'failed',
        problem,
        failedDependency: 'c1',
      });
      expect(h.file.outbox).toHaveLength(1);
      expect(h.file.outbox[0]).toMatchObject({
        kind: 'pending',
        pendingId: payload.pendingId,
        status: 'failed',
        problem,
      });
      expect(name).toBe(problem);
    }
  });

  it('两次判定并发都看到依赖失败：用户在两次之间忽略了它，第二次不会把它写回来', async () => {
    const h = direct({
      rows: { c1: depRow('c1') },
      statuses: { c1: idle },
      file: {
        ...emptyFile(),
        dispatched: { c1: { ...finished('c1'), lastResult: { kind: 'failed', turn: 1, at: 1 } } },
      },
    });
    const { pendingId } = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '接着改',
      after: ['c1'],
    })) as { pendingId: string };
    const rows = h.ports.rows;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.ports.rows = async () => {
      const value = await rows();
      if (++calls === 2) await gate;
      return value;
    };
    const first = startPendingDispatches(h.ports, [pendingId], NOW);
    const second = startPendingDispatches(h.ports, [pendingId], NOW);
    await first;
    expect(dismissPending(h.ports, pendingId)).toEqual({ ok: true });
    release();
    await second;
    expect(h.file.pending).toBeUndefined();
    expect(h.file.outbox).toHaveLength(1);
    expect(h.audits.filter((entry) => entry.op === 'dispatch_pending' && !entry.ok)).toHaveLength(
      1
    );
  });

  it('重启后等待中的派发还在，依赖结束后照样开始', async () => {
    const h = direct({
      rows: { c1: depRow('c1') },
      statuses: { c1: idle },
      file: { ...emptyFile(), dispatched: { c1: finished('c1') } },
    });
    const payload = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '接着改',
      goal: '完成修复并开 PR 合并',
      after: ['c1'],
    })) as { pendingId: string };
    // 落盘再读回：等待状态是持久化的，不靠内存
    const restored = parseDispatchFile(JSON.parse(JSON.stringify(h.file)));
    h.file = restored;
    expect(restored.pending?.[payload.pendingId]).toMatchObject({ after: ['c1'] });
    await startPendingDispatches(h.ports, [payload.pendingId], NOW);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      prompt: '接着改',
      goal: '完成修复并开 PR 合并',
    });
    expect(h.created[0].prompt).not.toMatch(/不推送|不合并/);
    expect(h.file.dispatched['new-1']).toMatchObject({ goal: '完成修复并开 PR 合并' });
  });

  it('todo_item_dispatch 带 after 等待派发：持久化恢复并开始后保留 goal 与 prompt，无头部注入', async () => {
    const h = direct({
      rows: { c1: depRow('c1') },
      statuses: { c1: idle },
      file: { ...emptyFile(), dispatched: { c1: finished('c1') } },
      todos: [
        {
          id: 't1',
          text: '监听认领与线程关联',
          projectId: 'p1',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    const prompt = '实现监听认领并开 PR 合并';
    const payload = (await run(h.handlers.todo_item_dispatch, {
      todoId: 't1',
      prompt,
      goal: '监听认领合并进 main',
      after: ['c1'],
    })) as { pendingId: string };
    h.file = parseDispatchFile(JSON.parse(JSON.stringify(h.file)));
    await startPendingDispatches(h.ports, [payload.pendingId], NOW);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      prompt: `${prompt}\n\n待办原文（背景）：\n监听认领与线程关联`,
      goal: '监听认领合并进 main',
    });
    expect(h.created[0].prompt).not.toMatch(/不推送|不合并/);
    expect(h.file.dispatched['new-1']).toMatchObject({ todoId: 't1', goal: '监听认领合并进 main' });
  });

  it('秘书用 session_stop 传 pendingId 取消等待中的派发', async () => {
    const h = direct({ rows: { c1: depRow('c1') }, statuses: { c1: running } });
    const payload = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '接着改',
      after: ['c1'],
    })) as { pendingId: string };
    const result = await call(h.handlers.session_stop, { conversationId: payload.pendingId });
    expect(result).toEqual({
      ok: true,
      result: { status: 'cancelled', pendingId: payload.pendingId },
    });
    expect(h.file.pending).toBeUndefined();
    expect(h.file.outbox[0]).toMatchObject({ kind: 'pending', problem: 'cancelled' });
    expect(h.aborts).toEqual([]);
  });
});

describe('停止后不再被续跑或唤醒', () => {
  it('停止时暂停目标、撤掉驱动者的续跑，并记下停止时间', async () => {
    const h = harness({
      file: dispatchedFile('c1', 'running'),
      rows: { c1: { projectId: 'p1', title: '改构建', sessionFile: '/s/c1.jsonl' } },
      statuses: { c1: running },
    });
    const result = await call(h.handlers.session_stop, { conversationId: 'c1' });
    expect(result).toEqual({ ok: true, result: { status: 'stopped' } });
    // 没有目标也照样暂停：停止就是停止
    expect(h.pausedGoals).toEqual(['c1']);
    expect(h.forgotten).toEqual(['c1']);
    expect(h.file.dispatched.c1).toMatchObject({ lastState: 'idle', stoppedAt: NOW });
  });

  it('worker 十秒内没停下就如实返回 running 并附说明', async () => {
    const h = harness({
      file: dispatchedFile('c1', 'running'),
      rows: { c1: { projectId: 'p1', sessionFile: '/s/c1.jsonl' } },
      statuses: { c1: running },
      waitStopped: 'running',
    });
    const result = await call(h.handlers.session_stop, { conversationId: 'c1' });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toMatchObject({ status: 'running' });
    expect((result.result as { note: string }).note).toContain('10 seconds');
    expect(h.audits.at(-1)?.detail).toContain('still-running');
  });
});

describe('等依赖的派发与确认卡', () => {
  it('旧的待确认卡带 after：确认后才进等待表', async () => {
    const h = harness({ rows: { c1: { projectId: 'p1', sessionFile: '/s/c1.jsonl' } } });
    const payload = legacyDispatchCard(h, { projectId: 'p1', prompt: '接着改', after: ['c1'] });
    expect(h.file.pending).toBeUndefined();
    expect(await resolveProposal(h.ports, payload.proposalId, 'confirm')).toMatchObject({
      ok: true,
    });
    expect(h.created).toEqual([]);
    expect(Object.values(h.file.pending ?? {})).toHaveLength(1);
    expect(h.file.pending && Object.values(h.file.pending)[0]).toMatchObject({
      status: 'waiting',
      after: ['c1'],
    });
  });

  it('依赖全结束后名额已满：照常建出排队会话，不判失败', async () => {
    const h = harness({
      profile: profile({
        maxRunningDispatches: 1,
      }),
      rows: {
        busy: { projectId: 'p1', sessionFile: '/s/busy.jsonl' },
        c1: { projectId: 'p1', sessionFile: '/s/c1.jsonl' },
      },
      statuses: { busy: running, c1: idle },
      file: {
        ...emptyFile(),
        dispatched: {
          busy: {
            conversationId: 'busy',
            projectId: 'p1',
            secretaryConversationId: 'sec-1',
            createdAt: 1,
            turn: 0,
            lastState: 'running',
            lastEventAt: 1,
          },
          c1: {
            conversationId: 'c1',
            projectId: 'p1',
            secretaryConversationId: 'sec-1',
            createdAt: 1,
            turn: 1,
            lastState: 'idle',
            lastEventAt: 1,
            lastResult: { kind: 'turn-ended', turn: 1, at: 1 },
          },
        },
      },
    });
    const payload = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '接着改',
      after: ['c1'],
    })) as { pendingId: string };
    await startPendingDispatches(h.ports, [payload.pendingId], NOW);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ queued: true, prompt: '接着改' });
    expect(h.file.pending).toBeUndefined();
    expect(h.file.outbox).toEqual([]);
    expect(h.audits.at(-1)).toMatchObject({ op: 'dispatch_pending', detail: 'queued new-1' });
  });

  it('依赖没结束时照旧等待：名额满也不提前建排队会话', async () => {
    const h = harness({
      profile: profile({ maxRunningDispatches: 1 }),
      rows: { c1: { projectId: 'p1', sessionFile: '/s/c1.jsonl' } },
      statuses: { c1: running },
      file: dispatchedFile('c1', 'running'),
    });
    const payload = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '接着改',
      after: ['c1'],
    })) as { status: string; pendingId: string };
    expect(payload.status).toBe('waiting');
    await startPendingDispatches(h.ports, [payload.pendingId], NOW);
    expect(h.created).toEqual([]);
    expect(h.file.pending?.[payload.pendingId]).toMatchObject({ status: 'waiting' });
  });
});

describe('session_task_stop', () => {
  const runningTask = (taskId = 't1'): ObservedTask => ({
    taskId,
    command: 'python3 -m http.server 8931 --directory /tmp',
    status: 'running',
    startedAt: 0,
  });

  it('停掉自己派发会话的后台任务并记审计', async () => {
    const h = harness({
      file: dispatchedFile('c1'),
      rows: { c1: { projectId: 'p1', title: '改构建', sessionFile: '/s/c1.jsonl' } },
      statuses: { c1: idle },
      tasks: { c1: [runningTask()] },
    });
    const result = await call(h.handlers.session_task_stop, {
      conversationId: 'c1',
      taskId: 't1',
    });
    expect(result).toEqual({
      ok: true,
      result: { status: 'stopped', conversationId: 'c1', taskId: 't1' },
    });
    expect(h.stoppedTasks).toEqual([{ conversationId: 'c1', taskId: 't1' }]);
    expect(h.audits.at(-1)).toMatchObject({
      op: 'session_task_stop',
      targetId: 'c1',
      ok: true,
      detail: 'stopped t1',
    });
  });

  it('只允许停自己派发或跟踪的会话：范围里没跟踪过的会话被拒', async () => {
    const h = harness({
      profile: {
        ...profile(),
        takeoverScope: { mode: 'projects', projectIds: ['p1'] },
      },
      conversations: [rootConversation('c1'), rootConversation('c2')],
      rows: { c2: { projectId: 'p1', title: '别人的会话', sessionFile: '/s/c2.jsonl' } },
      statuses: { c2: idle },
      tasks: { c2: [runningTask()] },
    });
    const result = await call(h.handlers.session_task_stop, {
      conversationId: 'c2',
      taskId: 't1',
    });
    expect(result.ok).toBe(false);
    expect(h.stoppedTasks).toEqual([]);
    expect(h.audits.at(-1)).toMatchObject({ op: 'session_task_stop', ok: false });
  });

  it('任务不属于这个会话、或已经结束时拒绝', async () => {
    const h = harness({
      file: dispatchedFile('c1'),
      rows: { c1: { projectId: 'p1', sessionFile: '/s/c1.jsonl' } },
      statuses: { c1: idle },
      tasks: { c1: [{ ...runningTask(), taskId: 'other', status: 'done' }] },
    });
    const missing = await call(h.handlers.session_task_stop, {
      conversationId: 'c1',
      taskId: 't1',
    });
    expect(missing.ok).toBe(false);
    const ended = await call(h.handlers.session_task_stop, {
      conversationId: 'c1',
      taskId: 'other',
    });
    expect(ended.ok).toBe(false);
    expect(h.stoppedTasks).toEqual([]);
  });

  it('缺 taskId 直接按参数错误拒绝', async () => {
    const h = harness({ file: dispatchedFile('c1'), statuses: { c1: idle } });
    const result = await call(h.handlers.session_task_stop, { conversationId: 'c1' });
    expect(result.ok).toBe(false);
    expect(h.stoppedTasks).toEqual([]);
  });
});

/** 已经终态的空闲派发记录：归档的合法输入 */
const settledFile = (
  conversationIds: string[] = ['c1'],
  kind: 'goal-complete' | 'failed' = 'goal-complete'
): SecretaryDispatchFile => ({
  ...emptyFile(),
  dispatched: Object.fromEntries(
    conversationIds.map((conversationId) => [
      conversationId,
      {
        conversationId,
        projectId: 'p1',
        secretaryConversationId: 'sec-1',
        createdAt: 900,
        turn: 1,
        lastState: 'idle' as const,
        lastEventAt: 900,
        stateSince: 900,
        lastResult: { kind, turn: 1, at: 950 },
      },
    ])
  ),
});

const settledRows = (conversationIds: string[]) =>
  Object.fromEntries(
    conversationIds.map((id) => [
      id,
      { projectId: 'p1', title: `会话 ${id}`, sessionFile: `/s/${id}.jsonl` },
    ])
  );

describe('session_archive', () => {
  it('终态空闲的派发会话能归档，效果与手动归档一致', async () => {
    const h = harness({
      file: settledFile(['c1']),
      rows: settledRows(['c1']),
      statuses: { c1: idle },
    });
    const result = await call(h.handlers.session_archive, { conversationId: 'c1' });
    expect(result).toEqual({
      ok: true,
      result: {
        results: [{ conversationId: 'c1', status: 'archived' }],
        archived: 1,
        skipped: 0,
        failed: 0,
      },
    });
    expect(h.archived).toEqual([{ conversationId: 'c1', at: NOW }]);
    expect(h.audits.at(-1)).toMatchObject({
      op: 'session_archive',
      targetId: 'c1',
      ok: true,
      detail: 'archived',
    });
  });

  it('还在跑的会话拒绝归档并说明原因', async () => {
    const h = harness({
      file: {
        ...settledFile(['c1']),
        dispatched: {
          c1: { ...settledFile(['c1']).dispatched.c1, lastState: 'running', lastResult: undefined },
        },
      },
      rows: settledRows(['c1']),
      statuses: { c1: running },
    });
    const result = await call(h.handlers.session_archive, { conversationId: 'c1' });
    expect(result.ok).toBe(true);
    const payload = (result as { result: { results: { status: string; reason?: string }[] } })
      .result;
    expect(payload.results[0]?.status).toBe('skipped');
    expect(payload.results[0]?.reason).toContain('still running');
    expect(h.archived).toEqual([]);
    expect(h.audits.at(-1)).toMatchObject({ op: 'session_archive', ok: false, detail: 'running' });
  });

  it('没有终态结果的会话拒绝归档', async () => {
    const h = harness({
      file: dispatchedFile('c1'),
      rows: settledRows(['c1']),
      statuses: { c1: idle },
    });
    const result = await call(h.handlers.session_archive, { conversationId: 'c1' });
    const payload = (result as { result: { results: { status: string; reason?: string }[] } })
      .result;
    expect(payload.results[0]?.status).toBe('skipped');
    expect(payload.results[0]?.reason).toContain('no finished result');
    expect(h.archived).toEqual([]);
  });

  it('非派发会话拒绝归档', async () => {
    const h = harness({
      profile: { ...profile(), takeoverScope: { mode: 'projects', projectIds: ['p1'] } },
      conversations: [rootConversation('c2')],
      rows: settledRows(['c2']),
      statuses: { c2: idle },
    });
    const result = await call(h.handlers.session_archive, { conversationId: 'c2' });
    const payload = (result as { result: { results: { status: string; reason?: string }[] } })
      .result;
    expect(payload.results[0]?.status).toBe('skipped');
    expect(payload.results[0]?.reason).toContain('not-operable');
    expect(h.archived).toEqual([]);
  });

  it('批量归档逐条给结果，部分成功部分跳过', async () => {
    const h = harness({
      file: settledFile(['c1', 'c2']),
      rows: settledRows(['c1', 'c2']),
      statuses: { c1: idle, c2: running },
    });
    const result = await call(h.handlers.session_archive, { ids: ['c1', 'c2', 'c3'] });
    expect(result.ok).toBe(true);
    const payload = (
      result as {
        result: {
          results: { conversationId: string; status: string }[];
          archived: number;
          skipped: number;
        };
      }
    ).result;
    expect(payload.results.map((entry) => [entry.conversationId, entry.status])).toEqual([
      ['c1', 'archived'],
      ['c2', 'skipped'],
      ['c3', 'skipped'],
    ]);
    expect(payload.archived).toBe(1);
    expect(payload.skipped).toBe(2);
    expect(h.archived.map((entry) => entry.conversationId)).toEqual(['c1']);
    // 每一条都留一条审计，成功与跳过都算
    expect(h.audits.filter((entry) => entry.op === 'session_archive')).toHaveLength(3);
  });

  it('超过 20 个或没给 id 按参数错误拒绝', async () => {
    const h = harness({ file: settledFile(['c1']), rows: settledRows(['c1']) });
    const tooMany = await call(h.handlers.session_archive, {
      ids: Array.from({ length: 21 }, (_, index) => `c${index}`),
    });
    expect(tooMany.ok).toBe(false);
    const empty = await call(h.handlers.session_archive, {});
    expect(empty.ok).toBe(false);
    expect(h.archived).toEqual([]);
  });
});

describe('派发时指定模型', () => {
  const strong = { providerId: 'anthropic', modelId: 'opus', thinkingLevel: 'high' as const };

  it('指定可用模型：建会话时用它，记录与审计都记下', async () => {
    const h = harness({
      models: ['anthropic/opus'],
      profile: profile(),
    });
    const result = await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '修构建',
      model: strong,
    });
    expect(result).toMatchObject({ status: 'created', conversationId: 'new-1' });
    expect(h.resolvedModels).toEqual([strong]);
    expect(h.created[0]?.model).toEqual({ providerId: 'anthropic', modelId: 'opus' });
    expect(h.created[0]?.thinkingLevel).toBe('high');
    expect(h.file.dispatched['new-1']?.model).toEqual(strong);
    expect(h.audits.at(-1)).toMatchObject({
      op: 'session_create',
      ok: true,
      detail: 'created · model anthropic/opus',
    });
  });

  it('不可用的模型直接报错，不静默回退也不建会话', async () => {
    const h = harness({
      models: ['anthropic/opus'],
      profile: profile(),
    });
    const result = await call(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '修构建',
      model: { providerId: 'anthropic', modelId: 'gone' },
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('unavailable');
    expect(h.created).toEqual([]);
    expect(h.audits.at(-1)).toMatchObject({ op: 'session_create', ok: false });
  });

  it('旧档案里的固定派发模型不再生效：不传模型就跟随项目', async () => {
    const h = harness({
      models: ['anthropic/opus'],
      profile: parseProfile({
        dispatchModel: { mode: 'fixed', model: { providerId: 'anthropic', modelId: 'opus' } },
      }),
    });
    await run(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(h.resolvedModels).toEqual([]);
    expect(h.created[0]?.model).toBeUndefined();
  });

  it('不传模型时不解析模型，跟随项目默认', async () => {
    const h = harness();
    await run(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(h.resolvedModels).toEqual([]);
    expect(h.created[0]?.model).toBeUndefined();
    expect(h.audits.at(-1)).toMatchObject({ detail: 'created' });
  });

  it('todo_item_dispatch 也能指定模型', async () => {
    const h = harness({
      models: ['anthropic/opus'],
      profile: profile(),
      todos: [
        {
          id: 't1',
          text: '修构建',
          doneAt: undefined,
          createdAt: 1,
          projectId: 'p1',
        } as SecretaryTodo,
      ],
    });
    const result = await run(h.handlers.todo_item_dispatch, {
      todoId: 't1',
      model: { providerId: 'anthropic', modelId: 'opus' },
    });
    expect(result).toMatchObject({ status: 'created', conversationId: 'new-1' });
    expect(h.created[0]?.model).toEqual({ providerId: 'anthropic', modelId: 'opus' });
    expect(h.audits.at(-1)).toMatchObject({
      op: 'todo_item_dispatch',
      detail: 'created · model anthropic/opus',
    });
  });
});

describe('result_mark_done / result_mark_undo', () => {
  it('把派发记录收口为完成，审计标明是秘书点的', async () => {
    const h = harness({
      file: dispatchedFile('c1', 'running'),
      rows: settledRows(['c1']),
      statuses: { c1: running },
    });
    const result = await call(h.handlers.result_mark_done, { conversationId: 'c1' });
    expect(result).toEqual({
      ok: true,
      result: { status: 'marked-done', conversationId: 'c1' },
    });
    expect(h.file.dispatched.c1.lastResult).toMatchObject({ kind: 'goal-complete', manual: true });
    expect(h.file.dispatched.c1.lastState).toBe('idle');
    expect(h.audits.at(-1)).toMatchObject({
      op: 'result_mark_done',
      targetId: 'c1',
      ok: true,
      detail: 'secretary',
    });
  });

  it('撤销手动标记，放回进行中', async () => {
    const h = harness({
      file: {
        ...dispatchedFile('c1'),
        dispatched: {
          c1: {
            ...dispatchedFile('c1').dispatched.c1,
            lastResult: { kind: 'goal-complete', turn: 1, at: 950, manual: true },
          },
        },
      },
      rows: settledRows(['c1']),
      statuses: { c1: idle },
    });
    const result = await call(h.handlers.result_mark_undo, { conversationId: 'c1' });
    expect(result).toEqual({ ok: true, result: { status: 'undone', conversationId: 'c1' } });
    expect(h.file.dispatched.c1.lastResult).toBeUndefined();
    expect(h.file.dispatched.c1.manualUndoneAt).toBe(NOW);
    expect(h.audits.at(-1)).toMatchObject({
      op: 'result_mark_undo',
      targetId: 'c1',
      ok: true,
      detail: 'secretary',
    });
  });

  it('只对派发或跟踪的会话有效，其他会话拒绝', async () => {
    const h = harness({
      profile: { ...profile(), takeoverScope: { mode: 'projects', projectIds: ['p1'] } },
      conversations: [rootConversation('c2')],
      rows: settledRows(['c2']),
      statuses: { c2: running },
    });
    const result = await call(h.handlers.result_mark_done, { conversationId: 'c2' });
    expect(result.ok).toBe(false);
    expect(h.audits.at(-1)).toMatchObject({ op: 'result_mark_done', ok: false });
    expect(h.file.dispatched.c2).toBeUndefined();
  });

  it('会话自己报的结果不能撤销', async () => {
    const h = harness({
      file: settledFile(['c1']),
      rows: settledRows(['c1']),
      statuses: { c1: idle },
    });
    const result = await call(h.handlers.result_mark_undo, { conversationId: 'c1' });
    expect(result.ok).toBe(false);
    expect(h.file.dispatched.c1.lastResult).toMatchObject({ kind: 'goal-complete' });
    expect(h.audits.at(-1)).toMatchObject({
      op: 'result_mark_undo',
      ok: false,
      detail: 'not-manual',
    });
  });
});

describe('看板停止遗留任务', () => {
  it('只停疑似闲置的任务，已保留的不动，遗留标记留着', async () => {
    const h = harness({
      file: {
        ...dispatchedFile('c1'),
        dispatched: {
          c1: {
            ...dispatchedFile('c1').dispatched.c1,
            leftoverTasks: {
              count: 2,
              commands: ['pnpm dev', 'iproxy'],
              taskIds: ['t1', 't2'],
              at: 1,
            },
          },
        },
      },
      tasks: {
        c1: [
          {
            taskId: 't1',
            command: 'pnpm dev',
            status: 'running',
            startedAt: 0,
            suspectedIdle: true,
          },
          { taskId: 't2', command: 'iproxy', status: 'running', startedAt: 0, kept: true },
        ],
      },
    });
    expect(await stopLeftoverTasks(h.ports, 'c1')).toEqual({ ok: true, stopped: ['t1'] });
    expect(h.stoppedTasks.map((entry) => entry.taskId)).toEqual(['t1']);
    expect(h.file.dispatched.c1.leftoverTasks?.count).toBe(2);
  });

  it('疑似闲置的全部停完后清掉遗留标记', async () => {
    const h = harness({
      file: {
        ...dispatchedFile('c1'),
        dispatched: {
          c1: {
            ...dispatchedFile('c1').dispatched.c1,
            backgroundPersistent: true,
            leftoverTasks: {
              count: 2,
              commands: ['pnpm dev', 'pnpm test'],
              taskIds: ['t1', 't2'],
              at: 1,
            },
          },
        },
      },
      tasks: {
        c1: [
          {
            taskId: 't1',
            command: 'pnpm dev',
            status: 'running',
            startedAt: 0,
            suspectedIdle: true,
          },
          {
            taskId: 't2',
            command: 'pnpm test',
            status: 'running',
            startedAt: 0,
            suspectedIdle: true,
          },
          { taskId: 't3', command: 'git status', status: 'done', startedAt: 0 },
        ],
      },
    });
    const result = await stopLeftoverTasks(h.ports, 'c1');
    expect(result).toEqual({ ok: true, stopped: ['t1', 't2'] });
    expect(h.stoppedTasks.map((entry) => entry.taskId)).toEqual(['t1', 't2']);
    expect(h.file.dispatched.c1.leftoverTasks).toBeUndefined();
    expect(h.file.dispatched.c1.backgroundPersistent).toBeUndefined();
    expect(h.audits.at(-1)).toMatchObject({ op: 'session_task_stop', detail: 'ui: t1,t2' });
  });

  it('没有派发记录的会话不给停', async () => {
    const h = harness({});
    expect(await stopLeftoverTasks(h.ports, 'c1')).toEqual({ ok: false, error: 'not-found' });
    expect(h.stoppedTasks).toEqual([]);
  });
});

describe('手机关注：派发把派生出来的会话交出去', () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'secretary-dispatch-follow-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** 探针：phone 里的秘书会话算手机发起，chat 固定 777 */
  function followDeps(dir: string, phone: Set<string>): FollowDeps {
    return {
      store: new FollowingStore(dir),
      probe: (conversationId) =>
        conversationId && phone.has(conversationId)
          ? { channelId: 'telegram', peerId: '777' }
          : null,
      audit: () => {},
      now: () => NOW,
    };
  }

  /** 与生产端口同一条路：follow 出口交给 recordPhoneFollow */
  function wireFollow(h: Harness, deps: FollowDeps): void {
    h.ports.follow = (input) => {
      recordPhoneFollow({ kind: 'session', ...input }, deps);
    };
  }

  it('手机发起的回合里 session_create 记进关注，桌面发起的不记', async () => {
    const dir = tempDir();
    const phone = new Set(['sec-1']);
    const deps = followDeps(dir, phone);
    const h = harness({
      profile: profile(),
    });
    wireFollow(h, deps);
    await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '给 apple-table 加 Score 字段',
    });
    expect(new FollowingStore(dir).list()).toMatchObject([
      {
        kind: 'session',
        targetId: 'new-1',
        origin: { channelId: 'telegram', peerId: '777' },
        summary: '给 apple-table 加 Score 字段',
      },
    ]);
    // 桌面上发起的回合：探针说不是手机，什么都不记
    phone.clear();
    await run(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(new FollowingStore(dir).list()).toMatchObject([
      { targetId: 'new-1', summary: '给 apple-table 加 Score 字段' },
    ]);
  });

  it('todo_item_dispatch 派生的会话也记进关注，摘要用待办标题', async () => {
    const dir = tempDir();
    const deps = followDeps(dir, new Set(['sec-1']));
    const h = harness({
      profile: profile(),
      todos: [
        { id: 't1', text: '看构建\n顺带补单测', projectId: 'p1', createdAt: 1, updatedAt: 1 },
      ],
    });
    wireFollow(h, deps);
    await run(h.handlers.todo_item_dispatch, { todoId: 't1' });
    expect(new FollowingStore(dir).list()).toMatchObject([
      { kind: 'session', targetId: 'new-1', summary: '看构建' },
    ]);
  });

  it('旧的待确认卡记着提案 id，确认后改挂到会话上', async () => {
    const dir = tempDir();
    const deps = followDeps(dir, new Set(['sec-1']));
    const h = harness();
    wireFollow(h, deps);
    h.ports.refollow = (from, to) => renameFollowedTarget(from, to, deps);
    h.ports.unfollow = (targetId) => unfollowTarget(targetId, deps);
    const payload = legacyDispatchCard(h, { projectId: 'p1', prompt: '修构建' });
    h.ports.follow?.({
      targetId: payload.proposalId,
      summary: '修构建',
      secretaryConversationId: 'sec-1',
    });
    expect(new FollowingStore(dir).list()).toMatchObject([{ targetId: payload.proposalId }]);
    await resolveProposal(h.ports, payload.proposalId, 'confirm');
    expect(new FollowingStore(dir).list()).toMatchObject([{ targetId: 'new-1' }]);
  });

  it('旧卡被拒时关注项一并移除', async () => {
    const dir = tempDir();
    const deps = followDeps(dir, new Set(['sec-1']));
    const h = harness();
    wireFollow(h, deps);
    h.ports.refollow = (from, to) => renameFollowedTarget(from, to, deps);
    h.ports.unfollow = (targetId) => unfollowTarget(targetId, deps);
    const payload = legacyDispatchCard(h, { projectId: 'p1', prompt: '修构建' });
    h.ports.follow?.({
      targetId: payload.proposalId,
      summary: '修构建',
      secretaryConversationId: 'sec-1',
    });
    await resolveProposal(h.ports, payload.proposalId, 'reject');
    expect(new FollowingStore(dir).list()).toEqual([]);
  });

  it('归档与收回接管都会结束关注', async () => {
    const dir = tempDir();
    const deps = followDeps(dir, new Set(['sec-1']));
    const file = dispatchedFile('c1');
    file.dispatched.c1.lastResult = { kind: 'goal-complete', turn: 0, at: 900 };
    file.dispatched.c2 = {
      conversationId: 'c2',
      projectId: 'p1',
      secretaryConversationId: 'sec-1',
      createdAt: 900,
      turn: 0,
      lastState: 'idle',
      lastEventAt: 900,
      takeover: { grantedAt: 900, via: 'proposal' },
    };
    const h = harness({ file, rows: { c1: { id: 'c1' } } });
    h.ports.unfollow = (targetId) => unfollowTarget(targetId, deps);
    deps.store.add({
      kind: 'session',
      targetId: 'c1',
      origin: { channelId: 'telegram', peerId: '777' },
      at: NOW,
      summary: '修构建',
    });
    expect(await call(h.handlers.session_archive, { conversationId: 'c1' })).toMatchObject({
      ok: true,
    });
    expect(new FollowingStore(dir).list()).toEqual([]);
    deps.store.add({
      kind: 'session',
      targetId: 'c2',
      origin: { channelId: 'telegram', peerId: '777' },
      at: NOW,
      summary: '接管来的',
    });
    revokeTakeover(h.ports, 'c2', 'settings');
    expect(new FollowingStore(dir).list()).toEqual([]);
  });
});

describe('排队会话', () => {
  const queuedRow = {
    projectId: 'p1',
    title: '排队的',
    secretaryOrigin: { secretaryConversationId: 'sec-1' },
    queuedStart: { queuedAt: 5, text: '修构建' },
  };

  it('session_send 发给排队会话：明确拒绝，提示取消或等它开始', async () => {
    const h = harness({
      file: dispatchedFile('q1'),
      rows: { q1: queuedRow },
      conversations: [rootConversation('q1')],
    });
    const result = await call(h.handlers.session_send, { conversationId: 'q1', message: '加一条' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('session-queued');
    expect(h.prompts).toEqual([]);
    expect(h.queued).toEqual([]);
  });

  it('session_stop 停排队会话就是取消：交给取消入口，不 abort', async () => {
    const h = harness({
      file: dispatchedFile('q1'),
      rows: { q1: queuedRow },
      conversations: [rootConversation('q1')],
    });
    const cancels: { id: string; by: string | null }[] = [];
    h.ports.cancelQueued = async (id, by) => {
      cancels.push({ id, by });
      return { ok: true };
    };
    h.handlers = createSecretaryDispatchHandlers(h.ports);
    const result = await call(h.handlers.session_stop, { conversationId: 'q1' });
    expect(result).toEqual({
      ok: true,
      result: { status: 'cancelled', conversationId: 'q1', deleted: true },
    });
    expect(cancels).toEqual([{ id: 'q1', by: 'sec-1' }]);
    expect(h.aborts).toEqual([]);
  });

  it('正在启动的排队会话停不掉：如实报错', async () => {
    const h = harness({
      file: dispatchedFile('q1'),
      rows: { q1: queuedRow },
      conversations: [rootConversation('q1')],
    });
    h.ports.cancelQueued = async () => ({ ok: false, error: 'starting' });
    h.handlers = createSecretaryDispatchHandlers(h.ports);
    expect(await call(h.handlers.session_stop, { conversationId: 'q1' })).toEqual({
      ok: false,
      error: 'starting',
    });
  });

  it('todo_item_dispatch 与 session_create 排队后开始：完整保留 prompt 与 goal，无不推送注入', async () => {
    const { createSessionFromMain } = await import('./sessionFactory');
    const { createQueuedSessions } = await import('./queuedSessions');
    const h = harness({
      profile: profile({ maxRunningDispatches: 1 }),
      file: dispatchedFile('busy', 'running'),
      rows: { busy: { projectId: 'p1', title: '在跑', sessionFile: '/s/busy.jsonl' } },
      statuses: { busy: running },
      todos: [{ id: 't1', text: '排队待办', projectId: 'p1', createdAt: 1, updatedAt: 1 }],
    });
    const sent: { id: string; text: string }[] = [];
    let seq = 0;
    const factoryPorts = {
      project: (id: string) => h.projects.find((item) => item.projectId === id),
      createConversation: (projectId: string) => rootConversation(`q-${++seq}`, projectId),
      removeConversation: () => undefined,
      defaults: () => ({
        providerId: 'prov',
        modelId: 'm1',
        reasoningEnabled: true,
        thinkingLevel: 'medium' as const,
        approvalMode: 'assistant' as const,
      }),
      createWorktree: async (id: string, projectId: string) => ({
        conversationId: id,
        projectId,
        path: `/wt/${id}`,
        branch: `enso/${id}`,
        baseBranch: 'main',
        baseCommit: 'abc1234',
        repoPath: '/repo/alpha',
        createdAt: NOW,
      }),
      removeWorktree: async () => undefined,
      writeRow: (row: Record<string, unknown>) => {
        h.rows[row.id as string] = row;
      },
      removeRow: (id: string) => {
        delete h.rows[id];
      },
      spawn: async () => ({ ok: true }),
      release: async () => undefined,
      prompt: (id: string, text: string) => {
        sent.push({ id, text });
        return { ok: true };
      },
      imageInput: async () => false,
      newId: () => `d-${seq}`,
      now: () => NOW,
    };
    h.ports.createSession = (request) => createSessionFromMain(factoryPorts, request);
    h.handlers = createSecretaryDispatchHandlers(h.ports);
    const queuedPrompt = '实现功能并开 PR 合并';
    const queuedTodo = (await run(h.handlers.todo_item_dispatch, {
      todoId: 't1',
      prompt: queuedPrompt,
      goal: '排队待办合并进 main',
    })) as { status: string; conversationId: string };
    expect(queuedTodo.status).toBe('queued');

    const queuedCreate = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '排查日志并提 PR 合并',
      goal: '日志修复合进 main',
      worktree: true,
    })) as { status: string; conversationId: string };
    expect(queuedCreate.status).toBe('queued');
    // 排队顺序按 queuedAt 排序，设不同时间戳确保先进先出稳定
    (h.rows[queuedTodo.conversationId].queuedStart as { queuedAt: number }).queuedAt = NOW;
    (h.rows[queuedCreate.conversationId].queuedStart as { queuedAt: number }).queuedAt = NOW + 1;

    // 占着名额的会话结束，排队会话自动启动
    h.statuses.set('busy', idle);
    h.file.dispatched.busy.lastState = 'idle';
    const queue = createQueuedSessions({
      launch: factoryPorts,
      rows: () => h.rows,
      updateRow: (id, update) => {
        const next = h.rows[id] ? update(h.rows[id]) : null;
        if (next) h.rows[id] = next;
        return next;
      },
      removeWorktree: async () => undefined,
      removeRow: (id) => {
        delete h.rows[id];
      },
      removeConversation: () => undefined,
      owner: () => ({ id: '', dispatch: h.ports }),
      owners: () => [{ id: '', dispatch: h.ports }],
      maxTotal: () => 10,
      loadAttachments: async () => ({ images: [] }),
      now: () => NOW,
      newId: () => 'm-1',
    });
    await queue.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0].id).toBe(queuedTodo.conversationId);
    expect(sent[0].text).toContain(`${queuedPrompt}\n\n待办原文（背景）：\n排队待办`);
    expect(sent[0].text).toContain('<goal-continuation>');
    expect(sent[0].text).toContain('排队待办合并进 main');
    expect(sent[0].text).not.toMatch(/不推送|不合并|独立目录和空闲端口|不要改主检出/);
    expect(h.rows[queuedTodo.conversationId].queuedStart).toBeUndefined();
    expect(h.rows[queuedTodo.conversationId].goal).toMatchObject({
      text: '排队待办合并进 main',
      status: 'active',
    });

    // 第一条完成后让出名额，第二条 session_create 排队会话启动并完整保留 prompt 与 goal
    h.statuses.set(queuedTodo.conversationId, idle);
    h.file.dispatched[queuedTodo.conversationId].lastState = 'idle';
    await queue.drain();
    expect(sent).toHaveLength(2);
    expect(sent[1].id).toBe(queuedCreate.conversationId);
    expect(sent[1].text).toContain('排查日志并提 PR 合并');
    expect(sent[1].text).toContain('<goal-continuation>');
    expect(sent[1].text).toContain('日志修复合进 main');
    expect(sent[1].text).not.toMatch(/不推送|不合并|独立目录和空闲端口|不要改主检出/);
    expect(h.rows[queuedCreate.conversationId].queuedStart).toBeUndefined();
    expect(h.rows[queuedCreate.conversationId].goal).toMatchObject({
      text: '日志修复合进 main',
      status: 'active',
    });
  });
});

describe('手动标完成写入 daily、新 goal 才解除锁定与停止清旧失败', () => {
  it('result_mark_done 同步写入 daily.jsonl，不带 goal 的 session_send 不解除手动完成，带 goal 才重新跟踪', async () => {
    const daily: unknown[] = [];
    const h = harness({
      file: dispatchedFile('c1', 'idle'),
      rows: { c1: { id: 'c1', title: '修引用会话标题泄漏', driver: 'main' } },
      statuses: { c1: idle },
    });
    (h.ports as { recordDaily?: (entry: unknown) => void }).recordDaily = (entry) =>
      daily.push(entry);
    h.handlers = createSecretaryDispatchHandlers(h.ports);

    expect(await call(h.handlers.result_mark_done, { conversationId: 'c1' })).toEqual({
      ok: true,
      result: { status: 'marked-done', conversationId: 'c1' },
    });
    expect(daily).toEqual([
      expect.objectContaining({
        conversationId: 'c1',
        kind: 'goal-complete',
        at: NOW,
        title: '修引用会话标题泄漏',
      }),
    ]);

    // 不带新 goal 的 session_send：不撤下 manual 完成标记
    expect(
      await call(h.handlers.session_send, { conversationId: 'c1', message: '收到，不用改了' })
    ).toEqual({ ok: true, result: { status: 'sent' } });
    expect(h.file.dispatched.c1.lastResult).toMatchObject({ kind: 'goal-complete', manual: true });

    // 带新 goal 的 session_send：撤下 manual 完成标记并重新跟踪
    expect(
      await call(h.handlers.session_send, {
        conversationId: 'c1',
        message: '继续处理新问题',
        goal: '修另一个问题',
      })
    ).toEqual({ ok: true, result: { status: 'sent' } });
    expect(h.file.dispatched.c1.lastResult).toBeUndefined();
    expect(h.file.dispatched.c1.reopenedAt).toBe(NOW);
  });

  it('session_stop 清掉早先的 failed 结果，但保留停之前已经交过的 goal-complete', async () => {
    const h1 = harness({
      file: {
        ...dispatchedFile('c1', 'idle'),
        dispatched: {
          c1: {
            ...dispatchedFile('c1', 'idle').dispatched.c1,
            lastState: 'error',
            lastResult: { kind: 'failed', turn: 1, at: 900 },
          },
        },
      },
      rows: settledRows(['c1']),
      statuses: { c1: { state: 'error', pendingAsks: 0, pendingApprovals: 0 } },
    });
    await call(h1.handlers.session_stop, { conversationId: 'c1' });
    expect(h1.file.dispatched.c1.stoppedAt).toBe(NOW);
    expect(h1.file.dispatched.c1.lastResult).toBeUndefined();

    const h2 = harness({
      file: settledFile(['c1']),
      rows: settledRows(['c1']),
      statuses: { c1: idle },
    });
    await call(h2.handlers.session_stop, { conversationId: 'c1' });
    expect(h2.file.dispatched.c1.stoppedAt).toBe(NOW);
    expect(h2.file.dispatched.c1.lastResult).toMatchObject({ kind: 'goal-complete' });
  });
});
