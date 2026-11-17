import { parseProfile } from '@shared/secretary/parse';
import type { ConversationAuthority, ProjectAuthority } from '@shared/types/agent';
import type {
  DispatchDraft,
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryProfile,
  SecretaryTodoMutate,
} from '@shared/types/secretary';
import { visibleProjects } from './readers';

type MaybePromise<T> = T | Promise<T>;

const MAX_REFERENCED = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function time(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export interface ResolveProposalRequest {
  proposalId: string;
  action: 'confirm' | 'reject';
  edits?: Partial<DispatchDraft>;
  /** 卡片上就地改过的档案草案；内容由档案服务收窄 */
  profileDraft?: unknown;
}

function parseEdits(value: unknown): Partial<DispatchDraft> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const edits: Partial<DispatchDraft> = {};
  const projectId = nonEmpty(value.projectId);
  if (projectId) edits.projectId = projectId;
  const prompt = nonEmpty(value.prompt);
  if (prompt) edits.prompt = prompt;
  if (typeof value.title === 'string') edits.title = value.title;
  if (typeof value.goal === 'string') edits.goal = value.goal;
  if (typeof value.worktree === 'boolean') edits.worktree = value.worktree;
  return edits;
}

export function parseResolveProposalRequest(value: unknown): ResolveProposalRequest | null {
  if (!isRecord(value)) return null;
  const proposalId = nonEmpty(value.proposalId);
  if (!proposalId) return null;
  if (value.action !== 'confirm' && value.action !== 'reject') return null;
  if (value.edits !== undefined && !isRecord(value.edits)) return null;
  if (value.profileDraft !== undefined && !isRecord(value.profileDraft)) return null;
  const edits = parseEdits(value.edits);
  return {
    proposalId,
    action: value.action,
    ...(edits ? { edits } : {}),
    ...(value.profileDraft !== undefined ? { profileDraft: value.profileDraft } : {}),
  };
}

export interface ReferenceRequest {
  secretaryConversationId: string;
  conversationIds: string[];
}

export interface DismissRequest {
  conversationId: string;
}

export function parseDismissRequest(value: unknown): DismissRequest | null {
  if (!isRecord(value)) return null;
  const conversationId = nonEmpty(value.conversationId);
  return conversationId ? { conversationId } : null;
}

export interface MarkResultRequest {
  conversationId: string;
  action: 'done' | 'undo' | 'dismiss';
}

export function parseMarkResultRequest(value: unknown): MarkResultRequest | null {
  if (!isRecord(value)) return null;
  const conversationId = nonEmpty(value.conversationId);
  if (!conversationId) return null;
  if (value.action !== 'done' && value.action !== 'undo' && value.action !== 'dismiss') return null;
  return { conversationId, action: value.action };
}

export function parseReferenceRequest(value: unknown): ReferenceRequest | null {
  if (!isRecord(value)) return null;
  const secretaryConversationId = nonEmpty(value.secretaryConversationId);
  if (!secretaryConversationId) return null;
  if (!Array.isArray(value.conversationIds)) return null;
  const conversationIds: string[] = [];
  for (const item of value.conversationIds) {
    const id = nonEmpty(item);
    if (id && !conversationIds.includes(id)) conversationIds.push(id);
    if (conversationIds.length >= MAX_REFERENCED) break;
  }
  return { secretaryConversationId, conversationIds };
}

export function parseTodoMutateRequest(value: unknown): SecretaryTodoMutate | null {
  if (!isRecord(value)) return null;
  if (value.action === 'add') {
    const text = nonEmpty(value.text);
    if (!text) return null;
    const dueAt = time(value.dueAt);
    const projectId = nonEmpty(value.projectId);
    return {
      action: 'add',
      text,
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(projectId ? { projectId } : {}),
    };
  }
  if (value.action === 'update') {
    const todoId = nonEmpty(value.todoId);
    if (!todoId) return null;
    const text = nonEmpty(value.text);
    const done = typeof value.done === 'boolean' ? value.done : undefined;
    const dueAt = value.dueAt === null ? null : time(value.dueAt);
    if (text === undefined && done === undefined && dueAt === undefined) return null;
    return {
      action: 'update',
      todoId,
      ...(text !== undefined ? { text } : {}),
      ...(done !== undefined ? { done } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
    };
  }
  if (value.action === 'remove') {
    const todoId = nonEmpty(value.todoId);
    return todoId ? { action: 'remove', todoId } : null;
  }
  if (value.action === 'reopen') {
    const todoId = nonEmpty(value.todoId);
    return todoId ? { action: 'reopen', todoId } : null;
  }
  if (value.action === 'dispatch') {
    const todoId = nonEmpty(value.todoId);
    if (!todoId) return null;
    const projectId = nonEmpty(value.projectId);
    const prompt = nonEmpty(value.prompt);
    return {
      action: 'dispatch',
      todoId,
      ...(projectId ? { projectId } : {}),
      ...(prompt ? { prompt } : {}),
    };
  }
  return null;
}

export interface ReferencePorts {
  conversations(): MaybePromise<readonly ConversationAuthority[]>;
  projects(): MaybePromise<readonly ProjectAuthority[]>;
  profile(): MaybePromise<SecretaryProfile | null>;
  dispatchFile(): SecretaryDispatchFile;
  saveDispatch(file: SecretaryDispatchFile): void;
  audit(entry: SecretaryAuditEntry): void;
  now(): number;
}

export type ReferenceResult = { ok: true; named: string[] } | { ok: false; error: string };

function defaultProfile(): SecretaryProfile {
  const parsed = parseProfile({});
  if (!parsed) throw new Error('secretary default profile');
  return parsed;
}

/**
 * 点名授权：用户把某个会话交给秘书时生效，与那一轮是否成功无关。
 * 只接受秘书会话作为发起方，逐个校验目标仍可操作。
 */
export async function referenceConversations(
  ports: ReferencePorts,
  request: ReferenceRequest,
  isSecretary: (conversationId: string) => boolean
): Promise<ReferenceResult> {
  if (!isSecretary(request.secretaryConversationId)) return { ok: false, error: 'not-secretary' };
  const profile = (await ports.profile()) ?? defaultProfile();
  const projects = await ports.projects();
  const visible = new Set(visibleProjects(projects, profile).map((project) => project.projectId));
  const conversations = new Map(
    (await ports.conversations()).map((conversation) => [conversation.conversationId, conversation])
  );
  const file = ports.dispatchFile();
  const accepted: string[] = [];
  for (const conversationId of request.conversationIds) {
    const conversation = conversations.get(conversationId);
    if (conversation?.kind !== 'root' || conversation.bot) continue;
    const project = projects.find((candidate) => candidate.projectId === conversation.projectId);
    if (!project || project.kind === 'secretary') continue;
    if (!visible.has(conversation.projectId)) continue;
    if (!file.named.includes(conversationId)) file.named.push(conversationId);
    accepted.push(conversationId);
  }
  if (accepted.length === 0) return { ok: false, error: 'no-valid-conversation' };
  ports.saveDispatch(file);
  const now = ports.now();
  for (const conversationId of accepted) {
    ports.audit({
      at: now,
      secretaryConversationId: request.secretaryConversationId,
      op: 'reference_conversations',
      targetId: conversationId,
      ok: true,
    });
  }
  return { ok: true, named: accepted };
}
