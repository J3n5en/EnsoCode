import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app } from '@platform';
import { projectNameFromPath } from '@shared/projectName';
import { type FeedPage, type FeedQuery, feedEvents, pageFeed } from '@shared/secretary/feed';
import { parseProfile } from '@shared/secretary/parse';
import {
  canOperate,
  dispatchDecision,
  type TakeoverRefusal,
  takeoverRefusal,
  transitionProposal,
  validateDispatch,
} from '@shared/secretary/policy';
import {
  SECRETARY_ID_MAX,
  SECRETARY_SEND_MODES,
  SECRETARY_SESSION_MESSAGE_MAX,
  type SecretarySendMode,
} from '@shared/secretary/tools';
import { wrapUntrusted } from '@shared/secretary/transcript';
import type { ConversationAuthority, ProjectAuthority } from '@shared/types/agent';
import {
  type DispatchDraft,
  NEEDS_YOU_RESULTS,
  type SecretaryAuditEntry,
  type SecretaryBoard,
  type SecretaryDispatchFile,
  type SecretaryProfile,
  type SecretaryProfileDraft,
  type SecretaryProposal,
  type SecretarySkillDraft,
  type SecretaryState,
  type SecretaryTakeoverView,
  type SecretaryTodo,
  type SecretaryTodoMutate,
  type SecretaryToolDraft,
  type TakeoverVia,
} from '@shared/types/secretary';
import { redactSecrets } from '../memory/distill';
import { appendAudit } from './audit';
import { todoDispatchPrompt } from './dispatchBrief';
import { type SecretarySessionStatus, visibleProjects } from './readers';
import {
  buildBoard,
  countsAsRunning,
  linkedTodoSession,
  proposalUpdate,
  takeoverViews,
} from './results';
import type { MainSessionRequest, MainSessionResult } from './sessionFactory';
import { SecretaryStore } from './store';
import {
  linkTodo,
  markTodoProblem,
  reopenTodo,
  resumeLinkedTodo,
  TODO_STATUSES,
  type TodoStatus,
  todoStatus,
} from './todoLifecycle';
import type { SecretaryOpContext, SecretaryOpHandler, SecretaryOpResult } from './tools';

type MaybePromise<T> = T | Promise<T>;

/** 秘书排进目标会话队列的消息：origin 标记来源，撤回与停止清队列只认自己排的 */
export interface SecretaryQueuedMessage {
  id: string;
  text: string;
  origin: 'secretary';
  /** 排队的秘书会话；撤回时要求与调用方一致 */
  by?: string;
  at: number;
}

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
  /** 插话：走用户自己的 steer 通道，在当前工具调用结束后投递 */
  steer(
    conversationId: string,
    text: string,
    deliveryId: string
  ): MaybePromise<{ ok: boolean; error?: string }>;
  /** 追加排队消息；行不存在时返回 false */
  appendQueued(conversationId: string, message: SecretaryQueuedMessage): MaybePromise<boolean>;
  /** 按 id 从队列里删消息，返回真正删掉的条数 */
  dropQueued(conversationId: string, messageIds: readonly string[]): MaybePromise<number>;
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
  /** 项目当前分支；不是 git 仓库或读失败时返回 null */
  branch(repoPath: string): MaybePromise<string | null>;
}

const DISPATCH_OPS = [
  'session_create',
  'session_send',
  'session_queue_list',
  'session_queue_cancel',
  'session_stop',
  'session_takeover_propose',
  'todo_list',
  'todo_item_add',
  'todo_item_update',
  'todo_item_dispatch',
] as const;

export type SecretaryDispatchHandlers = Record<(typeof DISPATCH_OPS)[number], SecretaryOpHandler>;

const invalidArguments: SecretaryOpResult = { ok: false, error: 'invalid arguments' };

