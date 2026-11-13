import type { ModelRef, ThinkingLevel } from './agent';

export type SecretaryAutonomy = 'ask-first' | 'tell-after' | 'full';

export interface SecretaryProfile {
  version: 1;
  name: string;
  avatar: { color: string; imageVersion?: number };
  model?: ModelRef & { thinkingLevel?: ThinkingLevel };
  autonomy: SecretaryAutonomy;
  autoApproveProjectIds: string[];
  visibleProjectIds: 'all' | string[];
  dispatchModel:
    | { mode: 'project' }
    | { mode: 'fixed'; model: ModelRef }
    | { mode: 'choose'; candidates: ModelRef[] };
  dispatchWorktree: 'never' | 'auto' | 'always';
  maxRunningDispatches: number;
  addressAs?: string;
  replyLanguage: 'ui' | 'zh' | 'en';
  style: 'concise' | 'detailed';
  notify: 'needs-user' | 'with-done' | 'off';
  dailyBriefAt?: string;
  updatedAt: number;
}

export type ProposalStatus =
  | 'pending'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'expired';

export interface DispatchDraft {
  projectId: string;
  prompt: string;
  title?: string;
  goal?: string;
  model?: ModelRef;
  worktree: boolean;
  todoId?: string;
}

export type SecretaryProposal = {
  id: string;
  secretaryConversationId: string;
  createdAt: number;
  updatedAt: number;
  status: ProposalStatus;
  error?: string;
} & (
  | { kind: 'dispatch'; draft: DispatchDraft; conversationId?: string }
  | {
      kind: 'profile';
      draft: Partial<Omit<SecretaryProfile, 'version' | 'updatedAt'>> & { persona?: string };
    }
);

export type SecretaryResultKind =
  | 'goal-complete'
  | 'goal-blocked'
  | 'turn-ended'
  | 'needs-user'
  | 'failed'
  | 'stalled'
  | 'interrupted';

export interface DispatchRecord {
  conversationId: string;
  projectId: string;
  secretaryConversationId: string;
  createdAt: number;
  todoId?: string;
  goal?: string;
  /** 每次 turn-completed / turn-failed 加一 */
  turn: number;
  lastState: 'running' | 'idle' | 'waiting' | 'error';
  lastEventAt: number;
  /** 最后一轮的助手正文，工作台显示"最后说了什么" */
  lastText?: string;
  /** 已报 stalled 的轮次，一轮只报一次 */
  stalledTurn?: number;
  lastResult?: { kind: SecretaryResultKind; turn: number; at: number };
}

export type SecretaryUpdate = {
  key: string;
  at: number;
  text: string;
  /** 最后一轮正文：投递前脱敏并包成不可信内容 */
  lastText?: string;
  secretaryConversationId?: string;
} & (
  | { kind: SecretaryResultKind; conversationId: string }
  | { kind: 'proposal'; proposalId: string; status: ProposalStatus }
  | { kind: 'schedule'; scheduleId: string }
);

export interface SecretaryDispatchFile {
  version: 1;
  dispatched: Record<string, DispatchRecord>;
  named: string[];
  proposals: Record<string, SecretaryProposal>;
  outbox: SecretaryUpdate[];
  inflight?: {
    deliveryId: string;
    secretaryConversationId: string;
    keys: string[];
    /** 1..6 */
    attempt: number;
    nextAttemptAt: number;
    settled?: boolean;
  };
}

export interface SecretaryTodo {
  id: string;
  text: string;
  dueAt?: number;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
  conversationId?: string;
  doneAt?: number;
}

/** 界面对待办的操作；dispatch 是用户亲手点出，不再走自主度确认 */
export type SecretaryTodoMutate =
  | { action: 'add'; text: string; dueAt?: number; projectId?: string }
  | { action: 'update'; todoId: string; text?: string; dueAt?: number | null; done?: boolean }
  | { action: 'remove'; todoId: string }
  | { action: 'dispatch'; todoId: string; projectId?: string; prompt?: string };

export type SecretarySchedule = {
  id: string;
  name: string;
  prompt: string;
  createdAt: number;
  lastFiredAt?: number;
  system?: 'daily-brief' | { todoId: string };
} & (
  | { /** 一次性，ISO 时间 */ at: string; cron?: never }
  | { /** 五段式本地时间 */ cron: string; at?: never }
);

export interface SecretaryAuditEntry {
  at: number;
  secretaryConversationId: string | null;
  op: string;
  targetId?: string;
  ok: boolean;
  detail?: string;
}

export type SecretaryCard =
  | {
      kind: 'session';
      conversationId: string;
      projectId: string;
      projectName: string;
      title: string;
      state: 'running' | 'idle' | 'waiting' | 'error' | 'not-started';
      lastText?: string;
      startedAt: number;
      result?: SecretaryResultKind;
      secretaryConversationId: string;
      unread?: boolean;
    }
  | { kind: 'proposal'; proposal: SecretaryProposal; projectName?: string };

export interface SecretaryBoard {
  needsYou: SecretaryCard[];
  running: SecretaryCard[];
  todos: SecretaryTodo[];
  done: SecretaryCard[];
}

export interface SecretaryState {
  enabled: boolean;
  projectId: string | null;
  /** null = 未完成初次设置 */
  profile: SecretaryProfile | null;
  persona: string;
  board: SecretaryBoard;
  proposals: Record<string, SecretaryProposal>;
}
