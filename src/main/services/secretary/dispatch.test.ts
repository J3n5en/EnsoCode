import { parseProfile } from '@shared/secretary/parse';
import type { ConversationAuthority, ProjectAuthority } from '@shared/types/agent';
import type {
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryProfile,
  SecretaryProfileDraft,
  SecretaryTodo,
} from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import {
  buildSecretaryState,
  createSecretaryDispatchHandlers,
  mutateTodo,
  resolveProposal,
  type SecretaryDispatchPorts,
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
  queued: { conversationId: string; message: { id: string; text: string } }[];
  pausedGoals: string[];
  profileValue: SecretaryProfile | null;
  appliedProfiles: SecretaryProfileDraft[];
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
    pausedGoals: [],
    profileValue: options.profile === undefined ? profile() : options.profile,
    appliedProfiles: [],
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
    appendQueued: (conversationId, message) => {
      h.queued.push({ conversationId, message });
      return true;
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

  it('项目不可见时拒绝', async () => {
    const h = harness({ profile: profile({ visibleProjectIds: ['p2'] }) });
    const result = await call(h.handlers.session_create, { projectId: 'p1', prompt: '修构建' });
    expect(result).toEqual({ ok: false, error: 'project-not-visible' });
    expect(h.created).toEqual([]);
  });
});

describe('session_send', () => {
  it('未派出且未点名的会话拒绝发送', async () => {
    const h = harness();
    const result = await call(h.handlers.session_send, { conversationId: 'c1', text: '继续' });
    expect(result).toEqual({ ok: false, error: 'not-operable' });
    expect(h.prompts).toEqual([]);
    expect(h.audits.map((entry) => entry.ok)).toEqual([false]);
  });

  it('目标有待审批时拒绝并提示需要用户', async () => {
    const h = harness({
      file: dispatchedFile(),
      statuses: { c1: { state: 'waiting', pendingAsks: 0, pendingApprovals: 1 } },
    });
    const result = await call(h.handlers.session_send, { conversationId: 'c1', text: '继续' });
    expect(result).toEqual({ ok: false, error: 'needs-user' });
    expect(h.prompts).toEqual([]);
  });

  it('运行中把消息追加到排队', async () => {
    const h = harness({
      file: dispatchedFile(),
      statuses: { c1: { state: 'running', pendingAsks: 0, pendingApprovals: 0 } },
    });
    const result = await call(h.handlers.session_send, { conversationId: 'c1', text: '继续' });
    expect(result).toEqual({ ok: true, result: { status: 'queued' } });
    expect(h.queued).toEqual([{ conversationId: 'c1', message: { id: 'id-1', text: '继续' } }]);
    expect(h.prompts).toEqual([]);
  });

  it('空闲且 worker 活着时直接发消息', async () => {
    const h = harness({ file: dispatchedFile() });
    const result = await call(h.handlers.session_send, { conversationId: 'c1', text: '继续' });
    expect(result).toEqual({ ok: true, result: { status: 'sent' } });
    expect(h.resumes).toEqual([]);
    expect(h.prompts).toEqual([{ conversationId: 'c1', text: '继续', deliveryId: 'id-1' }]);
  });

  it('worker 已释放时先恢复再发', async () => {
    const h = harness({ file: dispatchedFile() });
    h.ports.alive = () => false;
    const result = await call(h.handlers.session_send, { conversationId: 'c1', text: '继续' });
    expect(result).toEqual({ ok: true, result: { status: 'sent' } });
    expect(h.resumes).toEqual(['c1']);
    expect(h.prompts).toHaveLength(1);
  });

  it('恢复失败时不发消息', async () => {
    const h = harness({ file: dispatchedFile() });
    h.ports.alive = () => false;
    h.ports.resume = async () => ({ ok: false, error: 'no session file' });
    const result = await call(h.handlers.session_send, { conversationId: 'c1', text: '继续' });
    expect(result).toEqual({ ok: false, error: 'no session file' });
    expect(h.prompts).toEqual([]);
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

  it('未派出的会话拒绝停止', async () => {
    const h = harness();
    const result = await call(h.handlers.session_stop, { conversationId: 'c1' });
    expect(result).toEqual({ ok: false, error: 'not-operable' });
    expect(h.aborts).toEqual([]);
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
    expect(result).toEqual({ ok: true, result: { todoId: 'id-1' } });
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
    expect(result).toEqual({ ok: true, result: { todoId: 't1' } });
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
      prompt: '看构建',
      todoId: 't1',
    });
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
