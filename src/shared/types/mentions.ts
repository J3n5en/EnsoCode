import {
  type AgentTypeCandidate,
  type AgentTypeKey,
  type ChildSessionIdentity,
  parseAgentTypeKey,
} from '../builtinAgents';
import type { DefaultModelRef } from '../defaultModel';
import type { AttachedImage } from './agent';

export interface FileMentionCandidate {
  kind: 'file';
  id: string;
  label: string;
  relativePath: string;
}

export interface AgentTypeMentionCandidate extends AgentTypeCandidate {
  kind: 'agent-type';
  id: AgentTypeKey;
  label: string;
}

/** 过去会话引用（Cursor 式 @Past Chats）：发送时把 jsonl 路径以引用块追加进文本，agent 自己按需 read。 */
export interface ChatMentionCandidate {
  kind: 'chat';
  /** sessionId */
  id: string;
  /** 会话标题（空标题已回落） */
  label: string;
  /** pi 会话 jsonl 路径 */
  sessionFile: string;
}

/** Design Mode 圈选：只从 Browser 插入，不进 @ picker。 */
export interface UiElementMentionCandidate {
  kind: 'ui-element';
  id: string;
  label: string;
  path: string;
  text: string;
  imageId: string;
}

export type MentionCandidate =
  | FileMentionCandidate
  | AgentTypeMentionCandidate
  | ChatMentionCandidate
  | UiElementMentionCandidate;

export interface FileMentionRef {
  id: string;
  relativePath: string;
}

export interface AgentDispatchTask {
  text: string;
  images: AttachedImage[];
  fileMentions: FileMentionRef[];
}

/** Renderer只引用 Main selection binding；不携model/target/profile/session。 */
export interface AgentDispatchRequest {
  requestId: string;
  selectionBindingId: string;
  typeKey: AgentTypeKey;
  task: AgentDispatchTask;
}

export type AgentDispatchResult =
  | {
      accepted: true;
      dispatchId: string;
      requestId: string;
      child: ChildSessionIdentity;
    }
  | {
      accepted: false;
      requestId: string;
      code:
        | 'invalid-request'
        | 'invalid-binding'
        | 'unknown-agent-type'
        | 'reserved-agent-type'
        | 'capacity-reached'
        | 'parent-model-unavailable'
        | 'dispatch-failed';
      message: string;
      action?: 'select-model' | 'open-agent-types' | 'retry';
    };

export interface ParentModelSelectionRequest {
  parentBindingId: string;
  selection: DefaultModelRef;
}

export type ModelSelectionSource = 'started-session' | 'draft-selection' | 'default' | 'legacy';

export interface MainModelSelectionBinding {
  selectionBindingId: string;
  parentBindingId: string;
  providerId: string;
  modelId: string;
  mainRevision: number;
  source: ModelSelectionSource;
  issuedAt: number;
}

export type MainModelSelectionBindingResult =
  | { accepted: true; binding: MainModelSelectionBinding }
  | { accepted: false; error: string };

export interface ParentSourceBindingRequest {
  requestId: string;
}

export type ParentSourceBindingResult =
  | { accepted: true; requestId: string; parentBindingId: string; expiresAt: number }
  | { accepted: false; requestId: string; error: string };

export interface AgentSummonRequest {
  typeKey: AgentTypeKey;
  prompt?: string;
}

export interface AgentComposerPrefillEvent {
  typeKey: AgentTypeKey;
  prompt?: string;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const isAttachedImage = (value: unknown): value is AttachedImage => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const image = value as Record<string, unknown>;
  return (
    hasExactKeys(image, ['data', 'mimeType']) &&
    isNonEmptyString(image.data) &&
    isNonEmptyString(image.mimeType)
  );
};

export function parseFileMentionRef(value: unknown): FileMentionRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mention = value as Record<string, unknown>;
  if (
    !hasExactKeys(mention, ['id', 'relativePath']) ||
    !isNonEmptyString(mention.id) ||
    !isNonEmptyString(mention.relativePath)
  ) {
    return null;
  }
  return { id: mention.id, relativePath: mention.relativePath };
}

export function parseMentionCandidate(value: unknown): MentionCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'file') {
    if (
      !hasExactKeys(candidate, ['kind', 'id', 'label', 'relativePath']) ||
      !isNonEmptyString(candidate.id) ||
      !isNonEmptyString(candidate.label) ||
      !isNonEmptyString(candidate.relativePath)
    ) {
      return null;
    }
    return candidate as unknown as FileMentionCandidate;
  }
  if (candidate.kind === 'chat') {
    if (
      !hasExactKeys(candidate, ['kind', 'id', 'label', 'sessionFile']) ||
      !isNonEmptyString(candidate.id) ||
      !isNonEmptyString(candidate.label) ||
      !isNonEmptyString(candidate.sessionFile)
    ) {
      return null;
    }
    return candidate as unknown as ChatMentionCandidate;
  }
  if (candidate.kind === 'ui-element') {
    if (
      !hasExactKeys(candidate, ['kind', 'id', 'label', 'path', 'text', 'imageId']) ||
      !isNonEmptyString(candidate.id) ||
      !isNonEmptyString(candidate.label) ||
      !isNonEmptyString(candidate.path) ||
      !isNonEmptyString(candidate.text) ||
      !isNonEmptyString(candidate.imageId)
    ) {
      return null;
    }
    return candidate as unknown as UiElementMentionCandidate;
  }
  if (candidate.kind !== 'agent-type') return null;
  const typeKey = parseAgentTypeKey(candidate.id);
  if (
    !hasExactKeys(candidate, [
      'kind',
      'id',
      'typeKey',
      'label',
      'displayName',
      'description',
      'source',
      'locked',
      'canDisable',
      'canEdit',
    ]) ||
    !typeKey ||
    candidate.typeKey !== typeKey ||
    !isNonEmptyString(candidate.label) ||
    candidate.label !== candidate.displayName ||
    !isNonEmptyString(candidate.description) ||
    (candidate.source !== 'system' &&
      candidate.source !== 'builtin' &&
      candidate.source !== 'custom') ||
    typeof candidate.locked !== 'boolean' ||
    typeof candidate.canDisable !== 'boolean' ||
    typeof candidate.canEdit !== 'boolean'
  ) {
    return null;
  }
  return candidate as unknown as AgentTypeMentionCandidate;
}

