import type { ModelRef, ThinkingLevel } from './agent';

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
  /** imageHash 是当前图片字节的短指纹：URL 带上它，换图后一定换地址 */
  avatar: { color: string; imageVersion?: number; imageHash?: string };
  /** 不用逐个授权就能发消息、停止会话的项目范围 */
  takeoverScope: SecretaryTakeoverScope;
  /** 勾选给秘书用的 Enso 插件 id；插件停用或卸载后自动失效，不改写档案 */
  pluginIds?: string[];
  /** 勾选给秘书用的全局 Enso skill id；未勾选的不加载 */
  skillIds?: string[];
  /** 秘书自有 skill 里被停用的目录名：文件还在，只是不进会话 */
  disabledSkillNames?: string[];
  visibleProjectIds: 'all' | string[];
  maxRunningDispatches: number;
  /** 自动巡检：有进行中的会话时按默认间隔检查、每小时扫一次遗留后台任务，只在发现异常时推一条 */
  patrolEnabled: boolean;
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
  Omit<SecretaryProfile, 'version' | 'updatedAt' | 'addressAs' | 'dailyBriefAt' | 'avatar'>
> & {
  avatar?: Partial<SecretaryProfile['avatar']>;
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

/**
 * 派发时用的模型：provider + model + 可选思考档位，
 * Main 在派发前按同一套可用性判定解析，解析后的值落进派发记录，卡片据此显示。
 */
export type DispatchModelRef = ModelRef & { thinkingLevel?: ThinkingLevel };

export interface DispatchDraft {
  projectId: string;
  prompt: string;
  title?: string;
  goal?: string;
  model?: DispatchModelRef;
  worktree: boolean;
  todoId?: string;
  /** 基线：从项目的哪个现有检出、哪个 ref 起新分支。只在 worktree 为真时生效 */
  checkout?: string;
  baseRef?: string;
  branch?: string;
  /** 先后依赖：这些会话都真正结束后才开始；不建会话、不占派出上限 */
  after?: string[];
}

/** 派发基线：三项都要在派发前校验，卡片与简报显示实际用到的值 */
export interface DispatchBase {
  checkout?: string;
  baseRef?: string;
  branch?: string;
}

/** 等待依赖的派发停在「出问题」的原因；cancelled 是秘书或用户主动取消 */
export type PendingProblem =
  | 'dependency-failed'
  | 'dependency-stopped'
  | 'dependency-deleted'
  | 'dispatch-failed'
  | 'cancelled';

/**
 * 带 after 的派发先停在这里：不建会话、不占派出上限，等依赖真正结束再开始。
 * 落盘在 dispatch.json，应用重启后仍在。
 */
export interface PendingDispatch {
  id: string;
  projectId: string;
  secretaryConversationId: string;
  createdAt: number;
  updatedAt: number;
  status: 'waiting' | 'failed';
  after: string[];
  draft: DispatchDraft;
  problem?: PendingProblem;
  /** 触发失败的依赖会话；dispatch-failed 时缺省 */
  failedDependency?: string;
}

/**
 * 自动巡检的异常类型：同一会话同一次停住只推一次，恢复后清除。
 * goal-idle-stalled：goal 会话空闲、没有后台任务、最后一条不是完成汇报（默认 3 分钟）；
 * idle-stalled：空闲 20 分钟兜底（典型是后台任务卡住）；running-stalled：运行 30 分钟没有事件。
 */
export const PATROL_REASONS = ['goal-idle-stalled', 'idle-stalled', 'running-stalled'] as const;

export type PatrolReason = (typeof PATROL_REASONS)[number];

/** 秘书申请接管一个不是它派出的会话；title 是提案时的快照，只给卡片显示 */
export interface TakeoverDraft {
  conversationId: string;
  projectId: string;
  title?: string;
  reason?: string;
}

/** 收尾清理能处理的三类东西：本地分支、会话 worktree、已完成的派发会话 */
export const CLEANUP_ITEM_KINDS = ['branch', 'worktree', 'session'] as const;

export type CleanupItemKind = (typeof CLEANUP_ITEM_KINDS)[number];

/**
 * 一条可清理项。id 由类型与名字拼成，cleanup_apply 只认 cleanup_list 原样给出的 id；
 * blocked 有值表示这次不能动（未合入、在用、有未提交改动），原因直接给模型看。
 */
export interface CleanupItem {
  id: string;
  kind: CleanupItemKind;
  /** 分支名 / worktree 路径 / 会话标题 */
  name: string;
  projectId?: string;
  /** 分支与 worktree 所属仓库的检出目录 */
  repoPath?: string;
  /** worktree 的绝对路径 */
  path?: string;
  /** 已经合入的基线分支 */
  mergedInto?: string[];
  /** 分支或 worktree 的最后提交时间，会话的最后活动时间 */
  lastActivityAt?: number;
  /** worktree 的 du 估算（字节） */
  sizeBytes?: number;
  blocked?: string;
}

/** 清理确认卡的草案：确认前只读，确认后按 id 重新校验再执行 */
export interface CleanupDraft {
  items: CleanupItem[];
}

/**
 * cleanup_list 精简模式的一条：只有 id、名字与大小。
 * 秘书没有 read/grep，正文一大就会被外置成 artifact 读不到，所以默认只给这么多。
 */
export interface CleanupSummaryItem {
  id: string;
  kind: CleanupItemKind;
  name: string;
  sizeBytes?: number;
  /** 不能清理时的短原因码；带它的 id 传给 cleanup_apply 会被拒 */
  blocked?: string;
}

/** cleanup_list 的默认返回：数量摘要 + 每类前几条，正文控制在两千字以内 */
export interface CleanupListSummary {
  mode: 'summary';
  total: number;
  counts: Record<CleanupItemKind, number>;
  /** 可以直接传给 cleanup_apply 的条数 */
  cleanable: number;
  /** 可清理 worktree 的占用总和；分支与会话不计 */
  estimatedBytes: number;
  items: CleanupSummaryItem[];
  hint: string;
  /** 到期限还没读完、这次没列进来的仓库 */
  incomplete?: string[];
  /** 占用还在后台计算的 worktree 数，稍后再列就有 */
  sizesPending?: number;
  warnings?: string[];
}

/** cleanup_list 传 detail: true 时返回的一页完整清单，正文控制在四千字以内 */
export interface CleanupListDetail {
  mode: 'detail';
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  items: CleanupItem[];
  incomplete?: string[];
  sizesPending?: number;
  warnings?: string[];
}

/** 接管授权的来源：确认卡、用户在会话界面上亲手点的，或项目在接管范围内被秘书实际用上 */
export type TakeoverVia = 'proposal' | 'user' | 'scope';

/** 秘书自有的 skill：name 即目录名，整份内容写进该目录的 SKILL.md */
export interface SecretarySkillDraft {
  name: string;
  description: string;
  body: string;
}

/**
 * 设置页与右侧面板共用的 skill 视图：own 是秘书自己目录下的，global 是设置里勾给秘书的。
 * 正文只给用户看，不进秘书的指令。
 */
export interface SecretarySkillView {
  /** own 是目录名，global 是设置里的 skill id */
  id: string;
  name: string;
  description: string;
  source: 'own' | 'global';
  enabled: boolean;
  /** own 的正文随列表一起给；global 展开时再读 */
  body?: string;
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
  /** 执行结果摘要：清理这类一次动很多条的动作要把结果原样告诉秘书 */
  report?: string;
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
  | { kind: 'cleanup'; draft: CleanupDraft }
);

export type SecretaryResultKind =
  | 'goal-complete'
  | 'goal-blocked'
  | 'turn-ended'
  | 'needs-user'
  | 'failed'
  | 'stalled'
  | 'interrupted';

/** 转交提问的收尾方式：秘书代答、用户在原会话里直接答、超时兜底 */
export const RELAY_ASK_STATUSES = ['pending', 'answered', 'user-answered', 'timed-out'] as const;

export type RelayAskStatus = (typeof RELAY_ASK_STATUSES)[number];

/**
 * 派出/接管会话里 ask_user 的提问先送到秘书：秘书用 session_answer 代答，
 * 决定不了就用它自己的 ask_user 问用户。用户在原会话里直接答也算收尾，谁先答算谁的。
 */
export interface SecretaryRelayAsk {
  conversationId: string;
  askId: string;
  question: string;
  options?: string[];
  defaultOption?: string;
  /** 到点没回答就按默认值处理；没有默认值按无人值守拒绝 */
  expiresAt?: number;
  at: number;
  status: RelayAskStatus;
  /** 收尾的答案：秘书代答或用户直接答 */
  answer?: string;
  answeredAt?: number;
}

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
  /** 还有常驻服务（dev server、http.server、--watch）在跑：不算在跑，卡片单独标出来 */
  backgroundPersistent?: boolean;
  /**
   * 会话已经收口/空闲，但还有没结束的后台任务：看板显示「已完成（有遗留任务）」，
   * 并给一个停止遗留任务的行内操作。由 Main 的 tick 按任务表重算。
   */
  leftoverTasks?: { count: number; commands: string[]; taskIds: string[]; at: number };
  /** 已经推过遗留巡检的这批任务：同一批只推一次，任务变了才再推 */
  leftoverPatrol?: { taskIds: string; at: number };
  /** lastState 变成当前值的时间；旧记录没有，读时按派出或结果时间估 */
  stateSince?: number;
  /** 最后一轮的助手正文，工作台显示"最后说了什么" */
  lastText?: string;
  /** 已报 stalled 的轮次，一轮只报一次 */
  stalledTurn?: number;
  /** dismissed：用户点过「知道了」；新结果整体替换 lastResult，标记随之失效 */
  lastResult?: {
    kind: SecretaryResultKind;
    turn: number;
    at: number;
    dismissed?: true;
    /** 用户手动标记完成：卡片给「撤销标记」，新结果整体替换后自然失效 */
    manual?: true;
  };
  /**
   * 已有终态结果后被 session_send 重新唤起的时间：这一轮还没结束，仍算在跑。
   * 轮次一结束就清掉，会话真正空闲时回到原来的终态。
   */
  reopenedAt?: number;
  /** 用户撤销手动标记的时间：放回进行中，直到这一轮出现新结果 */
  manualUndoneAt?: number;
  /**
   * 接管来的会话：权限与推送同派出会话，可撤销；不计入派出上限。
   * via=scope 表示项目在接管范围内、秘书实际用过它之后才建的跟踪记录。
   */
  takeover?: { grantedAt: number; via: TakeoverVia };
  /** 派发时实际用到的基线：卡片显示分支与基准 */
  checkout?: string;
  baseRef?: string;
  branch?: string;
  /** 派发时实际用到的模型：卡片显示，缺省表示跟随项目默认模型 */
  model?: DispatchModelRef;
  /** 秘书停止的时间：after 依赖据此判定「被停止」 */
  stoppedAt?: number;
  /**
   * 用户从看板上移出：记录与会话都还在，只是不再上看板。
   * 新结果、重新派出或手动标记完成都会清掉它。
   */
  dismissedFromBoard?: true;
  /** 已经报过的巡检异常：同一会话同一原因只推一次，恢复后清除 */
  patrol?: { reason: PatrolReason; turn: number; at: number };
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
  /** 转交给秘书的提问：pending 要秘书处理，其余是收尾通知 */
  | { kind: 'ask-relay'; conversationId: string; askId: string; status: RelayAskStatus }
  /** 遗留任务巡检：说明哪个会话、什么命令、跑了多久；不自动杀进程 */
  | { kind: 'leftover'; conversationId: string }
  | { kind: 'proposal'; proposalId: string; status: ProposalStatus }
  | { kind: 'schedule'; scheduleId: string }
  | {
      kind: 'pending';
      pendingId: string;
      status: PendingDispatch['status'];
      problem?: PendingProblem;
    }
  /** 另一个秘书发来的话：chain/hop 由 Main 判定，origins 是链上全部发起方（降权回合取交集用） */
  | {
      kind: 'peer-message';
      fromSecretaryId: string;
      fromName: string;
      chain: string;
      hop: number;
      origins: string[];
    }
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
  /** 转交给秘书的提问；key 是 `${conversationId}|${askId}` */
  relays?: Record<string, SecretaryRelayAsk>;
  /** 等依赖的派发；开始或出问题后从这里移走 */
  pending?: Record<string, PendingDispatch>;
  named: string[];
  /**
   * 用户点过 × 收回的会话：范围权限不再自动覆盖它们，只能靠确认卡重新逐个授权。
   * 只缩小权限，不会让秘书多管一个会话。
   */
  untracked?: string[];
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
  /** 另一个秘书经 secretary_message 托付的：完成或出问题时自动回告它 */
  from?: { secretaryId: string; name: string };
  /** 已经回告过发起秘书的终态：同一个终态只回告一次 */
  reportedAs?: 'done' | TodoProblemCode;
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

/** 界面对待办的操作；dispatch 是用户亲手点出，直接派发 */
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

/** 侧栏、设置页与新建流程用的秘书清单：只带认人的字段，完整状态另取 */
export interface SecretarySummary {
  id: string;
  projectId: string | null;
  name: string | null;
  avatar: SecretaryProfile['avatar'] | null;
  order: number;
}

/** 删除秘书前的提醒：列出它正在管的东西，二次确认后才删 */
export interface SecretaryDeletePreview {
  secretaryId: string;
  name: string | null;
  sessions: { conversationId: string; title: string; projectName: string; takeover: boolean }[];
  todos: { id: string; text: string }[];
  schedules: { id: string; name: string }[];
  contacts: string[];
  memories: number;
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
      /** 会话空闲但还有常驻服务在跑：显示成「有常驻服务」，与「正在跑」区分 */
      backgroundPersistent?: true;
      /** 巡检判定停住：进行中列表标「已停住」，会话有了新活动就消失 */
      stalled?: { reason: PatrolReason; at: number };
      /** 已收口但还有没结束的后台任务：完成列显示「已完成（有遗留任务）」 */
      leftoverTasks?: { count: number };
      /** 用户手动标记完成：完成列的卡片据此给「撤销标记」 */
      manual?: true;
      secretaryConversationId: string;
      unread?: boolean;
      takeover?: true;
      /** 派发时实际用到的基线 */
      checkout?: string;
      baseRef?: string;
      branch?: string;
      /** 派发时实际用到的模型 */
      model?: DispatchModelRef;
    }
  /** 等依赖的派发：等待中在进行中，出问题在需要你处理 */
  | { kind: 'pending'; pending: PendingDispatch; projectName: string }
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

/** 用户收回跟踪后进「不再跟踪」名单的会话，设置页可移除 */
export interface SecretaryUntrackedView {
  conversationId: string;
  projectId: string;
  projectName: string;
  title: string;
}

export interface SecretaryState {
  /** 这份状态属于哪个秘书；关闭开关时的空状态与旧数据缺省 */
  secretaryId?: string | null;
  enabled: boolean;
  projectId: string | null;
  /** null = 未完成初次设置 */
  profile: SecretaryProfile | null;
  persona: string;
  board: SecretaryBoard;
  proposals: Record<string, SecretaryProposal>;
  takeovers: SecretaryTakeoverView[];
  /** 定时清单的指纹：定时增删、触发都会变，状态推送按内容去重时面板才收得到 */
  schedulesRev?: string;
}

/**
 * 按天汇总的一条结果记录，追加写在 userData/secretary/daily.jsonl。
 * activity 只留 400 条、又是 dispatch.json 的一部分，回看历史某天靠不住，所以另存一份。
 */
export interface SecretaryDailyRecord {
  at: number;
  conversationId: string;
  kind: SecretaryResultKind;
  projectId?: string;
  /** 结果发生时的会话标题快照：会话删掉后仍能显示 */
  title?: string;
  /** 最后一轮正文，与工作台同一口径截断 */
  text?: string;
  /** 从最终汇报里认出来的分支与提交号；认不出就不写 */
  branch?: string;
  commit?: string;
  /** 最终汇报里明确说了合并 */
  merged?: true;
}

/** 派发/接管会话按当天最终状态落一列；待办与设置变更是另外两类记录 */
export type SecretaryDailyGroupKey =
  | 'done'
  | 'failed'
  | 'needsYou'
  | 'running'
  | 'stopped'
  | 'todos'
  | 'changes';

/** 看板一行。title/label 是数据与 i18n key，renderer 只负责排版 */
export interface SecretaryDailyItem {
  id: string;
  /** 状态时间：终态结果的时间；还在跑的卡片是派出时间 */
  at: number;
  title: string;
  projectName?: string;
  /** 状态小徽标的 i18n key */
  label?: string;
  /** 一句话摘要，列表里一行 */
  summary?: string;
  /** 展开后的全文 */
  detail?: string;
  branch?: string;
  commit?: string;
  /** 派出时间；派发/接管会话的卡片才有 */
  dispatchedAt?: number;
  /** 待办新增时间：只有待办卡片有 */
  addedAt?: number;
  /** 待办完成时间：只有待办卡片有，有值表示这条待办已完成 */
  doneAt?: number;
  conversationId?: string;
  /** 有派发或接管记录：只有这类会话才给「标记完成」 */
  tracked?: true;
  /** 用户手动标记完成：完成列的卡片据此给「撤销标记」 */
  manual?: true;
  /** 已完成但还有没结束的后台任务：卡片显示「已完成（有遗留任务）」并给停止操作 */
  leftover?: { count: number };
  /** 还在跑但带着常驻服务：卡片标「有常驻服务」，与「正在跑」区分 */
  persistent?: true;
}

export interface SecretaryDailyCounts {
  dispatched: number;
  completed: number;
  failed: number;
  needsYou: number;
  todosDone: number;
  merged: number;
}

export interface SecretaryDailyGroup {
  key: SecretaryDailyGroupKey;
  items: SecretaryDailyItem[];
}

/** 看板一天的投影，由 Main 从派发记录、结果记录、审计与待办算出 */
export interface SecretaryDaily {
  /** 本地时区的 YYYY-MM-DD */
  day: string;
  today: boolean;
  counts: SecretaryDailyCounts;
  /** 只放有内容的分组 */
  groups: SecretaryDailyGroup[];
  /** 有记录的最早一天；没有记录时缺省 */
  earliest?: string;
  /** 结果记录的保留天数，界面据此说明能回看多久 */
  retentionDays: number;
}

/**
 * 联系方式：秘书不在电脑前时，把里程碑与提问推到手机上，也能从手机回话。
 * 第一个渠道是 Telegram Bot；state 里不含 token，只留前几位提示。
 */
export type SecretaryContactStatus = 'unbound' | 'awaiting-start' | 'bound';

export type SecretaryContactPollState = 'stopped' | 'starting' | 'running' | 'backoff' | 'error';

export interface SecretaryContactBot {
  id: number;
  username: string;
  name: string;
}

export interface SecretaryContactChat {
  id: number;
  username?: string;
  name?: string;
}

/** 手机关注的任务：手机发起的回合里派生出来的会话或定时 */
export type SecretaryFollowKind = 'session' | 'schedule';

export interface SecretaryFollowingView {
  /** kind:targetId */
  id: string;
  kind: SecretaryFollowKind;
  /** 原始需求一句话摘要：推送与列表都用它认出是哪件事 */
  summary: string;
  at: number;
}

export interface SecretaryContactBind {
  /** 一次性绑定码：/start <code> 或 https://t.me/<username>?start=<code> */
  code: string;
  /** 手机上点一下就完成的深链 */
  link: string;
  /** 把 bot 拉进群并绑整个群的深链（?startgroup=） */
  groupLink?: string;
  /** 在 forum 话题里发的绑定命令（/bind@bot <code>） */
  topicCommand?: string;
  expiresAt: number;
  /** 最近一次发码没绑上的原因：界面据此给出下一步，而不是一直等 */
  rejected?: SecretaryContactBindRejection;
}

export interface SecretaryContactBindRejection {
  /**
   * private-owned：这个私聊已归同一个 bot 上的别的秘书；route-conflict：群或话题已归别的秘书；
   * expired：码过期；missing-code：私聊里只发了不带码的 /start
   */
  reason: 'private-owned' | 'route-conflict' | 'expired' | 'missing-code';
  /** 占着这条路由的秘书名 */
  owner?: string;
}

/** 共用同一个 bot 的一个秘书，以及它认领的私聊、群和话题 */
export interface SecretaryContactBotUser {
  secretaryId: string;
  name: string;
  /** 就是当前这个秘书 */
  self: boolean;
  /** Telegram 渠道开着；关着时认领的路由仍然占着，但不收发 */
  enabled: boolean;
  privateChat?: SecretaryContactChat;
  groups: SecretaryContactGroupBinding[];
}

export interface SecretaryContactTelegram {
  status: SecretaryContactStatus;
  bot?: SecretaryContactBot;
  chat?: SecretaryContactChat;
  boundAt?: number;
  /** 只在等待 /start 时给界面 */
  bind?: SecretaryContactBind;
  /** token 前几位，界面上只显示这么点 */
  tokenHint?: string;
  /**
   * 默认关闭：确认卡不允许从手机确认。打开后覆盖派发、设置、技能、工具与接管；
   * 审批永远不在手机上确认。
   */
  allowCardConfirm: boolean;
  /** 默认关闭：记忆标题不往 Telegram 发（消息会留在 Telegram 服务器上） */
  allowMemory: boolean;
  /**
   * 默认关闭：只发里程碑。打开后秘书会话每一轮回复都镜像到手机，
   * 静默回合只发一行摘要；解绑或换 bot 时自动关掉。
   */
  syncMirror: boolean;
  /**
   * 交给这个秘书的群：白名单与路由表按群合并，只认绑定的那个人。见过的群带标题。
   * all 是整群（General 与所有话题）；否则只收 topics 里这几个论坛话题。
   */
  groups: SecretaryContactGroupBinding[];
  /** 用绑定码绑的群与话题：这个秘书从这里收，也往这里推 */
  routes?: { chatId: string; topicId?: string; title?: string }[];
  /** 同一个 bot 还被别的秘书用着时才有：每个秘书（含自己）认领了什么 */
  shared?: SecretaryContactBotUser[];
  /**
   * 手机关注的任务：手机发起的回合里派生的会话与定时，结果会一直推到手机上，
   * 与 /sync 无关。完成或失败推过一次就从列表里移除。
   */
  following: SecretaryFollowingView[];
  poll: { state: SecretaryContactPollState; lastError?: string };
  /** safeStorage 是否可用：不可用时 token 明文落盘，界面要提示 */
  secure: boolean;
}

export interface SecretaryContactTopic {
  /** 论坛话题 id；General 约定为 '1' */
  id: string;
  /** bot 见过的话题名；没见过建话题或改名消息就没有 */
  title?: string;
  /** 同一个 bot 上已经单独认领这个话题的别的秘书 */
  owner?: string;
}

export interface SecretaryContactGroupBinding {
  id: string;
  title?: string;
  all: boolean;
  topics: SecretaryContactTopic[];
}

/** 设置页拉一个群的话题：forum=false 表示没开话题，只能整群绑定 */
export type SecretaryContactTopicsResult =
  | { ok: true; forum: boolean; title?: string; topics: SecretaryContactTopic[] }
  | { ok: false; error: string; detail?: string };

export interface SecretaryContactState {
  /** 这份联系方式属于哪个秘书：每个秘书只用自己绑定的渠道 */
  secretaryId?: string;
  /** 总开关：关掉后不收不发，界面也不画渠道列表 */
  enabled: boolean;
  /** 渠道卡片：Telegram 内置固定第一位，插件渠道跟在后面 */
  channels: SecretaryContactChannelView[];
  telegram: SecretaryContactTelegram;
}

export type SecretaryContactChannelStatus = 'unconfigured' | 'pending' | 'connected' | 'error';

/** 渠道能力：不支持的能力界面不画成能用，核心按它降级 */
export interface SecretaryContactCaps {
  buttons: boolean;
  urlButtons: boolean;
  edit: boolean;
  typing: boolean;
  format: 'html' | 'markdown' | 'plain';
  maxChars: number;
  commandMenu: boolean;
  /** 能发图片；false 时核心降级成一句文字说明 */
  images: boolean;
  /** 能发文件；false 时同上 */
  files: boolean;
}

/** 每个渠道的通用开关：宿主统一画，存在 contact.json */
export interface SecretaryContactChannelPrefs {
  enabled: boolean;
  /** 里程碑、提问、确认卡、审批往这个渠道主动推 */
  push: boolean;
  /** 手机上直接确认卡片；审批永远不行 */
  cardConfirm: boolean;
  /** 秘书每一轮回复都镜像过去 */
  syncMirror: boolean;
  /** 允许发记忆标题 */
  memory: boolean;
}

export interface SecretaryContactChannelView {
  id: string;
  title: string;
  builtin: boolean;
  pluginId?: string;
  /** 插件内图标相对路径 */
  icon?: string;
  /** 插件内登录页相对路径 */
  settingsView?: string;
  status: SecretaryContactChannelStatus;
  detail?: string;
  caps: SecretaryContactCaps;
  prefs: SecretaryContactChannelPrefs;
}