const DENIALS = {
  'not-operable':
    'permission denied (not-operable): this session was not dispatched by the secretary and the user has neither referenced it nor handed it over. Ask the user, or call session_takeover_propose to request a takeover; it only takes effect after the user confirms.',
  'not-found':
    'not found: no root session with this id (archived, child and secretary sessions are excluded)',
  'not-visible':
    "permission denied (not-visible): the session's project is not in the secretary's visible projects",
  'needs-user':
    'refused (needs-user): the session is waiting for the user to answer a question or approve a tool call',
  'not-yours':
    'refused (not-yours): only messages you queued yourself can be withdrawn; this one was queued by the user or by another secretary',
} as const;

export const NOT_OPERABLE_ERROR = DENIALS['not-operable'];

type FieldsResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface SessionFields {
  conversationId: string;
  message: string;
  mode: SecretarySendMode;
  clearQueue: boolean;
}

/** 逐字段校验，失败时写明哪个字段、哪里不合法 */
function sessionFields(
  params: Record<string, unknown>,
  allowed: readonly string[]
): FieldsResult<SessionFields> {
  const invalid = (detail: string) => ({
    ok: false as const,
    error: `invalid arguments: ${detail}`,
  });
  const extra = Object.keys(params).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    return invalid(
      `unexpected field ${extra.map((key) => `"${key}"`).join(', ')}; allowed fields: ${allowed.join(', ')}`
    );
  }
  const text = (key: string, max: number): FieldsResult<string> => {
    const value = params[key];
    if (value === undefined) return invalid(`"${key}" is required`);
    if (typeof value !== 'string') return invalid(`"${key}" must be a string, got ${typeof value}`);
    const trimmed = value.trim();
    if (!trimmed) return invalid(`"${key}" must not be empty`);
    if (trimmed.length > max)
      return invalid(`"${key}" is ${trimmed.length} characters, max ${max}`);
    return { ok: true, value: trimmed };
  };
  const conversationId = text('conversationId', SECRETARY_ID_MAX);
  if (!conversationId.ok) return conversationId;
  const message = allowed.includes('message')
    ? text('message', SECRETARY_SESSION_MESSAGE_MAX)
    : ({ ok: true, value: '' } as const);
  if (!message.ok) return message;
  const mode = params.mode;
  if (mode !== undefined && !(SECRETARY_SEND_MODES as readonly unknown[]).includes(mode)) {
    return invalid(`"mode" must be one of ${SECRETARY_SEND_MODES.join(', ')}`);
  }
  const clearQueue = params.clearQueue;
  if (clearQueue !== undefined && typeof clearQueue !== 'boolean') {
    return invalid(`"clearQueue" must be a boolean, got ${typeof clearQueue}`);
  }
  return {
    ok: true,
    value: {
      conversationId: conversationId.value,
      message: message.value,
      mode: (mode as SecretarySendMode | undefined) ?? 'queue',
      clearQueue: clearQueue === true,
    },
  };
}

interface QueuedItem {
  id: string;
  text: string;
  at?: number;
}

/** 队列里秘书自己排的消息；others 是用户或别的秘书排的，只能看条数不能动 */
function secretaryQueued(
  row: Record<string, unknown> | undefined,
  ctx: SecretaryOpContext
): { mine: QueuedItem[]; others: number } {
  const queued = Array.isArray(row?.queuedMessages) ? row.queuedMessages : [];
  const mine: QueuedItem[] = [];
  let others = 0;
  for (const value of queued) {
    if (!value || typeof value !== 'object') continue;
    const item = value as {
      id?: unknown;
      text?: unknown;
      origin?: unknown;
      by?: unknown;
      at?: unknown;
    };
    if (typeof item.id !== 'string') continue;
    if (item.origin === 'secretary' && item.by === ctx.secretaryConversationId) {
      mine.push({
        id: item.id,
        text: typeof item.text === 'string' ? item.text : '',
        ...(typeof item.at === 'number' ? { at: item.at } : {}),
      });
    } else {
      others += 1;
    }
  }
  return { mine, others };
}

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

