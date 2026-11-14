import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app } from '@platform';
import { parseProfile } from '@shared/secretary/parse';
import {
  canOperate,
  dispatchDecision,
  transitionProposal,
  validateDispatch,
} from '@shared/secretary/policy';
import type { ConversationAuthority, ProjectAuthority } from '@shared/types/agent';
import {
  type DispatchDraft,
  NEEDS_YOU_RESULTS,
  type SecretaryAuditEntry,
  type SecretaryDispatchFile,
  type SecretaryProfile,
  type SecretaryProfileDraft,
  type SecretaryProposal,
  type SecretarySkillDraft,
  type SecretaryState,
  type SecretaryTodo,
  type SecretaryTodoMutate,
  type SecretaryToolDraft,
} from '@shared/types/secretary';
import { appendAudit } from './audit';
import { type SecretarySessionStatus, visibleProjects } from './readers';
import { buildBoard, proposalUpdate } from './results';
import type { MainSessionRequest, MainSessionResult } from './sessionFactory';
import { SecretaryStore } from './store';
import type { SecretaryOpContext, SecretaryOpHandler, SecretaryOpResult } from './tools';

type MaybePromise<T> = T | Promise<T>;

/** Main 侧的写数据源；测试注入假实现，生产走文件末尾的 secretaryDispatchPorts */
export interface SecretaryDispatchPorts {
  /** null = 未完成初次设置，按 parseProfile({}) 的默认档案处理 */
  profile(): MaybePromise<SecretaryProfile | null>;
  persona(): MaybePromise<string>;
  dispatchFile(): SecretaryDispatchFile;
  saveDispatch(file: SecretaryDispatchFile): void;
  todos(): MaybePromise<SecretaryTodo[]>;
  saveTodos(todos: SecretaryTodo[]): void;
  audit(entry: SecretaryAuditEntry): void;
  projects(): MaybePromise<readonly ProjectAuthority[]>;
  conversations(): MaybePromise<readonly ConversationAuthority[]>;
  rows(): MaybePromise<Record<string, Record<string, unknown>>>;
  status(conversationId: string): MaybePromise<SecretarySessionStatus>;
  createSession(request: MainSessionRequest): Promise<MainSessionResult>;
  prompt(
    conversationId: string,
    text: string,
    deliveryId: string
  ): MaybePromise<{ ok: boolean; error?: string }>;
  /** 恢复被释放的 worker */
  resume(conversationId: string): Promise<{ ok: boolean; error?: string }>;
  alive(conversationId: string): MaybePromise<boolean>;
  abort(conversationId: string): MaybePromise<void>;
  /** 追加排队消息；行不存在时返回 false */
  appendQueued(
    conversationId: string,
    message: { id: string; text: string }
  ): MaybePromise<boolean>;
  /** 有目标的会话被停止时置为暂停 */
  pauseGoal(conversationId: string): MaybePromise<void>;
  /** 确认 profile 提案：交给档案服务走同一套保存与副作用 */
  applyProfile(
    draft: SecretaryProfileDraft,
    secretaryConversationId: string | null
  ): Promise<{ ok: boolean; error?: string }>;
  /** 确认 skill 提案：交给 skill 服务写盘、审计并释放会话 */
  applySkill(
    draft: SecretarySkillDraft,
    secretaryConversationId: string | null
  ): Promise<{ ok: boolean; error?: string }>;
  /** 确认工具提案：交给工具服务写盘、审计并释放会话 */
  applyTool(
    draft: SecretaryToolDraft,
    secretaryConversationId: string | null
  ): Promise<{ ok: boolean; error?: string }>;
  newId(): string;
  now(): number;
}

const DISPATCH_OPS = [
  'session_create',
  'session_send',
  'session_stop',
  'todo_item_add',
  'todo_item_update',
  'todo_item_dispatch',
] as const;

export type SecretaryDispatchHandlers = Record<(typeof DISPATCH_OPS)[number], SecretaryOpHandler>;

