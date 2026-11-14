import type { ModelRef, ThinkingLevel } from './agent';

export type SecretaryAutonomy = 'ask-first' | 'tell-after' | 'full';

/**
 * 秘书可以接管的会话范围：逐个授权（确认卡）、勾选的项目、所有可见项目。
 * 缺省是「勾选的项目」且一个都不勾，等价于逐个授权，升级后权限不会突然变大。
 */
export type SecretaryTakeoverScope =
  | { mode: 'explicit' }
  | { mode: 'projects'; projectIds: string[] }
  | { mode: 'all' };

export interface SecretaryProfile {
  version: 1;
  name: string;
  avatar: { color: string; imageVersion?: number };
  model?: ModelRef & { thinkingLevel?: ThinkingLevel };
  autonomy: SecretaryAutonomy;
  autoApproveProjectIds: string[];
  /** 不用逐个授权就能发消息、停止会话的项目范围 */
  takeoverScope: SecretaryTakeoverScope;
  /** 勾选给秘书用的 Enso 插件 id；插件停用或卸载后自动失效，不改写档案 */
  pluginIds?: string[];
  /** 勾选给秘书用的全局 Enso skill id；未勾选的不加载 */
  skillIds?: string[];
  visibleProjectIds: 'all' | string[];
  dispatchModel:
    | { mode: 'project' }
    | { mode: 'fixed'; model: ModelRef }
    | { mode: 'choose'; candidates: ModelRef[] };
  dispatchWorktree: 'never' | 'auto' | 'always';
  maxRunningDispatches: number;
  /** 新派出的会话默认静音：不弹系统通知、不推送、不计角标 */
  dispatchMuted: boolean;
  /** 新派出的会话默认无人值守：需要人确认的动作直接按「没人可批准」拒绝 */
  dispatchUnattended: boolean;
  addressAs?: string;
  replyLanguage: 'ui' | 'zh' | 'en';
  style: 'concise' | 'detailed';
  notify: 'needs-user' | 'with-done' | 'off';
  dailyBriefAt?: string;
  /** 同一会话的普通回传合并窗口，毫秒。缺省 45 秒；可配 1–60 秒 */
  updateWindowMs?: number;
  updatedAt: number;
}

/**
 * 表单与配置提案共用的写入草案：只带要改的字段，`null` 表示清掉该可选字段。
 * 人设文字不落 profile.json，随草案一起传，由 Main 写 persona.md。
 */
export type SecretaryProfileDraft = Partial<
  Omit<
    SecretaryProfile,
    'version' | 'updatedAt' | 'model' | 'addressAs' | 'dailyBriefAt' | 'avatar'
  >
> & {
  avatar?: Partial<SecretaryProfile['avatar']>;
  model?: SecretaryProfile['model'] | null;
  addressAs?: string | null;
  dailyBriefAt?: string | null;
  persona?: string;
};

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

/** 秘书申请接管一个不是它派出的会话；title 是提案时的快照，只给卡片显示 */
export interface TakeoverDraft {
  conversationId: string;
  projectId: string;
  title?: string;
  reason?: string;
}

/** 接管授权的来源：确认卡、用户在会话界面上亲手点的，或项目在接管范围内被秘书实际用上 */
export type TakeoverVia = 'proposal' | 'user' | 'scope';

/** 秘书自有的 skill：name 即目录名，整份内容写进该目录的 SKILL.md */
export interface SecretarySkillDraft {
  name: string;
  description: string;
  body: string;
}

export type SecretaryToolRuntime = 'python' | 'node';

/** 秘书自造的常用工具：name 即目录名，tool.json 存元数据，脚本固定叫 main.py / main.mjs */
export interface SecretaryToolDraft {
  name: string;
  description: string;
  runtime: SecretaryToolRuntime;
  /** 工具参数的 JSON Schema，必须是 object */
  parameters: Record<string, unknown>;
  readOnly: boolean;
  timeoutSec?: number;
  code: string;
}

/** 随 spawn 下发给 worker 的工具描述符；name 是 worker 里的工具名（my_*） */
export interface SecretaryToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
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
  | { kind: 'profile'; draft: SecretaryProfileDraft }
  /** previous 是同名 skill 的旧内容，卡片据此标成更新 */
  | {
      kind: 'skill';
      draft: SecretarySkillDraft;
      previous?: { description: string; body: string };
    }
  /** previous 是同名工具的旧草案，卡片据此标成更新并摊开旧代码 */
  | { kind: 'tool'; draft: SecretaryToolDraft; previous?: SecretaryToolDraft }
  | { kind: 'takeover'; draft: TakeoverDraft }
);

export type SecretaryResultKind =
  | 'goal-complete'
  | 'goal-blocked'
  | 'turn-ended'
  | 'needs-user'
  | 'failed'
  | 'stalled'
  | 'interrupted';