/** 派出上限只数秘书派出的会话。接管是用户交来的已有会话，不占这个名额 */
async function runningCount(
  ports: SecretaryDispatchPorts,
  file: SecretaryDispatchFile
): Promise<number> {
  const rows = await ports.rows();
  let count = 0;
  for (const record of Object.values(file.dispatched)) {
    if (record.takeover) continue;
    // 与顶栏、看板「进行中」同一个判定，三处数字必须一致
    if (
      countsAsRunning(
        record,
        rows[record.conversationId],
        await ports.status(record.conversationId)
      )
    )
      count += 1;
  }
  return count;
}

async function noteDispatchResumed(
  ports: SecretaryDispatchPorts,
  conversationId: string
): Promise<void> {
  const file = ports.dispatchFile();
  const record = file.dispatched[conversationId];
  if (!record) return;
  const now = ports.now();
  if (record.lastState !== 'running') record.stateSince = now;
  record.lastState = 'running';
  record.lastEventAt = now;
  ports.saveDispatch(file);
  const resumed = resumeLinkedTodo(await ports.todos(), conversationId, now);
  if (resumed.changed) ports.saveTodos(resumed.todos);
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
    running: await runningCount(ports, file),
    max: profile.maxRunningDispatches,
    worktreeMode: profile.dispatchWorktree,
  };
}