const invalidArguments: SecretaryOpResult = { ok: false, error: 'invalid arguments' };

/** 工作台推送由 IPC 层注册，避免本模块静态依赖 electron 与 agent */
let stateListener: (() => void) | null = null;

export function setSecretaryStateListener(listener: (() => void) | null): void {
  stateListener = listener;
}

export function notifySecretaryChanged(): void {
  try {
    stateListener?.();
  } catch {
    // 推送失败不影响写操作
  }
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function modelParam(value: unknown): DispatchDraft['model'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const model = value as Record<string, unknown>;
  const providerId = stringParam(model, 'providerId');
  const modelId = stringParam(model, 'modelId');
  return providerId && modelId ? { providerId, modelId } : undefined;
}

function defaultProfile(): SecretaryProfile {
  const parsed = parseProfile({});
  if (!parsed) throw new Error('secretary default profile');
  return parsed;
}

async function profileOf(ports: SecretaryDispatchPorts): Promise<SecretaryProfile> {
  return (await ports.profile()) ?? defaultProfile();
}

function runningCount(file: SecretaryDispatchFile): number {
  return Object.values(file.dispatched).filter((record) => record.lastState === 'running').length;
}

async function dispatchContext(
  ports: SecretaryDispatchPorts,
  profile: SecretaryProfile,
  projectId: string
): Promise<Parameters<typeof validateDispatch>[1]> {
  const projects = await ports.projects();
  const file = ports.dispatchFile();
  return {
    project: projects.find((candidate) => candidate.projectId === projectId),
    visible: visibleProjects(projects, profile).some(
      (candidate) => candidate.projectId === projectId
    ),
    running: runningCount(file),
    max: profile.maxRunningDispatches,
    worktreeMode: profile.dispatchWorktree,
  };
}

function draftFromParams(params: Record<string, unknown>): DispatchDraft | null {
  const projectId = stringParam(params, 'projectId');
  const prompt = stringParam(params, 'prompt');
  if (!projectId || !prompt) return null;
  const draft: DispatchDraft = { projectId, prompt, worktree: params.worktree === true };
  const title = stringParam(params, 'title');
  if (title) draft.title = title;
  const goal = stringParam(params, 'goal');
  if (goal) draft.goal = goal;
  const model = modelParam(params.model);
  if (model) draft.model = model;
  const todoId = stringParam(params, 'todoId');
  if (todoId) draft.todoId = todoId;
  return draft;
}

type DispatchOutcome =
  | { kind: 'proposal'; proposalId: string }
  | { kind: 'created'; conversationId: string }
  | { kind: 'failed'; error: string };

async function saveProposal(
  ports: SecretaryDispatchPorts,
  secretaryConversationId: string,
  draft: DispatchDraft
): Promise<string> {
  const now = ports.now();
  const id = ports.newId();
  const proposal: SecretaryProposal = {
    id,
    secretaryConversationId,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    kind: 'dispatch',
    draft,
  };
  const file = ports.dispatchFile();
  file.proposals[id] = proposal;
  ports.saveDispatch(file);
  notifySecretaryChanged();
  return id;
}

async function executeDispatch(
  ports: SecretaryDispatchPorts,
  draft: DispatchDraft,
  secretaryConversationId: string
): Promise<MainSessionResult> {
  const created = await ports.createSession({
    projectId: draft.projectId,
    prompt: draft.prompt,
    worktree: draft.worktree,
    ...(draft.title ? { title: draft.title } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.goal ? { goal: draft.goal } : {}),
    secretaryOrigin: { secretaryConversationId },
  });
  if (!created.ok) return created;
  const now = ports.now();
  const file = ports.dispatchFile();
  file.dispatched[created.conversationId] = {
    conversationId: created.conversationId,
    projectId: draft.projectId,
    secretaryConversationId,
    createdAt: now,
    turn: 0,
    lastState: 'running',
    lastEventAt: now,
    ...(draft.todoId ? { todoId: draft.todoId } : {}),
    ...(draft.goal ? { goal: draft.goal } : {}),
  };
  ports.saveDispatch(file);
  notifySecretaryChanged();
  return created;
}

async function dispatchDraft(
  ports: SecretaryDispatchPorts,
  secretaryConversationId: string,
  draft: DispatchDraft
): Promise<DispatchOutcome> {
  const profile = await profileOf(ports);
  const wanted: DispatchDraft =
    profile.dispatchModel.mode === 'fixed'
      ? { ...draft, model: profile.dispatchModel.model }
      : draft;
  const validated = validateDispatch(
    wanted,
    await dispatchContext(ports, profile, wanted.projectId)
  );
  if (!validated.ok) return { kind: 'failed', error: validated.error };
  if (dispatchDecision(profile, wanted.projectId) === 'confirm') {
    return {
      kind: 'proposal',
      proposalId: await saveProposal(ports, secretaryConversationId, validated.draft),
    };
  }
  const created = await executeDispatch(ports, validated.draft, secretaryConversationId);
  return created.ok
    ? { kind: 'created', conversationId: created.conversationId }
    : { kind: 'failed', error: created.error };
}

function auditFailure(
  ports: SecretaryDispatchPorts,
  ctx: SecretaryOpContext,
  op: string,
  error: string,
  targetId?: string
): SecretaryOpResult {
  ports.audit({
    at: ports.now(),
    secretaryConversationId: ctx.secretaryConversationId,
    op,
    ...(targetId ? { targetId } : {}),
    ok: false,
    detail: error,
  });
  return { ok: false, error };
}

function outcomeResult(
  ports: SecretaryDispatchPorts,
  ctx: SecretaryOpContext,
  op: string,
  outcome: DispatchOutcome,
  targetId: string
): SecretaryOpResult {
  if (outcome.kind === 'failed') return auditFailure(ports, ctx, op, outcome.error, targetId);
  const at = ports.now();
  if (outcome.kind === 'proposal') {
    ports.audit({
      at,
      secretaryConversationId: ctx.secretaryConversationId,
      op,
      targetId: outcome.proposalId,
      ok: true,
      detail: 'awaiting_confirmation',
    });
    return {
      ok: true,
      result: { status: 'awaiting_confirmation', proposalId: outcome.proposalId },
    };
  }
  ports.audit({
    at,
    secretaryConversationId: ctx.secretaryConversationId,
    op,
    targetId: outcome.conversationId,
    ok: true,
    detail: 'created',
  });
  return { ok: true, result: { status: 'created', conversationId: outcome.conversationId } };
}

async function targetConversation(
  ports: SecretaryDispatchPorts,
  conversationId: string
): Promise<ConversationAuthority | undefined> {
  const conversation = (await ports.conversations()).find(
    (candidate) => candidate.conversationId === conversationId
  );
  if (conversation?.kind !== 'root' || conversation.bot) return undefined;
  return conversation;
}

async function latestSecretaryConversation(ports: SecretaryDispatchPorts): Promise<string | null> {
  const projects = await ports.projects();
  const secretaryProjects = new Set(
    projects.filter((project) => project.kind === 'secretary').map((project) => project.projectId)
  );
  if (secretaryProjects.size === 0) return null;
  const rows = await ports.rows();
  let latest: { id: string; at: number } | null = null;
  for (const conversation of await ports.conversations()) {
    if (conversation.kind !== 'root' || !secretaryProjects.has(conversation.projectId)) continue;
    const row = rows[conversation.conversationId];
    const at = typeof row?.lastActiveAt === 'number' ? row.lastActiveAt : 0;
    if (!latest || at > latest.at) latest = { id: conversation.conversationId, at };
  }
  return latest?.id ?? null;
}

export function createSecretaryDispatchHandlers(
  ports: SecretaryDispatchPorts
): SecretaryDispatchHandlers {
  const handlers: SecretaryDispatchHandlers = {
    async session_create(params, ctx) {
      const draft = draftFromParams(params);
      if (!draft || !ctx.secretaryConversationId) return invalidArguments;
      const outcome = await dispatchDraft(ports, ctx.secretaryConversationId, draft);
      return outcomeResult(ports, ctx, 'session_create', outcome, draft.projectId);
    },

    async session_send(params, ctx) {
      const conversationId = stringParam(params, 'conversationId');
      const text = stringParam(params, 'text');
      if (!conversationId || !text) return invalidArguments;
      const file = ports.dispatchFile();
      if (!canOperate(file, conversationId)) {
        return auditFailure(ports, ctx, 'session_send', 'not-operable', conversationId);
      }
      const conversation = await targetConversation(ports, conversationId);
      if (!conversation) {
        return auditFailure(ports, ctx, 'session_send', 'not-found', conversationId);
      }
      const profile = await profileOf(ports);
      const visible = visibleProjects(await ports.projects(), profile).some(
        (project) => project.projectId === conversation.projectId
      );
      if (!visible) {
        return auditFailure(ports, ctx, 'session_send', 'not-visible', conversationId);
      }
      const status = await ports.status(conversationId);
      // 秘书不能替用户回答提问或审批工具调用
      if (status.pendingAsks + status.pendingApprovals > 0) {
        return auditFailure(ports, ctx, 'session_send', 'needs-user', conversationId);
      }
      if (status.state === 'running') {
        if (!(await ports.appendQueued(conversationId, { id: ports.newId(), text }))) {
          return auditFailure(ports, ctx, 'session_send', 'not-found', conversationId);
        }
        ports.audit({
          at: ports.now(),
          secretaryConversationId: ctx.secretaryConversationId,
          op: 'session_send',
          targetId: conversationId,
          ok: true,
          detail: 'queued',
        });
        notifySecretaryChanged();
        return { ok: true, result: { status: 'queued' } };
      }
      if (!(await ports.alive(conversationId))) {
        const resumed = await ports.resume(conversationId);
        if (!resumed.ok) {
          return auditFailure(
            ports,
            ctx,
            'session_send',
            resumed.error ?? 'resume-failed',
            conversationId
          );
        }
      }
      const prompted = await ports.prompt(conversationId, text, ports.newId());
      if (!prompted.ok) {
        return auditFailure(
          ports,
          ctx,
          'session_send',
          prompted.error ?? 'prompt-failed',
          conversationId
        );
      }
      ports.audit({
        at: ports.now(),
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'session_send',
        targetId: conversationId,
        ok: true,
        detail: 'sent',
      });
      return { ok: true, result: { status: 'sent' } };
    },

    async session_stop(params, ctx) {
      const conversationId = stringParam(params, 'conversationId');
      if (!conversationId) return invalidArguments;
      const file = ports.dispatchFile();
      if (!canOperate(file, conversationId)) {
        return auditFailure(ports, ctx, 'session_stop', 'not-operable', conversationId);
      }
      await ports.abort(conversationId);
      if (file.dispatched[conversationId]?.goal) await ports.pauseGoal(conversationId);
      ports.audit({
        at: ports.now(),
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'session_stop',
        targetId: conversationId,
        ok: true,
        detail: 'stopped',
      });
      notifySecretaryChanged();
      return { ok: true, result: { status: 'stopped' } };
    },

    async todo_item_add(params, ctx) {
      const text = stringParam(params, 'text');
      if (!text) return invalidArguments;
      const now = ports.now();
      const dueAt =
        typeof params.dueAt === 'number' && Number.isFinite(params.dueAt)
          ? params.dueAt
          : undefined;
      const projectId = stringParam(params, 'projectId');
      const todo: SecretaryTodo = {
        id: ports.newId(),
        text,
        createdAt: now,
        updatedAt: now,
        ...(dueAt !== undefined ? { dueAt } : {}),
        ...(projectId ? { projectId } : {}),
      };
      const todos = [...(await ports.todos()), todo];
      ports.saveTodos(todos);
      ports.audit({
        at: now,
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'todo_item_add',
        targetId: todo.id,
        ok: true,
      });
      notifySecretaryChanged();
      return { ok: true, result: { todoId: todo.id } };
    },

    async todo_item_update(params, ctx) {
      const todoId = stringParam(params, 'todoId');
      if (!todoId) return invalidArguments;
      const todos = await ports.todos();
      const todo = todos.find((candidate) => candidate.id === todoId);
      if (!todo) return auditFailure(ports, ctx, 'todo_item_update', 'not-found', todoId);
      const now = ports.now();
      const text = stringParam(params, 'text');
      const done = typeof params.done === 'boolean' ? params.done : undefined;
      const dueAt =
        params.dueAt === null
          ? null
          : typeof params.dueAt === 'number' && Number.isFinite(params.dueAt)
            ? params.dueAt
            : undefined;
      const next: SecretaryTodo = {
        ...todo,
        updatedAt: now,
        ...(text ? { text } : {}),
        ...(dueAt === null ? { dueAt: undefined } : dueAt !== undefined ? { dueAt } : {}),
        ...(done === undefined ? {} : { doneAt: done ? (todo.doneAt ?? now) : undefined }),
      };
      ports.saveTodos(todos.map((candidate) => (candidate.id === todoId ? next : candidate)));
      ports.audit({
        at: now,
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'todo_item_update',
        targetId: todoId,
        ok: true,
      });
      notifySecretaryChanged();
      return { ok: true, result: { todoId } };
    },

    async todo_item_dispatch(params, ctx) {
      const todoId = stringParam(params, 'todoId');
      if (!todoId || !ctx.secretaryConversationId) return invalidArguments;
      const todos = await ports.todos();
      const todo = todos.find((candidate) => candidate.id === todoId);
      if (!todo) return auditFailure(ports, ctx, 'todo_item_dispatch', 'not-found', todoId);
      const projectId = stringParam(params, 'projectId') ?? todo.projectId;
      if (!projectId) {
        return auditFailure(ports, ctx, 'todo_item_dispatch', 'project-required', todoId);
      }
      const draft: DispatchDraft = {
        projectId,
        prompt: stringParam(params, 'prompt') ?? todo.text,
        worktree: params.worktree === true,
        todoId,
      };
      const outcome = await dispatchDraft(ports, ctx.secretaryConversationId, draft);
      const result = outcomeResult(ports, ctx, 'todo_item_dispatch', outcome, todoId);
      if (outcome.kind === 'created') {
        ports.saveTodos(
          todos.map((candidate) =>
            candidate.id === todoId
              ? { ...candidate, conversationId: outcome.conversationId }
              : candidate
          )
        );
      }
      return result;
    },
  };
  return handlers;
}

export type ResolveProposalResult =
  | { ok: true; proposal: SecretaryProposal }
  | { ok: false; error: string };

async function finishProposal(
  ports: SecretaryDispatchPorts,
  proposalId: string,
  outcome: { ok: true; conversationId?: string } | { ok: false; error: string }
): Promise<ResolveProposalResult> {
  const file = ports.dispatchFile();
  const current = file.proposals[proposalId];
  if (!current) return { ok: false, error: 'not-found' };
  const now = ports.now();
  const transitioned = transitionProposal(current, { type: 'finish', ...outcome }, now);
  if (!transitioned.changed) return { ok: false, error: 'not-executing' };
  file.proposals[proposalId] = transitioned.proposal;
  file.outbox.push(proposalUpdate(transitioned.proposal, now));
  ports.saveDispatch(file);
  ports.audit({
    at: now,
    secretaryConversationId: current.secretaryConversationId,
    op: 'proposal_confirm',
    targetId: proposalId,
    ok: outcome.ok,
    detail: outcome.ok ? 'succeeded' : (outcome.error ?? 'failed'),
  });
  notifySecretaryChanged();
  return { ok: true, proposal: transitioned.proposal };
}

function mergeDraft(
  draft: DispatchDraft,
  edits: Partial<DispatchDraft> | undefined
): DispatchDraft {
  if (!edits) return draft;
  const merged: DispatchDraft = { ...draft };
  if (typeof edits.projectId === 'string' && edits.projectId.trim())
    merged.projectId = edits.projectId.trim();
  if (typeof edits.prompt === 'string' && edits.prompt.trim()) merged.prompt = edits.prompt.trim();
  if (typeof edits.title === 'string') merged.title = edits.title.trim() || undefined;
  if (typeof edits.goal === 'string') merged.goal = edits.goal.trim() || undefined;
  if (typeof edits.worktree === 'boolean') merged.worktree = edits.worktree;
  return merged;
}

/**
 * 确认或拒绝提案。落盘状态转移与重新读取之间不留 await：
 * 并发的第二次确认读到 executing，不会重复建会话。
 */
export async function resolveProposal(
  ports: SecretaryDispatchPorts,
  proposalId: string,
  action: 'confirm' | 'reject',
  edits?: Partial<DispatchDraft>,
  /** 卡片上就地改过的档案草案：整份替换，确认时按同一套收窄写入 */
  profileDraft?: unknown
): Promise<ResolveProposalResult> {
  const proposal = ports.dispatchFile().proposals[proposalId];
  if (!proposal) return { ok: false, error: 'not-found' };
  const file = ports.dispatchFile();
  const current = file.proposals[proposalId];
  if (!current) return { ok: false, error: 'not-found' };
  const now = ports.now();
  const transitioned = transitionProposal(
    current,
    action === 'confirm' ? { type: 'confirm' } : { type: 'reject' },
    now
  );
  if (!transitioned.changed) return { ok: false, error: 'not-pending' };

  file.proposals[proposalId] = transitioned.proposal;
  if (action === 'reject') file.outbox.push(proposalUpdate(transitioned.proposal, now));
  ports.saveDispatch(file);
  ports.audit({
    at: now,
    secretaryConversationId: proposal.secretaryConversationId,
    op: action === 'confirm' ? 'proposal_confirm' : 'proposal_reject',
    targetId: proposalId,
    ok: true,
    ...(action === 'confirm' ? { detail: 'accepted' } : {}),
  });
  if (action === 'reject') {
    notifySecretaryChanged();
    return { ok: true, proposal: transitioned.proposal };
  }
  // 档案提案走同一套状态机，确认后才写入；拒绝不写
  if (transitioned.proposal.kind === 'profile') {
    const applied = await ports.applyProfile(
      (profileDraft ?? transitioned.proposal.draft) as SecretaryProfileDraft,
      proposal.secretaryConversationId
    );
    return finishProposal(
      ports,
      proposalId,
      applied.ok ? { ok: true } : { ok: false, error: applied.error ?? 'profile-save-failed' }
    );
  }
  if (transitioned.proposal.kind === 'skill') {
    const applied = await ports.applySkill(
      transitioned.proposal.draft,
      proposal.secretaryConversationId
    );
    return finishProposal(
      ports,
      proposalId,
      applied.ok ? { ok: true } : { ok: false, error: applied.error ?? 'skill-save-failed' }
    );
  }
  if (transitioned.proposal.kind === 'tool') {
    const applied = await ports.applyTool(
      transitioned.proposal.draft,
      proposal.secretaryConversationId
    );
    return finishProposal(
      ports,
      proposalId,
      applied.ok ? { ok: true } : { ok: false, error: applied.error ?? 'tool-save-failed' }
    );
  }

  const profile = await profileOf(ports);
  const draft = mergeDraft(transitioned.proposal.draft, edits);
  const validated = validateDispatch(draft, await dispatchContext(ports, profile, draft.projectId));
  if (!validated.ok)
    return finishProposal(ports, proposalId, { ok: false, error: validated.error });
  const created = await executeDispatch(ports, validated.draft, proposal.secretaryConversationId);
  return finishProposal(
    ports,
    proposalId,
    created.ok
      ? { ok: true, conversationId: created.conversationId }
      : { ok: false, error: created.error }
  );
}

export type TodoMutateResult = { ok: true; todoId: string } | { ok: false; error: string };

export type DismissResultResult = { ok: true } | { ok: false; error: string };

/** 用户点过「知道了」：只标记这条结果，会话本身不动；新结果整体替换 lastResult，标记自然失效 */
export function dismissResult(
  ports: SecretaryDispatchPorts,
  conversationId: string
): DismissResultResult {
  const file = ports.dispatchFile();
  const record = file.dispatched[conversationId];
  if (!record) return { ok: false, error: 'not-found' };
  const result = record.lastResult;
  if (!result || !NEEDS_YOU_RESULTS.has(result.kind))
    return { ok: false, error: 'not-dismissible' };
  record.lastResult = { ...result, dismissed: true };
  ports.saveDispatch(file);
  ports.audit({
    at: ports.now(),
    secretaryConversationId: record.secretaryConversationId,
    op: 'result_dismiss',
    targetId: conversationId,
    ok: true,
  });
  notifySecretaryChanged();
  return { ok: true };
}

/** 界面直接编辑待办；派出是用户亲手点的，不再走自主度确认 */
export async function mutateTodo(
  ports: SecretaryDispatchPorts,
  request: SecretaryTodoMutate
): Promise<TodoMutateResult> {
  const handlers = createSecretaryDispatchHandlers(ports);
  const ctx = { secretaryConversationId: null };
  const now = ports.now();
  if (request.action === 'add') {
    const result = await handlers.todo_item_add(
      {
        text: request.text,
        ...(request.dueAt !== undefined ? { dueAt: request.dueAt } : {}),
        ...(request.projectId ? { projectId: request.projectId } : {}),
      },
      ctx
    );
    return result.ok
      ? { ok: true, todoId: String((result.result as { todoId: string }).todoId) }
      : result;
  }
  if (request.action === 'update') {
    const result = await handlers.todo_item_update(
      {
        todoId: request.todoId,
        ...(request.text !== undefined ? { text: request.text } : {}),
        ...(request.dueAt !== undefined ? { dueAt: request.dueAt } : {}),
        ...(request.done !== undefined ? { done: request.done } : {}),
      },
      ctx
    );
    return result.ok ? { ok: true, todoId: request.todoId } : result;
  }
  if (request.action === 'remove') {
    const todos = await ports.todos();
    if (!todos.some((todo) => todo.id === request.todoId)) return { ok: false, error: 'not-found' };
    ports.saveTodos(todos.filter((todo) => todo.id !== request.todoId));
    ports.audit({
      at: now,
      secretaryConversationId: null,
      op: 'todo_remove',
      targetId: request.todoId,
      ok: true,
    });
    notifySecretaryChanged();
    return { ok: true, todoId: request.todoId };
  }
  const secretaryConversationId = await latestSecretaryConversation(ports);
  if (!secretaryConversationId) return { ok: false, error: 'no-secretary-conversation' };
  const result = await handlers.todo_item_dispatch(
    {
      todoId: request.todoId,
      ...(request.projectId ? { projectId: request.projectId } : {}),
      ...(request.prompt ? { prompt: request.prompt } : {}),
    },
    { secretaryConversationId }
  );
  return result.ok ? { ok: true, todoId: request.todoId } : result;
}

export interface SecretaryStatePorts {
  profile(): MaybePromise<SecretaryProfile | null>;
  persona(): MaybePromise<string>;
  dispatchFile(): SecretaryDispatchFile;
  todos(): MaybePromise<SecretaryTodo[]>;
  rows(): MaybePromise<Record<string, Record<string, unknown>>>;
  projects(): MaybePromise<readonly ProjectAuthority[]>;
  status(conversationId: string): MaybePromise<SecretarySessionStatus>;
}

export async function buildSecretaryState(
  ports: SecretaryStatePorts,
  extra: { enabled: boolean; projectId: string | null }
): Promise<SecretaryState> {
  const file = ports.dispatchFile();
  const rows = await ports.rows();
  const projects = await ports.projects();
  const statuses: Record<string, SecretarySessionStatus> = {};
  for (const record of Object.values(file.dispatched)) {
    if (!rows[record.conversationId]) continue;
    statuses[record.conversationId] = await ports.status(record.conversationId);
  }

  return {
    enabled: extra.enabled,
    projectId: extra.projectId,
    profile: await ports.profile(),
    persona: await ports.persona(),
    board: buildBoard(file, { rows, statuses, projects, todos: await ports.todos() }),
    proposals: file.proposals,
  };
}

function secretaryDir(): string {
  return path.join(app.getPath('userData'), 'secretary');
}

/** 生产端口全部经动态 import 取 Main 的既有函数：本模块被 tools.ts 静态依赖，静态反向依赖会成环 */
export const secretaryDispatchPorts: SecretaryDispatchPorts = {
  profile: () => store().profile(),
  persona: () => store().readPersona(),
  dispatchFile: () => store().dispatch(),
  saveDispatch: (file) => {
    store().saveDispatch(file);
  },
  todos: () => store().todos(),
  saveTodos: (todos) => {
    store().saveTodos(todos);
  },
  audit: (entry) => appendAudit(secretaryDir(), entry),
  projects: async () =>
    (await import('../../ipc/agent')).getSourceAuthorityRegistry()?.projection().projects ?? [],
  conversations: async () =>
    (await import('../../ipc/agent')).getSourceAuthorityRegistry()?.projection().conversations ??
    [],
  rows: async () => (await import('../../ipc/settings')).readPersistedConversations(),
  status: async (conversationId) =>
    (await import('../../ipc/agent')).observedSessionStatus(conversationId),
  createSession: async (request) =>
    (await import('../../ipc/secretary')).createSessionViaMain(request),
  prompt: async (conversationId, text, deliveryId) =>
    (await import('../../ipc/agent')).promptRootFromMain(conversationId, text, deliveryId),
  resume: async (conversationId) =>
    (await import('../../ipc/agent')).resumeRootFromMain(conversationId),
  alive: async (conversationId) =>
    (await import('../../ipc/agent')).isRootSessionAlive(conversationId),
  abort: async (conversationId) =>
    (await import('../../ipc/agent')).abortRootFromMain(conversationId),
  appendQueued: async (conversationId, message) => {
    const { patchConversationsState } = await import('../../ipc/settings');
    let found = false;
    patchConversationsState((state) => {
      const row = state.conversations[conversationId];
      if (!row) return;
      found = true;
      const queued = Array.isArray(row.queuedMessages) ? row.queuedMessages : [];
      state.conversations[conversationId] = { ...row, queuedMessages: [...queued, message] };
    });
    return found;
  },
  pauseGoal: async (conversationId) => {
    const { patchConversationsState } = await import('../../ipc/settings');
    patchConversationsState((state) => {
      const row = state.conversations[conversationId];
      if (!row) return;
      const goal = row.goal;
      if (!goal || typeof goal !== 'object') return;
      state.conversations[conversationId] = {
        ...row,
        goal: { ...(goal as Record<string, unknown>), status: 'paused' },
      };
    });
  },
  applyProfile: async (draft, secretaryConversationId) => {
    const { secretaryProfile } = await import('./profile');
    const result = await secretaryProfile.save(draft, secretaryConversationId);
    return result.ok ? { ok: true } : result;
  },
  applySkill: async (draft, secretaryConversationId) => {
    const { secretarySkill } = await import('./skills');
    const result = await secretarySkill.save(draft, secretaryConversationId);
    return result.ok ? { ok: true } : result;
  },
  applyTool: async (draft, secretaryConversationId) => {
    const { secretaryTool } = await import('./customTools');
    const result = await secretaryTool.save(draft, secretaryConversationId);
    return result.ok ? { ok: true } : result;
  },
  newId: () => randomUUID(),
  now: () => Date.now(),
};

function store(): SecretaryStore {
  return new SecretaryStore(secretaryDir());
}

export const secretaryDispatchHandlers = createSecretaryDispatchHandlers(secretaryDispatchPorts);