export function parseAgentDispatchTask(value: unknown): AgentDispatchTask | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  if (
    !hasExactKeys(task, ['text', 'images', 'fileMentions']) ||
    typeof task.text !== 'string' ||
    !Array.isArray(task.images) ||
    task.images.some((image) => !isAttachedImage(image)) ||
    !Array.isArray(task.fileMentions) ||
    task.fileMentions.some((mention) => parseFileMentionRef(mention) === null) ||
    (!task.text.trim() && task.images.length === 0)
  ) {
    return null;
  }
  return task as unknown as AgentDispatchTask;
}

export function parseAgentDispatchRequest(
  value: unknown,
  knownTypeKeys: ReadonlySet<AgentTypeKey>
): AgentDispatchRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  const typeKey = parseAgentTypeKey(request.typeKey);
  if (
    !hasExactKeys(request, ['requestId', 'selectionBindingId', 'typeKey', 'task']) ||
    !isNonEmptyString(request.requestId) ||
    !isNonEmptyString(request.selectionBindingId) ||
    !typeKey ||
    !knownTypeKeys.has(typeKey) ||
    parseAgentDispatchTask(request.task) === null
  ) {
    return null;
  }
  return request as unknown as AgentDispatchRequest;
}

export function parseParentModelSelectionRequest(
  value: unknown
): ParentModelSelectionRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (
    !hasExactKeys(request, ['parentBindingId', 'selection']) ||
    !isNonEmptyString(request.parentBindingId) ||
    !request.selection ||
    typeof request.selection !== 'object' ||
    Array.isArray(request.selection)
  ) {
    return null;
  }
  const selection = request.selection as Record<string, unknown>;
  return hasExactKeys(selection, ['providerId', 'modelId']) &&
    isNonEmptyString(selection.providerId) &&
    isNonEmptyString(selection.modelId)
    ? (request as unknown as ParentModelSelectionRequest)
    : null;
}

export function parseMainModelSelectionBinding(value: unknown): MainModelSelectionBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const binding = value as Record<string, unknown>;
  if (
    !hasExactKeys(binding, [
      'selectionBindingId',
      'parentBindingId',
      'providerId',
      'modelId',
      'mainRevision',
      'source',
      'issuedAt',
    ]) ||
    !isNonEmptyString(binding.selectionBindingId) ||
    !isNonEmptyString(binding.parentBindingId) ||
    !isNonEmptyString(binding.providerId) ||
    !isNonEmptyString(binding.modelId) ||
    !Number.isInteger(binding.mainRevision) ||
    (binding.mainRevision as number) < 0 ||
    (binding.source !== 'started-session' &&
      binding.source !== 'draft-selection' &&
      binding.source !== 'default' &&
      binding.source !== 'legacy') ||
    typeof binding.issuedAt !== 'number' ||
    !Number.isFinite(binding.issuedAt)
  ) {
    return null;
  }
  return binding as unknown as MainModelSelectionBinding;
}

export function parseParentSourceBindingRequest(value: unknown): ParentSourceBindingRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  return hasExactKeys(request, ['requestId']) && isNonEmptyString(request.requestId)
    ? { requestId: request.requestId }
    : null;
}

export function parseAgentSummonRequest(
  value: unknown,
  knownTypeKeys: ReadonlySet<AgentTypeKey>
): AgentSummonRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  const typeKey = parseAgentTypeKey(request.typeKey);
  if (!typeKey || !knownTypeKeys.has(typeKey)) return null;
  if (!hasOnlyKeys(request, ['typeKey', 'prompt'])) return null;
  if (request.prompt !== undefined && typeof request.prompt !== 'string') return null;
  return {
    typeKey,
    ...(typeof request.prompt === 'string' ? { prompt: request.prompt } : {}),
  };
}

export function parseAgentComposerPrefillEvent(value: unknown): AgentComposerPrefillEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const typeKey = parseAgentTypeKey(event.typeKey);
  if (!typeKey) return null;
  if (!hasOnlyKeys(event, ['typeKey', 'prompt'])) return null;
  if (event.prompt !== undefined && typeof event.prompt !== 'string') return null;
  return {
    typeKey,
    ...(typeof event.prompt === 'string' ? { prompt: event.prompt } : {}),
  };
}