/** 待办文本的首个非空行就是它的标题 */
function todoTitle(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
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
  secretaryConversationId: string,
  profile: SecretaryProfile
): Promise<MainSessionResult> {
  const created = await ports.createSession({
    projectId: draft.projectId,
    prompt: draft.prompt,
    worktree: draft.worktree,
    ...(draft.title ? { title: draft.title } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.goal ? { goal: draft.goal } : {}),
    secretaryOrigin: { secretaryConversationId },
    // 只有新派出的会话套用这两个默认值；接管的是用户已有会话，一概不碰
    ...(profile.dispatchMuted ? { muted: true } : {}),
    ...(profile.dispatchUnattended ? { unattended: true } : {}),
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
    stateSince: now,
    ...(draft.todoId ? { todoId: draft.todoId } : {}),
    ...(draft.goal ? { goal: draft.goal } : {}),
  };
  ports.saveDispatch(file);
  if (draft.todoId) {
    const linked = linkTodo(await ports.todos(), draft.todoId, created.conversationId, ports.now());
    if (linked.changed) ports.saveTodos(linked.todos);
  }
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
  const created = await executeDispatch(ports, validated.draft, secretaryConversationId, profile);
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

/** 审计记短码，返回给模型的是可读的拒绝原因 */
function deny(
  ports: SecretaryDispatchPorts,
  ctx: SecretaryOpContext,
  op: string,
  code: keyof typeof DENIALS,
  targetId: string
): SecretaryOpResult {
  auditFailure(ports, ctx, op, code, targetId);
  return { ok: false, error: DENIALS[code] };
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

type TakeoverCheck =
  | { ok: true; conversation: ConversationAuthority; row: Record<string, unknown> }
  | { ok: false; error: TakeoverRefusal };

async function checkTakeover(
  ports: SecretaryDispatchPorts,
  conversationId: string
): Promise<TakeoverCheck> {
  const conversation = (await ports.conversations()).find(
    (candidate) => candidate.conversationId === conversationId
  );
  const projects = await ports.projects();
  const project = conversation
    ? projects.find((candidate) => candidate.projectId === conversation.projectId)
    : undefined;
  const row = (await ports.rows())[conversationId];
  const profile = await profileOf(ports);
  const visible =
    project !== undefined &&
    visibleProjects(projects, profile).some(
      (candidate) => candidate.projectId === project.projectId
    );
  const refusal = takeoverRefusal(ports.dispatchFile(), {
    conversationId,
    conversation,
    project,
    row,
    visible,
  });
  if (refusal || !conversation || !row) return { ok: false, error: refusal ?? 'not-found' };
  return { ok: true, conversation, row };
}

export type TakeoverResult = { ok: true } | { ok: false; error: string };

/**
 * 授权接管：只由用户亲手触发（确认卡或会话界面），秘书的工具调用到不了这里。
 * 推送绑到确认卡所属的秘书会话；界面直接授权时绑最近活跃的秘书会话。
 */
export async function grantTakeover(
  ports: SecretaryDispatchPorts,
  conversationId: string,
  via: TakeoverVia,
  secretaryConversationId: string | null
): Promise<TakeoverResult> {
  const fail = (error: string, actor: string | null = secretaryConversationId) => {
    ports.audit({
      at: ports.now(),
      secretaryConversationId: actor,
      op: 'takeover_grant',
      targetId: conversationId,
      ok: false,
      detail: `${via}: ${error}`,
    });
    return { ok: false as const, error };
  };
  const checked = await checkTakeover(ports, conversationId);
  if (!checked.ok) return fail(checked.error);
  const owner = secretaryConversationId ?? (await latestSecretaryConversation(ports));
  if (!owner) return fail('no-secretary-conversation');
  const status = await ports.status(conversationId);
  // 读改写之间不留 await：并发的两次授权只有一次写进去
  const file = ports.dispatchFile();
  if (Object.hasOwn(file.dispatched, conversationId)) return fail('already-managed', owner);
  const now = ports.now();
  file.dispatched[conversationId] = {
    conversationId,
    projectId: checked.conversation.projectId,
    secretaryConversationId: owner,
    createdAt: now,
    turn: 0,
    lastState: status.state,
    lastEventAt: now,
    takeover: { grantedAt: now, via },
  };
  ports.saveDispatch(file);
  ports.audit({
    at: now,
    secretaryConversationId: owner,
    op: 'takeover_grant',
    targetId: conversationId,
    ok: true,
    detail: via,
  });
  notifySecretaryChanged();
  return { ok: true };
}

/** 撤销接管：只认接管来的记录，派出会话撤不掉；点名授权一并收回，未投递的结果不再推给秘书 */
export function revokeTakeover(
  ports: SecretaryDispatchPorts,
  conversationId: string,
  from: 'session' | 'settings'
): TakeoverResult {
  const file = ports.dispatchFile();
  const record = file.dispatched[conversationId];
  if (!record?.takeover) {
    ports.audit({
      at: ports.now(),
      secretaryConversationId: null,
      op: 'takeover_revoke',
      targetId: conversationId,
      ok: false,
      detail: `${from}: not-found`,
    });
    return { ok: false, error: 'not-found' };
  }
  delete file.dispatched[conversationId];
  file.named = file.named.filter((id) => id !== conversationId);
  file.outbox = file.outbox.filter(
    (update) => !('conversationId' in update && update.conversationId === conversationId)
  );
  ports.saveDispatch(file);
  ports.audit({
    at: ports.now(),
    secretaryConversationId: record.secretaryConversationId,
    op: 'takeover_revoke',
    targetId: conversationId,
    ok: true,
    detail: from,
  });
  notifySecretaryChanged();
  return { ok: true };
}

export async function listTakeovers(
  ports: Pick<SecretaryDispatchPorts, 'dispatchFile' | 'rows' | 'projects'>
): Promise<SecretaryTakeoverView[]> {
  return takeoverViews(ports.dispatchFile(), await ports.rows(), await ports.projects());
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
      const fields = sessionFields(params, ['conversationId', 'message', 'mode']);
      if (!fields.ok) return fields;
      const { conversationId, message: text, mode } = fields.value;
      const file = ports.dispatchFile();
      if (!canOperate(file, conversationId)) {
        return deny(ports, ctx, 'session_send', 'not-operable', conversationId);
      }
      const conversation = await targetConversation(ports, conversationId);
      if (!conversation) {
        return deny(ports, ctx, 'session_send', 'not-found', conversationId);
      }
      const profile = await profileOf(ports);
      const visible = visibleProjects(await ports.projects(), profile).some(
        (project) => project.projectId === conversation.projectId
      );
      if (!visible) {
        return deny(ports, ctx, 'session_send', 'not-visible', conversationId);
      }
      const status = await ports.status(conversationId);
      // 秘书不能替用户回答提问或审批工具调用：两种模式都拒绝
      if (status.pendingAsks + status.pendingApprovals > 0) {
        return deny(ports, ctx, 'session_send', 'needs-user', conversationId);
      }
      if (status.state === 'running') {
        // 插话复用用户自己的 steer 通道：pi 在当前工具调用结束后读到它，不等整轮结束
        if (mode === 'steer') {
          const steered = await ports.steer(conversationId, text, ports.newId());
          if (!steered.ok) {
            return auditFailure(
              ports,
              ctx,
              'session_send',
              steered.error ?? 'steer-failed',
              conversationId
            );
          }
          await noteDispatchResumed(ports, conversationId);
          ports.audit({
            at: ports.now(),
            secretaryConversationId: ctx.secretaryConversationId,
            op: 'session_send',
            targetId: conversationId,
            ok: true,
            detail: 'steered',
          });
          notifySecretaryChanged();
          return { ok: true, result: { status: 'steered' } };
        }
        const queued = await ports.appendQueued(conversationId, {
          id: ports.newId(),
          text,
          origin: 'secretary',
          ...(ctx.secretaryConversationId ? { by: ctx.secretaryConversationId } : {}),
          at: ports.now(),
        });
        if (!queued) {
          return deny(ports, ctx, 'session_send', 'not-found', conversationId);
        }
        await noteDispatchResumed(ports, conversationId);
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
      await noteDispatchResumed(ports, conversationId);
      notifySecretaryChanged();
      return { ok: true, result: { status: 'sent' } };
    },

    async session_queue_list(params, ctx) {
      const fields = sessionFields(params, ['conversationId']);
      if (!fields.ok) return fields;
      const { conversationId } = fields.value;
      if (!canOperate(ports.dispatchFile(), conversationId)) {
        return deny(ports, ctx, 'session_queue_list', 'not-operable', conversationId);
      }
      const row = (await ports.rows())[conversationId];
      if (!row) return deny(ports, ctx, 'session_queue_list', 'not-found', conversationId);
      const { mine, others } = secretaryQueued(row, ctx);
      return { ok: true, result: { conversationId, queued: mine, others } };
    },

    async session_queue_cancel(params, ctx) {
      const fields = sessionFields(params, ['conversationId', 'messageId']);
      if (!fields.ok) return fields;
      const { conversationId } = fields.value;
      const messageId = stringParam(params, 'messageId');
      if (!messageId) return invalidArguments;
      if (!canOperate(ports.dispatchFile(), conversationId)) {
        return deny(ports, ctx, 'session_queue_cancel', 'not-operable', conversationId);
      }
      const row = (await ports.rows())[conversationId];
      if (!row) return deny(ports, ctx, 'session_queue_cancel', 'not-found', conversationId);
      const { mine } = secretaryQueued(row, ctx);
      if (!mine.some((item) => item.id === messageId)) {
        // 用户排的、别的秘书排的、已经投递掉的：一律不动
        const present =
          Array.isArray(row.queuedMessages) &&
          row.queuedMessages.some((value) => {
            if (!value || typeof value !== 'object') return false;
            return (value as { id?: unknown }).id === messageId;
          });
        return deny(
          ports,
          ctx,
          'session_queue_cancel',
          present ? 'not-yours' : 'not-found',
          messageId
        );
      }
      if ((await ports.dropQueued(conversationId, [messageId])) === 0) {
        return deny(ports, ctx, 'session_queue_cancel', 'not-found', messageId);
      }
      ports.audit({
        at: ports.now(),
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'session_queue_cancel',
        targetId: messageId,
        ok: true,
        detail: 'cancelled',
      });
      notifySecretaryChanged();
      return { ok: true, result: { status: 'cancelled', conversationId, messageId } };
    },

    async session_stop(params, ctx) {
      const fields = sessionFields(params, ['conversationId', 'clearQueue']);
      if (!fields.ok) return fields;
      const { conversationId, clearQueue } = fields.value;
      const file = ports.dispatchFile();
      if (!canOperate(file, conversationId)) {
        return deny(ports, ctx, 'session_stop', 'not-operable', conversationId);
      }
      // 停止默认保留队列；clearQueue 只清秘书自己排的，用户排的一条不动。
      // 先清再 abort：清队列会触发补投，会话还在跑时补投不会开新轮。
      let cleared = 0;
      if (clearQueue) {
        const { mine } = secretaryQueued((await ports.rows())[conversationId], ctx);
        if (mine.length > 0) {
          cleared = await ports.dropQueued(
            conversationId,
            mine.map((item) => item.id)
          );
        }
      }
      await ports.abort(conversationId);
      // 接管来的会话自带的目标也一并暂停，免得停下后又被续跑
      const record = file.dispatched[conversationId];
      if (record?.goal || record?.takeover) await ports.pauseGoal(conversationId);
      // 停下就收口：残留的运行中与后台任务记录会让它一直被算在跑
      if (record) {
        if (record.lastState !== 'idle') record.stateSince = ports.now();
        record.lastState = 'idle';
        delete record.backgroundRunning;
        delete record.stalledTurn;
        ports.saveDispatch(file);
      }
      const stopped = markTodoProblem(await ports.todos(), conversationId, 'stopped', ports.now());
      if (stopped.changed) ports.saveTodos(stopped.todos);
      ports.audit({
        at: ports.now(),
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'session_stop',
        targetId: conversationId,
        ok: true,
        detail: cleared > 0 ? `stopped, cleared ${cleared} queued` : 'stopped',
      });
      notifySecretaryChanged();
      return {
        ok: true,
        result: { status: 'stopped', ...(cleared > 0 ? { clearedQueued: cleared } : {}) },
      };
    },

    async todo_list(params) {
      const status = stringParam(params, 'status');
      if (status && !(TODO_STATUSES as readonly string[]).includes(status)) return invalidArguments;
      const projectId = stringParam(params, 'projectId');
      const profile = await profileOf(ports);
      const projects = visibleProjects(await ports.projects(), profile);
      if (projectId && !projects.some((project) => project.projectId === projectId))
        return { ok: false, error: 'not-found' };
      const rows = await ports.rows();
      const file = ports.dispatchFile();
      const todos = [];
      for (const todo of await ports.todos()) {
        if (todo.projectId && !projects.some((project) => project.projectId === todo.projectId))
          continue;
        if (projectId && todo.projectId !== projectId) continue;
        const session = todo.conversationId
          ? linkedTodoSession(
              file.dispatched[todo.conversationId],
              rows[todo.conversationId],
              await ports.status(todo.conversationId)
            )
          : null;
        const phase = todoStatus(todo, session);
        if (status && phase !== (status as TodoStatus)) continue;
        const problem =
          phase === 'problem'
            ? (todo.problem ??
              (!session?.present
                ? 'deleted'
                : session.aborted || session.result === 'interrupted'
                  ? 'stopped'
                  : 'failed'))
            : undefined;
        const project = todo.projectId
          ? projects.find((candidate) => candidate.projectId === todo.projectId)
          : undefined;
        todos.push({
          id: todo.id,
          text: wrapUntrusted(`todo:${todo.id}`, redactSecrets(todo.text)),
          status: phase,
          ...(todo.projectId ? { projectId: todo.projectId } : {}),
          ...(project
            ? { projectName: redactSecrets(projectNameFromPath(project.canonicalPath)) }
            : {}),
          ...(todo.dueAt !== undefined ? { dueAt: todo.dueAt } : {}),
          ...(todo.conversationId ? { conversationId: todo.conversationId } : {}),
          ...(session ? { sessionState: session.present ? session.state : 'gone' } : {}),
          ...(session?.title
            ? {
                sessionTitle: wrapUntrusted(
                  `session:${todo.conversationId}`,
                  redactSecrets(session.title)
                ),
              }
            : {}),
          ...(problem ? { problem } : {}),
        });
      }
      return { ok: true, result: { todos } };
    },

    async session_takeover_propose(params, ctx) {
      const conversationId = stringParam(params, 'conversationId');
      if (!conversationId || !ctx.secretaryConversationId) return invalidArguments;
      const op = 'session_takeover_propose';
      const checked = await checkTakeover(ports, conversationId);
      if (!checked.ok) return auditFailure(ports, ctx, op, checked.error, conversationId);
      const file = ports.dispatchFile();
      const pending = Object.values(file.proposals).find(
        (proposal) =>
          proposal.kind === 'takeover' &&
          proposal.status === 'pending' &&
          proposal.draft.conversationId === conversationId
      );
      // 同一会话已有一张待确认的卡就复用，不再叠一张
      const proposalId = pending?.id ?? ports.newId();
      const now = ports.now();
      if (!pending) {
        const title = typeof checked.row.title === 'string' ? checked.row.title.trim() : '';
        const reason = stringParam(params, 'reason');
        file.proposals[proposalId] = {
          id: proposalId,
          secretaryConversationId: ctx.secretaryConversationId,
          createdAt: now,
          updatedAt: now,
          status: 'pending',
          kind: 'takeover',
          draft: {
            conversationId,
            projectId: checked.conversation.projectId,
            ...(title ? { title } : {}),
            ...(reason ? { reason: reason.slice(0, 500) } : {}),
          },
        };
        ports.saveDispatch(file);
        notifySecretaryChanged();
      }
      ports.audit({
        at: now,
        secretaryConversationId: ctx.secretaryConversationId,
        op,
        targetId: proposalId,
        ok: true,
        detail: pending ? 'awaiting_confirmation (existing)' : 'awaiting_confirmation',
      });
      return { ok: true, result: { status: 'awaiting_confirmation', proposalId } };
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
      return {
        ok: true,
        result: {
          todoId: todo.id,
          text: todo.text,
          ...(dueAt !== undefined ? { dueAt } : {}),
          ...(projectId ? { projectId } : {}),
        },
      };
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
      return {
        ok: true,
        result: { todoId, before: todoSnapshot(todo), after: todoSnapshot(next) },
      };
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
      const title = stringParam(params, 'title') ?? todoTitle(todo.text);
      const profile = await profileOf(ports);
      const project = (await ports.projects()).find(
        (candidate) => candidate.projectId === projectId
      );
      const requested = typeof params.worktree === 'boolean' ? params.worktree : true;
      const worktree =
        profile.dispatchWorktree === 'never'
          ? false
          : profile.dispatchWorktree === 'always'
            ? true
            : requested;
      const branch = project ? await ports.branch(project.canonicalPath) : null;
      const draft: DispatchDraft = {
        projectId,
        prompt: todoDispatchPrompt(todo.text, stringParam(params, 'prompt'), {
          projectPath: project?.canonicalPath ?? projectId,
          branch,
          worktree,
        }),
        // 不给标题时会话按 prompt 开头起名，prompt 常以共同背景开头，几个会话会重名
        ...(title ? { title } : {}),
        worktree,
        todoId,
      };
      const outcome = await dispatchDraft(ports, ctx.secretaryConversationId, draft);
      const result = outcomeResult(ports, ctx, 'todo_item_dispatch', outcome, todoId);
      return result;
    },
  };
  return handlers;
}

/** 渲染要看出改了什么，不能只回一个 id */
function todoSnapshot(todo: SecretaryTodo): {
  text: string;
  done: boolean;
  dueAt?: number;
  projectId?: string;
} {
  return {
    text: todo.text,
    done: todo.doneAt !== undefined,
    ...(todo.dueAt !== undefined ? { dueAt: todo.dueAt } : {}),
    ...(todo.projectId ? { projectId: todo.projectId } : {}),
  };
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
  if (transitioned.proposal.kind === 'takeover') {
    const granted = await grantTakeover(
      ports,
      transitioned.proposal.draft.conversationId,
      'proposal',
      proposal.secretaryConversationId
    );
    return finishProposal(ports, proposalId, granted);
  }

  const profile = await profileOf(ports);
  const draft = mergeDraft(transitioned.proposal.draft, edits);
  const validated = validateDispatch(draft, await dispatchContext(ports, profile, draft.projectId));
  if (!validated.ok)
    return finishProposal(ports, proposalId, { ok: false, error: validated.error });
  const created = await executeDispatch(
    ports,
    validated.draft,
    proposal.secretaryConversationId,
    profile
  );
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
  if (request.action === 'reopen') {
    const current = await ports.todos();
    const opened = reopenTodo(current, request.todoId, now);
    if (!opened.found) return { ok: false, error: 'not-found' };
    if (opened.changed) ports.saveTodos(opened.todos);
    ports.audit({
      at: now,
      secretaryConversationId: null,
      op: 'todo_reopen',
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
  const loaded = await loadSecretaryBoard(ports);
  const { activity: _activity, ...board } = loaded.board;
  return {
    enabled: extra.enabled,
    projectId: extra.projectId,
    profile: await ports.profile(),
    persona: await ports.persona(),
    board,
    proposals: loaded.file.proposals,
    takeovers: takeoverViews(loaded.file, loaded.rows, loaded.projects),
  };
}

/** 动态只按页离开 Main。广播里的看板不再带整份 activity */
export async function pageSecretaryFeed(
  ports: SecretaryStatePorts,
  query: FeedQuery
): Promise<FeedPage> {
  const loaded = await loadSecretaryBoard(ports);
  return pageFeed(feedEvents(loaded.board), query);
}

async function loadSecretaryBoard(ports: SecretaryStatePorts): Promise<{
  file: SecretaryDispatchFile;
  rows: Record<string, Record<string, unknown>>;
  projects: readonly ProjectAuthority[];
  board: SecretaryBoard;
}> {
  const file = ports.dispatchFile();
  const rows = await ports.rows();
  const projects = await ports.projects();
  const statuses: Record<string, SecretarySessionStatus> = {};
  for (const record of Object.values(file.dispatched)) {
    if (!rows[record.conversationId]) continue;
    statuses[record.conversationId] = await ports.status(record.conversationId);
  }
  return {
    file,
    rows,
    projects,
    board: buildBoard(file, { rows, statuses, projects, todos: await ports.todos() }),
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
  steer: async (conversationId, text, deliveryId) =>
    (await import('../../ipc/agent')).steerRootFromMain(conversationId, text, deliveryId),
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
  dropQueued: async (conversationId, messageIds) => {
    const { patchConversationsState } = await import('../../ipc/settings');
    const drop = new Set(messageIds);
    let removed = 0;
    patchConversationsState((state) => {
      const row = state.conversations[conversationId];
      if (!row || !Array.isArray(row.queuedMessages)) return;
      const kept = row.queuedMessages.filter((value) => {
        const id = value && typeof value === 'object' ? (value as { id?: unknown }).id : undefined;
        const hit = typeof id === 'string' && drop.has(id);
        if (hit) removed += 1;
        return !hit;
      });
      if (removed === 0) return;
      state.conversations[conversationId] = { ...row, queuedMessages: kept };
    });
    return removed;
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
  branch: async (repoPath) => {
    try {
      const { currentBranch } = await import('../worktree/service');
      return await currentBranch(repoPath);
    } catch {
      return null;
    }
  },
};

function store(): SecretaryStore {
  return new SecretaryStore(secretaryDir());
}

export const secretaryDispatchHandlers = createSecretaryDispatchHandlers(secretaryDispatchPorts);
