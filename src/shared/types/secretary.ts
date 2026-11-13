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
  /** 已报 stalled 的轮次，一轮只报一次 */
  stalledTurn?: number;
  lastResult?: { kind: SecretaryResultKind; turn: number; at: number };
}

export type SecretaryUpdate = {
  key: string;
  at: number;
  text: string;
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

export interface SecretarySchedule {
  id: string;
  name: string;
  prompt: string;
  /** 一次性，ISO 时间 */
  at?: string;
  /** 五段式本地时间；与 at 二选一 */
  cron?: string;
  createdAt: number;
  lastFiredAt?: number;
  system?: 'daily-brief' | { todoId: string };
}

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
