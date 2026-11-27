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
    name?: string;
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
  output?: string;
  /** agy 在 prompt 结束后还会接着跑、跑完自己回复的工具（非 daemon 命令、agy 子任务）。首次能判定时定下 */
  background?: boolean;
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
  /** 丢掉的 agy 卡（我们自己 Host MCP 工具的那张）：后续只带 id 的 update 也丢 */
  hidden?: string[];
  /** 最近一个 usage_update：agy 当前上下文占用。PromptResponse.usage 是整轮内部调用的累加，不是占用 */
  context?: AgyContextUsage;
}

export interface AgyContextUsage {
  used: number;
  size?: number;
}

export type TranslatorEffect =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      status: AgyToolStatus;
      args: Record<string, unknown>;
      output?: string;
    }
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
