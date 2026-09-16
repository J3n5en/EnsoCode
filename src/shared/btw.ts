import type { DefaultModelRef } from './defaultModel';
import {
  APPROVAL_MODES,
  type ApprovalMode,
  THINKING_LEVELS,
  type ThinkingLevel,
} from './types/agent';

export const BTW_SNAPSHOT_LIMIT = 40;
export const BTW_TITLE_MAX_CHARS = 32;
export const BTW_DISABLED_TOOLS = ['subagent', 'coworker'] as const;

export type BtwMode = 'contextual' | 'tangent';

export type BtwTurn = { role: 'user' | 'assistant'; text: string };

export type BtwSourcePart = { type: string; text?: string };

export type BtwSourceMessage = {
  role: string;
  content: readonly BtwSourcePart[];
};

export type BtwPromptRequest = {
  requestId: string;
  conversationId: string;
  systemPrompt: string;
  userText: string;
  sessionModel?: DefaultModelRef;
  reasoningEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
};

export type BtwAbortRequest = { requestId: string };

export type BtwSpawnRequest = {
  sessionId: string;
  parentConversationId: string;
  providerId: string;
  modelId: string;
  rolePrompt: string;
  reasoningEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
  approvalMode?: ApprovalMode;
  presetId?: string;
  loadLocalSkills?: boolean;
};

export type BtwDisposeRequest = { sessionId: string };

export type BtwPromptResult =
  | { ok: true; text: string }
  | { ok: false; error: string; aborted?: boolean };

const BTW_ISOLATION =
  'You are a side conversation attached to a coding session. The main agent cannot see this thread. ' +
  'Do not continue the main task unless the user asks you to. Follow the same tool and skill constraints as the main session. ' +
  'Do not spawn subagents or coworkers. Answer the user directly.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function asModelRef(value: unknown): DefaultModelRef | null {
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.providerId) || !nonEmptyString(value.modelId)) return null;
  return { providerId: value.providerId.trim(), modelId: value.modelId.trim() };
}

function messageText(message: BtwSourceMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
    .trim();
}

export function snapshotMainConversation(messages: readonly BtwSourceMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = messageText(message);
    if (!text) continue;
    lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  return lines.slice(-BTW_SNAPSHOT_LIMIT).join('\n');
}

export function lastAssistantText(messages: readonly BtwSourceMessage[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const text = messageText(message);
    if (text) return text;
  }
  return '';
}