/** 需要用户亲自看一眼的结果；其余结果只是记录，不占工作台的「需要你处理」 */
export const NEEDS_YOU_RESULTS: ReadonlySet<SecretaryResultKind> = new Set([
  'failed',
  'needs-user',
]);

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
  /** 心跳：派出会话每个事件都刷新，只用于判断卡住，不能当动态时间 */
  lastEventAt: number;
  /** 还有没结束的后台任务。实时状态是空闲时仍算在跑 */
  backgroundRunning?: boolean;
  /** lastState 变成当前值的时间；旧记录没有，读时按派出或结果时间估 */
  stateSince?: number;
  /** 最后一轮的助手正文，工作台显示"最后说了什么" */
  lastText?: string;
  /** 已报 stalled 的轮次，一轮只报一次 */
  stalledTurn?: number;
  /** dismissed：用户点过「知道了」；新结果整体替换 lastResult，标记随之失效 */
  lastResult?: { kind: SecretaryResultKind; turn: number; at: number; dismissed?: true };
  /**
   * 接管来的会话：权限与推送同派出会话，可撤销；不计入派出上限。
   * via=scope 表示项目在接管范围内、秘书实际用过它之后才建的跟踪记录。
   */
  takeover?: { grantedAt: number; via: TakeoverVia };
}

export type SecretaryUpdate = {
  key: string;
  at: number;
  text: string;
  /** 最后一轮正文：投递前脱敏并包成不可信内容 */
  lastText?: string;
  secretaryConversationId?: string;
  /** 非紧急更新到这个时间再投；缺省表示可以立刻投 */
  deliverAt?: number;
} & (
  | { kind: SecretaryResultKind; conversationId: string }
  | { kind: 'proposal'; proposalId: string; status: ProposalStatus }
  | { kind: 'schedule'; scheduleId: string }
);

/** 右侧动态的一条历史：压掉、合并和静默处理的更新都留在这里 */
export interface SecretaryActivity {
  at: number;
  conversationId: string;
  kind: SecretaryResultKind | 'seen';
  text: string;
}

export interface SecretaryDispatchFile {
  version: 1;
  dispatched: Record<string, DispatchRecord>;
  named: string[];
  proposals: Record<string, SecretaryProposal>;
  outbox: SecretaryUpdate[];
  /** 按时间的动态，最多留最近 400 条 */
  activity?: SecretaryActivity[];
  inflight?: {
    deliveryId: string;
    secretaryConversationId: string;
    keys: string[];
    /** 1..6 */
    attempt: number;
    nextAttemptAt: number;
    /** 到点且会话刚变空闲时，留给紧随其后的 turn-completed 的窗口；过了才当结束事件丢失重投 */
    idleGraceUntil?: number;
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
  /** 关联会话失败、被停止或已删除；用户放回待办或重新派发后清掉 */
  problem?: TodoProblemCode;
}

export const TODO_PROBLEM_CODES = ['failed', 'stopped', 'deleted'] as const;

export type TodoProblemCode = (typeof TODO_PROBLEM_CODES)[number];

/** 工作台投影。done 不进看板，只出现在 todo_list */
export type SecretaryTodoPhase = 'todo' | 'active' | 'problem';

export interface SecretaryBoardTodo extends SecretaryTodo {
  phase?: SecretaryTodoPhase;
  projectName?: string;
  sessionTitle?: string;
  sessionState?: 'running' | 'idle' | 'waiting' | 'error' | 'not-started' | 'gone';
}

/** 界面对待办的操作；dispatch 是用户亲手点出，不再走自主度确认 */
export type SecretaryTodoMutate =
  | { action: 'add'; text: string; dueAt?: number; projectId?: string }
  | { action: 'update'; todoId: string; text?: string; dueAt?: number | null; done?: boolean }
  | { action: 'remove'; todoId: string }
  | { action: 'reopen'; todoId: string }
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

/** 设置页与工具共用的定时投影：下一次触发时间由 Main 算 */
export interface SecretaryScheduleView {
  id: string;
  name: string;
  prompt: string;
  at?: string;
  cron?: string;
  nextRunAt?: number;
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
      /** 派出时间 */
      startedAt: number;
      /** 当前状态开始的时间：「开始执行」显示它，不随会话活动刷新 */
      stateSince: number;
      result?: SecretaryResultKind;
      /** 与 result 同时出现：结果发生的时间 */
      resultAt?: number;
      /** 会话不在跑，但目标还要续或还在等后台任务。动态不能再显示上一轮的完成 */
      continuing?: true;
      /** 会话空闲但还有没结束的后台任务：进行中列表要把它和续跑区分开 */
      backgroundRunning?: true;
      secretaryConversationId: string;
      unread?: boolean;
      takeover?: true;
    }
  | { kind: 'proposal'; proposal: SecretaryProposal; projectName?: string };

export interface SecretaryBoard {
  needsYou: SecretaryCard[];
  running: SecretaryCard[];
  todos: SecretaryBoardTodo[];
  done: SecretaryCard[];
  activity?: SecretaryActivity[];
}

/** 会话界面、侧栏与设置页共用的接管清单 */
export interface SecretaryTakeoverView {
  conversationId: string;
  projectId: string;
  projectName: string;
  title: string;
  grantedAt: number;
  via: TakeoverVia;
  secretaryConversationId: string;
}

export interface SecretaryState {
  enabled: boolean;
  projectId: string | null;
  /** null = 未完成初次设置 */
  profile: SecretaryProfile | null;
  persona: string;
  board: SecretaryBoard;
  proposals: Record<string, SecretaryProposal>;
  takeovers: SecretaryTakeoverView[];
}
