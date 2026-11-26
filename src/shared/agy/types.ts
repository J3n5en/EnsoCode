import type { ApprovalMode } from '../types/agentConstants';

export type AgyAuthStatus =
  | { status: 'signed-in'; version: string; models: AgyModelOption[] }
  | { status: 'signed-out'; version: string }
  | { status: 'not-installed' }
  | { status: 'too-old'; version: string }
  | { status: 'unknown' };

export interface AgyModelOption {
  id: string;
  name: string;
}

export type AgyInteractionMode = 'default' | 'plan';

export type AgyContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

export interface AgySelectOption {
  value: string;
  name: string;
}

export interface AgyConfigOption {
  id: string;
  category?: string;
  type: 'select';
  currentValue?: string;
  options: AgySelectOption[];
}

export interface AgyModeInfo {
  id: string;
  name?: string;
}

export interface AgySessionFields {
  sessionId: string;
  version: string;
  canAppendSystemPrompt: boolean;
  configOptions: AgyConfigOption[];
  modes: AgyModeInfo[];
}

/** 每个 Enso 会话一条 ACP 连接的协议阶段。进程句柄不在这里。 */
export type AgySessionPhase =
  | { phase: 'closed' }
  | { phase: 'spawning' }
  | { phase: 'initialized'; version: string; canAppendSystemPrompt: boolean }
  | ({ phase: 'session-ready' } & AgySessionFields)
  | ({ phase: 'prompting' } & AgySessionFields)
  | { phase: 'failed'; message: string };

export type AgySessionEvent =
  | { type: 'spawn' }
  | { type: 'initialized'; version: string; canAppendSystemPrompt: boolean }
  | ({ type: 'session-ready' } & AgySessionFields)
  | { type: 'prompt-started' }
  | { type: 'prompt-finished' }
  | { type: 'fail'; message: string }
  | { type: 'close' };

export interface AgyPermissionOption {
  optionId: string;
  kind: string;
  name?: string;
}

export interface AgyPermissionRequest {
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
  };
  options: AgyPermissionOption[];
}

export type PermissionAction = { kind: 'ask' } | { kind: 'selected'; optionId: string };

export type PermissionResponse =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

export type UserPermissionDecision =
  | 'allow'
  | 'allowSession'
  | 'deny'
  | 'cancel'
  | 'block'
  | 'timeout'
  | 'no-approver'
  | 'revise';

export type AgyToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface AgyToolCard {
  id: string;
  name: string;
  title?: string;
  status: AgyToolStatus;
  args: Record<string, unknown>;
}

export interface AgyPlanItem {
  content: string;
  status?: string;
}

export interface TranslatorState {
  text: string;
  thinking: string;
  tools: AgyToolCard[];
  plan: AgyPlanItem[] | null;
}

export type TranslatorEffect =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; id: string; name: string; status: AgyToolStatus; args: Record<string, unknown> }
  | { type: 'plan'; items: AgyPlanItem[] };

export type PiStopReason = 'stop' | 'length' | 'error' | 'aborted';

export interface PromptMessage {
  role: string;
  content?: unknown;
  customType?: string;
}

export interface AgySettings {
  binaryPath: string;
  skipPermissions: boolean;
}

export const EMPTY_AGY_SETTINGS: AgySettings = { binaryPath: '', skipPermissions: false };

export type { ApprovalMode };