export function btwDisabledTools(existing: readonly string[] = []): string[] {
  const next = [...existing];
  for (const id of BTW_DISABLED_TOOLS) {
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

export function buildBtwSystemPrompt(mode: BtwMode, snapshot: string): string {
  if (mode !== 'contextual') return BTW_ISOLATION;
  const frozen = snapshot.trim();
  if (!frozen) return BTW_ISOLATION;
  return `${BTW_ISOLATION}\n\n# Main conversation (background only)\n${frozen}`;
}

export function isBtwIsolationPrompt(text: string): boolean {
  return text.startsWith(BTW_ISOLATION);
}

export function flattenBtwUserText(history: readonly BtwTurn[], question: string): string {
  const current = question.trim();
  if (history.length === 0) return current;
  const prior = history
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`)
    .join('\n');
  return `${prior}\nUser: ${current}`;
}

export function formatBtwHandoff(text: string): string {
  const body = text.trim();
  if (!body) return '';
  return (
    'Treat the following as discussion context from a side conversation, not as work already completed.\n\n' +
    body
  );
}

export function btwTabTitle(firstQuestion: string): string {
  const line = firstQuestion.trim().split(/\n/, 1)[0]?.trim() ?? '';
  if (line.length <= BTW_TITLE_MAX_CHARS) return line;
  return line.slice(0, BTW_TITLE_MAX_CHARS);
}

export function btwModelCandidates(
  state: Record<string, unknown> | undefined,
  sessionModel?: DefaultModelRef
): DefaultModelRef[] {
  const candidates: DefaultModelRef[] = [];
  for (const ref of [asModelRef(sessionModel), asModelRef(state?.defaultModel)]) {
    if (!ref) continue;
    if (
      candidates.some((item) => item.providerId === ref.providerId && item.modelId === ref.modelId)
    ) {
      continue;
    }
    candidates.push(ref);
  }
  return candidates;
}

export function parseBtwPromptRequest(value: unknown): BtwPromptRequest | null {
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.requestId) || !nonEmptyString(value.conversationId)) return null;
  if (typeof value.systemPrompt !== 'string' || !nonEmptyString(value.userText)) return null;
  const sessionModel =
    value.sessionModel === undefined ? undefined : asModelRef(value.sessionModel);
  if (value.sessionModel !== undefined && !sessionModel) return null;
  if (value.reasoningEnabled !== undefined && typeof value.reasoningEnabled !== 'boolean') {
    return null;
  }
  if (
    value.thinkingLevel !== undefined &&
    (typeof value.thinkingLevel !== 'string' ||
      !THINKING_LEVELS.includes(value.thinkingLevel as ThinkingLevel))
  ) {
    return null;
  }
  return {
    requestId: value.requestId.trim(),
    conversationId: value.conversationId.trim(),
    systemPrompt: value.systemPrompt,
    userText: value.userText.trim(),
    ...(sessionModel ? { sessionModel } : {}),
    ...(typeof value.reasoningEnabled === 'boolean'
      ? { reasoningEnabled: value.reasoningEnabled }
      : {}),
    ...(typeof value.thinkingLevel === 'string'
      ? { thinkingLevel: value.thinkingLevel as ThinkingLevel }
      : {}),
  };
}

export function parseBtwAbortRequest(value: unknown): BtwAbortRequest | null {
  if (!isRecord(value) || !nonEmptyString(value.requestId)) return null;
  return { requestId: value.requestId.trim() };
}

function parseOptionalReasoning(
  value: Record<string, unknown>
): { reasoningEnabled?: boolean; thinkingLevel?: ThinkingLevel } | null {
  if (value.reasoningEnabled !== undefined && typeof value.reasoningEnabled !== 'boolean') {
    return null;
  }
  if (
    value.thinkingLevel !== undefined &&
    (typeof value.thinkingLevel !== 'string' ||
      !THINKING_LEVELS.includes(value.thinkingLevel as ThinkingLevel))
  ) {
    return null;
  }
  return {
    ...(typeof value.reasoningEnabled === 'boolean'
      ? { reasoningEnabled: value.reasoningEnabled }
      : {}),
    ...(typeof value.thinkingLevel === 'string'
      ? { thinkingLevel: value.thinkingLevel as ThinkingLevel }
      : {}),
  };
}

export function parseBtwSpawnRequest(value: unknown): BtwSpawnRequest | null {
  if (!isRecord(value)) return null;
  if (
    !nonEmptyString(value.sessionId) ||
    !nonEmptyString(value.parentConversationId) ||
    !nonEmptyString(value.providerId) ||
    !nonEmptyString(value.modelId) ||
    typeof value.rolePrompt !== 'string' ||
    !value.rolePrompt.trim()
  ) {
    return null;
  }
  const sessionId = value.sessionId.trim();
  const parentConversationId = value.parentConversationId.trim();
  if (sessionId.includes('::cw-') || sessionId === parentConversationId) return null;
  if (
    value.approvalMode !== undefined &&
    (typeof value.approvalMode !== 'string' ||
      !APPROVAL_MODES.includes(value.approvalMode as ApprovalMode))
  ) {
    return null;
  }
  if (value.presetId !== undefined && typeof value.presetId !== 'string') return null;
  if (value.loadLocalSkills !== undefined && typeof value.loadLocalSkills !== 'boolean') {
    return null;
  }
  const reasoning = parseOptionalReasoning(value);
  if (!reasoning) return null;
  return {
    sessionId,
    parentConversationId,
    providerId: value.providerId.trim(),
    modelId: value.modelId.trim(),
    rolePrompt: value.rolePrompt,
    ...reasoning,
    ...(typeof value.approvalMode === 'string'
      ? { approvalMode: value.approvalMode as ApprovalMode }
      : {}),
    ...(typeof value.presetId === 'string' && value.presetId.trim()
      ? { presetId: value.presetId.trim() }
      : {}),
    ...(typeof value.loadLocalSkills === 'boolean'
      ? { loadLocalSkills: value.loadLocalSkills }
      : {}),
  };
}

export function parseBtwDisposeRequest(value: unknown): BtwDisposeRequest | null {
  if (!isRecord(value) || !nonEmptyString(value.sessionId)) return null;
  const sessionId = value.sessionId.trim();
  if (sessionId.includes('::cw-')) return null;
  return { sessionId };
}
