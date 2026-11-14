import { parseProfile } from '@shared/secretary/parse';
import type { ConversationAuthority, ProjectAuthority } from '@shared/types/agent';
import type {
  DispatchRecord,
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryProfile,
  SecretaryProfileDraft,
  SecretarySkillDraft,
  SecretaryTodo,
  SecretaryToolDraft,
} from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import { createSecretaryTools, normalizeSecretaryParams } from '../../../agent/tools/secretary';
import {
  buildSecretaryState,
  createSecretaryDispatchHandlers,
  dismissResult,
  grantTakeover,
  listTakeovers,
  mutateTodo,
  NOT_OPERABLE_ERROR,
  resolveProposal,
  revokeTakeover,
  type SecretaryDispatchPorts,
  type SecretaryQueuedMessage,
} from './dispatch';
import type { SecretarySessionStatus } from './readers';
import type { MainSessionRequest, MainSessionResult } from './sessionFactory';
import type { SecretaryOpHandler } from './tools';

const ctx = { secretaryConversationId: 'sec-1' };
const NOW = 1_000;

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
  prompts: { conversationId: string; text: string; deliveryId: string }[];
  resumes: string[];
  aborts: string[];
  queued: { conversationId: string; message: SecretaryQueuedMessage }[];
  steers: { conversationId: string; text: string; deliveryId: string }[];
  pausedGoals: string[];
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
    branch?: string | null;
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
    branch: async () => (options.branch === undefined ? 'feat/secretary-agent' : options.branch),
    conversations: () => h.conversations,
    rows: () => h.rows,
    status: (conversationId) => h.statuses.get(conversationId) ?? idle,
    createSession: async (request) => {
      h.created.push(request);
      return h.createResult;
    },
    prompt: (conversationId, text, deliveryId) => {
      h.prompts.push({ conversationId, text, deliveryId });
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
    steer: (conversationId, text, deliveryId) => {
      h.steers.push({ conversationId, text, deliveryId });
      return { ok: true };
    },
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
    newId: () => `id-${++ids}`,
    now: () => NOW,
  };
  h.handlers = createSecretaryDispatchHandlers(h.ports);
  return h;
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
  it('ask-first 时只出提案，不建会话', async () => {
    const h = harness();
    const payload = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '修构建',
    })) as { status: string; proposalId: string };
    expect(payload.status).toBe('awaiting_confirmation');
    expect(h.created).toEqual([]);
    const proposal = h.file.proposals[payload.proposalId];
    expect(proposal.status).toBe('pending');
    expect(proposal.kind).toBe('dispatch');
    expect(proposal.secretaryConversationId).toBe('sec-1');
    expect(h.audits).toEqual([
      {
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'session_create',
        targetId: payload.proposalId,
        ok: true,
        detail: 'awaiting_confirmation',
      },
    ]);
  });

  it('未设置档案时按默认档案出提案', async () => {
    const h = harness({ profile: null });
    const payload = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '修构建',
    })) as { status: string };
    expect(payload.status).toBe('awaiting_confirmation');
    expect(h.created).toEqual([]);
  });

  it('免确认项目在 tell-after 下直接建会话并记派出', async () => {
    const h = harness({
      profile: profile({ autonomy: 'tell-after', autoApproveProjectIds: ['p1'] }),
    });
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

  it('达到并发上限时报错且不建会话', async () => {
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
      profile: profile({ autonomy: 'tell-after', autoApproveProjectIds: ['p1'] }),
      rows: {
        a: { title: 'a', sessionFile: '/a' },
        b: { title: 'b', sessionFile: '/b' },
        c: { title: 'c', sessionFile: '/c' },
      },
      statuses: { a: running, b: running, c: running },
    });
    const result = await call(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(result).toEqual({ ok: false, error: 'dispatch-limit' });
    expect(h.created).toEqual([]);
    expect(h.audits).toEqual([
      {
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'session_create',
        targetId: 'p1',
        ok: false,
        detail: 'dispatch-limit',
      },
    ]);
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
        autonomy: 'tell-after',
        autoApproveProjectIds: ['p1'],
        maxRunningDispatches: 1,
      }),
      rows: {
        a: { title: '等后台', sessionFile: '/a', goal: { status: 'waiting', text: '等后台' } },
      },
      statuses: { a: idle },
    });
    expect(
      await call(blocked.handlers.session_create, { projectId: 'p1', prompt: '再派一个' })
    ).toEqual({
      ok: false,
      error: 'dispatch-limit',
    });

    const finished = emptyFile();
    finished.dispatched.a = {
      ...waiting.dispatched.a,
      backgroundRunning: undefined,
      lastResult: { kind: 'goal-complete', turn: 1, at: 1 },
    };
    const open = harness({
      file: finished,
      profile: profile({
        autonomy: 'tell-after',
        autoApproveProjectIds: ['p1'],
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
        autonomy: 'tell-after',
        autoApproveProjectIds: ['p1'],
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
      result: { status: 'awaiting_confirmation', proposalId: 'id-1' },
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
        autonomy: 'full',
        autoApproveProjectIds: ['p1'],
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

  it('派出待办时按自主度出提案并带上待办 id', async () => {
    const h = harness({
      todos: [{ id: 't1', text: '看构建', projectId: 'p1', createdAt: 1, updatedAt: 1 }],
    });
    const payload = (await run(h.handlers.todo_item_dispatch, { todoId: 't1' })) as {
      status: string;
      proposalId: string;
    };
    expect(payload.status).toBe('awaiting_confirmation');
    const proposal = h.file.proposals[payload.proposalId];
    expect(proposal.kind === 'dispatch' && proposal.draft).toMatchObject({
      projectId: 'p1',
      todoId: 't1',
      title: '看构建',
      worktree: true,
    });
    const draft = proposal.kind === 'dispatch' ? proposal.draft : null;
    expect(draft?.prompt).toContain('项目：/repo/alpha');
    expect(draft?.prompt).toContain('基于 feat/secretary-agent 新建分支');
    expect(draft?.prompt).toContain('看构建');
  });

  it('派出待办的会话标题用待办文本而不是 prompt 开头，可用 title 覆盖', async () => {
    const h = harness({
      profile: profile({ autonomy: 'tell-after', autoApproveProjectIds: ['p1'] }),
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
      profile: profile({ autonomy: 'tell-after', autoApproveProjectIds: ['p1'] }),
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
      profile: profile({ autonomy: 'tell-after', autoApproveProjectIds: ['p1'] }),
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

  it('确认提案后关联待办，不覆盖确认前的修改', async () => {
    const h = harness({
      todos: [{ id: 't1', text: '看构建', projectId: 'p1', createdAt: 1, updatedAt: 1 }],
    });
    const payload = (await run(h.handlers.todo_item_dispatch, { todoId: 't1' })) as {
      proposalId: string;
    };
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
});

describe('resolveProposal', () => {
  it('同一提案确认两次只执行一次', async () => {
    const h = harness();
    const { proposalId } = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '修构建',
    })) as { proposalId: string };

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
    const propose = async () =>
      (
        (await run(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' })) as {
          proposalId: string;
        }
      ).proposalId;

    const blocked = await propose();
    h.profileValue = profile({ maxRunningDispatches: 1 });
    const refused = await resolveProposal(h.ports, blocked, 'confirm');
    expect(refused.ok && refused.proposal.status).toBe('failed');
    expect(refused.ok && refused.proposal.error).toBe('dispatch-limit');
    expect(h.created).toEqual([]);

    h.profileValue = profile({ maxRunningDispatches: 2 });
    const allowed = await propose();
    const confirmed = await resolveProposal(h.ports, allowed, 'confirm');
    expect(confirmed.ok && confirmed.proposal.status).toBe('succeeded');
    expect(h.created).toHaveLength(1);
  });

  it('两端同时确认也只执行一次', async () => {
    const h = harness();
    const { proposalId } = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '修构建',
    })) as { proposalId: string };

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
    const { proposalId } = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '修构建',
    })) as { proposalId: string };

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
    const { proposalId } = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '修构建',
    })) as { proposalId: string };
    h.projects = [];

    const result = await resolveProposal(h.ports, proposalId, 'confirm');

    expect(result.ok && result.proposal.status).toBe('failed');
    expect(result.ok && result.proposal.error).toBe('project-missing');
    expect(h.created).toEqual([]);
    expect(h.file.outbox.map((update) => update.kind)).toEqual(['proposal']);
    expect(h.file.outbox[0]).toMatchObject({ proposalId, status: 'failed' });
  });

  it('拒绝提案不执行', async () => {
    const h = harness();
    const { proposalId } = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '修构建',
    })) as { proposalId: string };

    const result = await resolveProposal(h.ports, proposalId, 'reject');

    expect(result.ok && result.proposal.status).toBe('rejected');
    expect(h.created).toEqual([]);
    expect(h.file.outbox[0]).toMatchObject({ proposalId, status: 'rejected' });
  });

  it('确认时用编辑后的草案', async () => {
    const h = harness();
    const { proposalId } = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '修构建',
    })) as { proposalId: string };

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
    const draft: SecretaryProfileDraft = { name: '小秘', autonomy: 'tell-after' };
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
    expect(h.file.outbox[0]).toMatchObject({ proposalId: 'p1', status: 'succeeded' });
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
      autonomy: 'full',
    });

    expect(h.appliedProfiles).toEqual([{ name: '小秘', autonomy: 'full' }]);
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
    h.ports.applyProfile = async () => ({ ok: false, error: 'invalid autonomy' });
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
    expect(result.ok && result.proposal.error).toBe('invalid autonomy');
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
    expect(h.file.outbox[0]).toMatchObject({ proposalId: 'p1', status: 'succeeded' });
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
      profile: profile({ autonomy: 'tell-after', autoApproveProjectIds: ['p1'] }),
      projects: [localProject(), localProject('sec-proj', { kind: 'secretary' })],
      conversations: [rootConversation('sec-chat', 'sec-proj')],
      rows: { 'sec-chat': { projectId: 'sec-proj', lastActiveAt: 10 } },
      todos: [{ id: 't1', text: '看构建', projectId: 'p1', createdAt: 1, updatedAt: 1 }],
    });
    const result = await mutateTodo(h.ports, { action: 'dispatch', todoId: 't1' });
    expect(result).toEqual({ ok: true, todoId: 't1' });
    expect(h.created[0].secretaryOrigin).toEqual({ secretaryConversationId: 'sec-chat' });
    expect(h.created[0].worktree).toBe(true);
    expect(h.created[0].prompt).toContain('项目：/repo/alpha');
    expect(h.created[0].prompt).toContain('worktree');
    expect(h.created[0].prompt).toContain('看构建');
    expect(h.todos[0].conversationId).toBe('new-1');
  });

  it('秘书传入的完整说明原样派出，显式不要 worktree 时也不建', async () => {
    const brief = '在独立 worktree 里工作，不推送不合并。\n修通知';
    const h = harness({
      profile: profile({
        autonomy: 'tell-after',
        autoApproveProjectIds: ['p1'],
        dispatchWorktree: 'auto',
      }),
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
  const createNow = (options: Parameters<typeof harness>[0] = {}) =>
    harness({
      profile: profile({ autonomy: 'tell-after', autoApproveProjectIds: ['p1'] }),
      ...options,
    });

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

  it('确认提案派出时也套用默认值', async () => {
    const h = harness();
    const payload = (await run(h.handlers.session_create, {
      projectId: 'p1',
      prompt: '修构建',
    })) as { proposalId: string };
    await resolveProposal(h.ports, payload.proposalId, 'confirm');
    expect(h.created[0]).toMatchObject({ muted: true, unattended: true });
  });

  it('关掉两个开关后不再套用默认值', async () => {
    const h = createNow({
      profile: profile({
        autonomy: 'tell-after',
        autoApproveProjectIds: ['p1'],
        dispatchMuted: false,
        dispatchUnattended: false,
      }),
    });
    await call(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(h.created[0]).not.toHaveProperty('muted');
    expect(h.created[0]).not.toHaveProperty('unattended');
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
