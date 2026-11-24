import { randomUUID } from 'node:crypto';
import type { SessionReminder } from '@shared/reminders';
import {
  describeForwardedImages,
  type ForwardedImage,
  forwardedMessage,
  type LoadedImage,
  type UnavailableImage,
} from '@shared/secretary/attachments';
import { type FeedPage, type FeedQuery, feedEvents, pageFeed } from '@shared/secretary/feed';
import {
  answerGoalResultNeedsUser,
  escalateGoalResultNeedsUser,
  type GoalResultView,
  hasNeedsUser,
  needsUserItems,
  shownNeedsUser,
  stripGoalResultNeedsUser,
} from '@shared/secretary/goalResult';
import { probeImageView, readImageView } from '@shared/secretary/imageView';
import { parseProfile, RELAY_ASK_MAX_CHARS } from '@shared/secretary/parse';
import { type DependencyFacts, pendingOutcome } from '@shared/secretary/pending';
import {
  canOperate,
  type DispatchBaseFacts,
  type DispatchLimit,
  inTakeoverScope,
  isUntracked,
  type OperateSource,
  operateSource,
  type TakeoverRefusal,
  takeoverRefusal,
  transitionProposal,
  validateDispatch,
  validateDispatchBase,
} from '@shared/secretary/policy';
import { queuedCount, queuedStartOf, queuePositions } from '@shared/secretary/queuedSession';
import {
  SECRETARY_ATTACHMENT_MAX,
  SECRETARY_ATTACHMENT_PATH_MAX,
  SECRETARY_ID_MAX,
  SECRETARY_SEND_MODES,
  SECRETARY_SESSION_MESSAGE_MAX,
  type SecretarySendMode,
} from '@shared/secretary/tools';
import { wrapUntrusted } from '@shared/secretary/transcript';
import type {
  AgentRunProgress,
  AskRelatesTo,
  AttachedImage,
  ConversationAuthority,
  ProjectAuthority,
  ThinkingLevel,
} from '@shared/types/agent';
import { THINKING_LEVELS } from '@shared/types/agentConstants';
import {
  type CleanupItem,
  type ClosedGoal,
  type DispatchDraft,
  type DispatchModelRef,
  type DispatchRecord,
  NEEDS_YOU_RESULTS,
  type PendingDispatch,
  type PendingProblem,
  REPLACEABLE_GOAL_STATUSES,
  type SecretaryAuditEntry,
  type SecretaryBoard,
  type SecretaryDailyRecord,
  type SecretaryDemandThreadView,
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
  type SecretaryUntrackedView,
  type TakeoverVia,
} from '@shared/types/secretary';
import { classifyUpstreamError, nextPendingRetryDelayMs } from '@shared/upstreamRecovery';
import type { ObservedTask } from '../backgroundTaskTracker';
import { redactSecrets } from '../memory/distill';
import { appendAudit } from './audit';
import { archivedBySecretary } from './autoArchive';
import { applyCleanup, type CleanupPorts, cleanupReportText, realCleanupPorts } from './cleanup';
import { appendDailyRecord } from './dailyLog';
import { todoDispatchPrompt } from './dispatchBrief';
import {
  followDepsFor,
  recordPhoneFollow,
  renameFollowedTarget,
  unfollowTarget,
} from './following';
import { realImageViewDeps } from './imageView';
import { projectAliasesFromSettings, secretaryProjectName } from './projectLabel';
import { type SavedProposal, saveProposalRecord } from './proposals';
import { type SecretarySessionStatus, visibleProjects } from './readers';
import { closeRelayAsk, dropRelaysFor, pendingRelay, relayKey, sessionLabel } from './relay';
import {
  buildBoard,
  countsAsRunning,
  enqueueUpdate,
  linkedTodoSession,
  pendingUpdate,
  proposalUpdate,
  SETTLED_RESULTS,
  secretaryLiveIn,
  takeoverViews,
  untrackedViews,
} from './results';
import type { SecretaryContext } from './secretaries';
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

/** 停止后等 worker 确认的上限：超过就如实返回 running */
export const STOP_CONFIRM_TIMEOUT_MS = 10_000;

/** 一次派发最多等几个依赖 */
export const MAX_DISPATCH_DEPENDENCIES = 10;

/** 一次最多归档几个会话：和看板批量操作同一个量级 */
export const MAX_ARCHIVE_IDS = 20;

/** 归档一条会话的结果：skipped 是前置条件不满足，failed 是写盘出错 */
export type ArchiveStatus = 'archived' | 'unarchived' | 'skipped' | 'failed';

export interface ArchiveOutcome {
  conversationId: string;
  status: ArchiveStatus;
  reason?: string;
}

/** 归档被拒的原因码，模型看到的是可读说明 */
const ARCHIVE_REFUSALS: Record<string, string> = {
  'not-operable':
    'skipped (not-operable): only sessions you dispatched or already track can be archived; this one is not yours to tidy up',
  'not-found': 'skipped (not-found): no such session, it may already be deleted',
  'already-archived': 'skipped (already-archived): this session is already in the archived list',
  'not-terminal':
    'skipped (not-terminal): the session has no finished result yet (goal-complete, failed or interrupted); wait for it to finish',
  running:
    'skipped (running): the session is still running or still has an unfinished background task; stop it first with session_stop or session_task_stop',
  'needs-user':
    'skipped (needs-user): the session is waiting for the user to answer a question or approve a tool call',
};

/** 取消归档被拒的原因码，模型看到的是可读说明 */
const UNARCHIVE_REFUSALS: Record<string, string> = {
  'not-operable':
    'skipped (not-operable): only sessions you dispatched or already track can be unarchived; this one is not yours',
  'not-found': 'skipped (not-found): no such session, it may already be deleted',
  'not-visible':
    "skipped (not-visible): the session's project is not in the secretary's visible projects",
  'not-archived': 'skipped (not-archived): this session is not archived',
  'archived-by-user':
    'skipped (archived-by-user): the user archived this session, or an older archive whose source cannot be told apart (both count as the user). Ask the user to unarchive it in the app; do not retry',
};

/** 手动收口被拒的原因码，模型看到的是可读说明 */
const MARK_REFUSALS: Record<string, string> = {
  'not-found':
    'refused (not-found): only a session you dispatched or track has a dispatch record to mark; this one is not yours',
  'not-manual':
    'refused (not-manual): this result was reported by the session itself, so nothing manual can be undone',
};

/** 秘书排进目标会话队列的消息：origin 标记来源，撤回与停止清队列只认自己排的 */
export interface SecretaryQueuedMessage {
  id: string;
  text: string;
  origin: 'secretary';
  /** 排队的秘书会话；撤回时要求与调用方一致 */
  by?: string;
  at: number;
  /** 模型能看图时随消息转发的图片块；与用户自己排队贴图同一个字段 */
  images?: AttachedImage[];
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
  /** 追加按天回看的结果记录（如手动标记完成）；缺省表示不落 daily.jsonl */
  recordDaily?(entry: SecretaryDailyRecord): void;
  projects(): MaybePromise<readonly ProjectAuthority[]>;
  /** projectId → 用户起的别名；缺省按无别名 */
  projectAliases?(): MaybePromise<Readonly<Record<string, string>>>;
  conversations(): MaybePromise<readonly ConversationAuthority[]>;
  rows(): MaybePromise<Record<string, Record<string, unknown>>>;
  /** 秘书功能开关：关着时 needsUser 不等筛选；缺省按开着 */
  secretaryEnabled?(): MaybePromise<boolean>;
  status(conversationId: string): MaybePromise<SecretarySessionStatus>;
  /** 主会话自身状态（不含子代理运行态）：自身空闲时直接 prompt，不必排队干等子代理结束 */
  ownStatus?(conversationId: string): MaybePromise<SecretarySessionStatus>;
  subagents?(conversationId: string): MaybePromise<readonly AgentRunProgress[]>;
  reminders?(conversationId: string): MaybePromise<readonly SessionReminder[]>;
  threads?(): MaybePromise<readonly SecretaryDemandThreadView[]>;
  createSession(request: MainSessionRequest): Promise<MainSessionResult>;
  prompt(
    conversationId: string,
    text: string,
    deliveryId: string,
    images?: AttachedImage[]
  ): MaybePromise<{ ok: boolean; error?: string }>;
  /** 恢复被释放的 worker */
  resume(conversationId: string): Promise<{ ok: boolean; error?: string }>;
  alive(conversationId: string): MaybePromise<boolean>;
  abort(conversationId: string): MaybePromise<void>;
  /** 插话：走用户自己的 steer 通道，在当前工具调用结束后投递 */
  steer(
    conversationId: string,
    text: string,
    deliveryId: string,
    images?: AttachedImage[]
  ): MaybePromise<{ ok: boolean; error?: string }>;
  /**
   * 目标会话当前模型能否看图（worker 就绪时报）；正在启动的会话等它就绪。
   * undefined 表示不知道，按不能看图处理。缺省表示一律不知道
   */
  imageInput?(conversationId: string): MaybePromise<boolean | undefined>;
  /** 追加排队消息；行不存在时返回 false */
  appendQueued(conversationId: string, message: SecretaryQueuedMessage): MaybePromise<boolean>;
  /** 按 id 从队列里删消息，返回真正删掉的条数 */
  dropQueued(conversationId: string, messageIds: readonly string[]): MaybePromise<number>;
  /** 有目标的会话被停止时置为暂停 */
  pauseGoal(conversationId: string): MaybePromise<void>;
  /**
   * 给已完成或没有目标的会话挂上新目标（与 session_create 同一种）。
   * 原来的目标状态在 replaceable 里时替换并交回旧目标；否则返回 ok:false，目标原样保留。
   * 缺省表示不支持挂目标。
   */
  attachGoal?(
    conversationId: string,
    goal: string,
    replaceable: readonly string[]
  ): MaybePromise<{ ok: boolean; error?: string; replaced?: { text: string; status: string } }>;
  /** 目标状态在 statuses 里时把它从会话行上撤下并交回；否则不动、返回 null */
  closeGoal?(conversationId: string, statuses: readonly string[]): MaybePromise<ClosedGoal | null>;
  /** 会话行上没有目标时放回收掉的目标；已有目标就不动、返回 false */
  restoreGoal?(conversationId: string, goal: ClosedGoal): MaybePromise<boolean>;
  /** 收尾清理要的 git / 目录 / 归档能力；清理提案确认时用 */
  cleanup: CleanupPorts;
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
  /** 派发基线的既成事实：checkout 归属、同仓库、ref 与分支是否存在 */
  baseFacts(input: {
    projectPath: string;
    checkout?: string;
    baseRef?: string;
    branch?: string;
  }): MaybePromise<DispatchBaseFacts>;
  /** 停止后最多等 timeoutMs 看 worker 是否真的停下；缺省只读一次状态 */
  waitStopped?(
    conversationId: string,
    timeoutMs: number
  ): Promise<'running' | 'idle' | 'waiting' | 'error'>;
  /** 撤掉驱动者的续跑与看门狗：停止后不许它再被唤醒 */
  forget?(conversationId: string): void;
  /** 代答派出/接管会话挂起的提问；by 固定是 relay，原会话据此显示「X 已回答」 */
  answer(
    conversationId: string,
    askId: string,
    answer: string,
    name: string
  ): MaybePromise<{ ok: boolean; error?: string }>;
  /** 开始/结束跟踪：把 ask_user 转给秘书，撤销时恢复成直接问用户 */
  relayAsk(conversationId: string, relay: { name: string } | null): void;
  /** 该会话的后台任务（Main 侧对 worker 事件流的投影） */
  tasks(conversationId: string): MaybePromise<readonly ObservedTask[]>;
  /** 停一个后台任务：只停这个会话自己的任务 */
  stopTask(conversationId: string, taskId: string): MaybePromise<{ ok: boolean; error?: string }>;
  /**
   * 派发模型的可用性判定：provider 存在且启用、有凭证、模型行启用（虚拟模型按目录），
   * 与子代理可选模型同一套判定。返回解析后的引用，不可用就报错，绝不静默回退。
   */
  resolveModel(
    ref: DispatchModelRef
  ): MaybePromise<{ ok: true; model: DispatchModelRef } | { ok: false; error: string }>;
  /**
   * 手机发起的回合里派生的会话记进「手机关注」：之后的结果一直推到手机上。
   * 缺省表示不记；等待中的派发与待确认的卡先记自己的 id，建出会话后由 refollow 改挂。
   */
  follow?(input: {
    targetId: string;
    summary: string;
    secretaryConversationId: string | null;
  }): void;
  /** 等待中的派发/待确认的卡变成真实会话：关注项改挂到会话上 */
  refollow?(from: string, to: string): void;
  /** 会话被归档、删除或收回接管：关注项一并移除 */
  unfollow?(targetId: string): void;
  /** 本秘书 id：派出会话的 secretaryOrigin 带上它；缺省是单测里的匿名秘书 */
  secretaryId?: string;
  /** 本秘书的隐藏项目：找「最近的秘书会话」只在它里面找；缺省按全部秘书项目 */
  secretaryProjectId?(): string | null;
  /** 另一个秘书正在管这个会话时返回它的名字；缺省表示只有这一个秘书 */
  managedElsewhere?(conversationId: string): MaybePromise<string | null>;
  /** 全部秘书合计在跑的派发数（含本秘书）与合计上限；缺省不查合计 */
  runningTotal?(): MaybePromise<{ running: number; max: number }>;
  /**
   * 取消排队会话：直接删掉这个还没开始的会话（worktree、行、权威记录），派发记录按停止处理。
   * 已开始或正在启动的拒绝。缺省表示不支持排队会话
   */
  cancelQueued?(
    conversationId: string,
    secretaryConversationId: string | null
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

const DISPATCH_OPS = [
  'session_create',
  'session_send',
  'session_queue_list',
  'session_queue_cancel',
  'session_stop',
  'session_task_stop',
  'session_archive',
  'session_unarchive',
  'result_mark_done',
  'result_mark_undo',
  'needs_user_escalate',
  'session_answer',
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
    'permission denied (not-operable): this session was not dispatched by the secretary, the user has not handed it over, and its project is not in the takeover scope. Ask the user to add the project to the takeover scope in settings, or call session_takeover_propose to request a takeover; it only takes effect after the user confirms.',
  untracked:
    'permission denied (untracked): the user took this session back, so the takeover scope no longer covers it. Do not retry: the session only becomes operable again after the user confirms a new session_takeover_propose card, or removes it from the untracked list in the secretary settings.',
  'not-found':
    'not found: no root session with this id (archived, child and secretary sessions are excluded)',
  'not-visible':
    "permission denied (not-visible): the session's project is not in the secretary's visible projects",
  'needs-user':
    'refused (needs-user): the session is waiting for the user to answer a question or approve a tool call',
  'goal-active':
    "refused (goal-active): the session's current goal is still running or waiting on something external. A goal is only attached when the session has no goal, already reported goal-complete, or its goal is blocked or paused; do not replace a live one.",
  'managed-by-other':
    'permission denied (managed-by-other): another secretary manages this session. Only the user can transfer it to you; do not retry.',
  'not-yours':
    'refused (not-yours): only messages you queued yourself can be withdrawn; this one was queued by the user or by another secretary',
  'session-queued':
    'refused (session-queued): this session is queued behind the dispatch limit and has not started yet, so it cannot take messages. Wait for it to start (it starts automatically when a slot frees up), or cancel it with session_stop and dispatch again.',
} as const;

export const NOT_OPERABLE_ERROR = DENIALS['not-operable'];

/** 「不再跟踪」名单上限：只用于挡住范围权限，留最近的一批就够 */
const UNTRACKED_LIMIT = 200;

type FieldsResult<T> = { ok: true; value: T } | { ok: false; error: string };

interface SessionFields {
  conversationId: string;
  message: string;
  mode: SecretarySendMode;
  clearQueue: boolean;
  taskId: string;
  /** 要转发的图片路径（未做文件校验）；不转发时为空数组 */
  attachments: string[];
  /** 追加任务时挂上的新目标；不带时为空串 */
  goal: string;
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
  const taskId = allowed.includes('taskId')
    ? text('taskId', SECRETARY_ID_MAX)
    : ({ ok: true, value: '' } as const);
  if (!taskId.ok) return taskId;
  const attachments = allowed.includes('attachments')
    ? attachmentPaths(params.attachments)
    : ({ ok: true, value: [] as string[] } as const);
  if (!attachments.ok) return attachments;
  const goal = allowed.includes('goal')
    ? optionalText(params.goal, 'goal', 4000)
    : ({ ok: true, value: '' } as const);
  if (!goal.ok) return goal;
  return {
    ok: true,
    value: {
      conversationId: conversationId.value,
      message: message.value,
      mode: (mode as SecretarySendMode | undefined) ?? 'queue',
      clearQueue: clearQueue === true,
      taskId: taskId.value,
      attachments: attachments.value,
      goal: goal.value,
    },
  };
}

/** 可选文本：缺省是空串；给了就必须是非空字符串且不超过上限 */
function optionalText(value: unknown, key: string, max: number): FieldsResult<string> {
  if (value === undefined) return { ok: true, value: '' };
  if (typeof value !== 'string')
    return {
      ok: false,
      error: `invalid arguments: "${key}" must be a string, got ${typeof value}`,
    };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: `invalid arguments: "${key}" must not be empty` };
  if (trimmed.length > max)
    return {
      ok: false,
      error: `invalid arguments: "${key}" is ${trimmed.length} characters, max ${max}`,
    };
  return { ok: true, value: trimmed };
}

/** attachments 只收字符串数组：单张路径越界、格式不对在文件校验里逐张报 */
function attachmentPaths(value: unknown): FieldsResult<string[]> {
  if (value === undefined) return { ok: true, value: [] };
  const invalid = (detail: string) => ({
    ok: false as const,
    error: `invalid arguments: ${detail}`,
  });
  if (!Array.isArray(value)) return invalid(`"attachments" must be an array, got ${typeof value}`);
  const paths: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string')
      return invalid(`"attachments" entry ${index + 1} must be a string, got ${typeof entry}`);
    const trimmed = entry.trim();
    // 空白条目没有语义（多余逗号、想表达「没有图」），丢掉而不是让整次调用失败
    if (!trimmed) continue;
    if (trimmed.length > SECRETARY_ATTACHMENT_PATH_MAX)
      return invalid(
        `"attachments" entry ${index + 1} is ${trimmed.length} characters, max ${SECRETARY_ATTACHMENT_PATH_MAX}`
      );
    paths.push(trimmed);
  }
  if (paths.length > SECRETARY_ATTACHMENT_MAX)
    return invalid(
      `"attachments" has ${paths.length} entries, max ${SECRETARY_ATTACHMENT_MAX} images per call`
    );
  return { ok: true, value: paths };
}

/**
 * 逐张校验要转发的图片：越界、不存在、不是图片、太大都写明是哪一张、为什么。
 * 只读文件头：等依赖的派发只存路径，真正开始时再读。
 */
async function probeAttachments(
  paths: readonly string[]
): Promise<{ ok: true; value: ForwardedImage[] } | { ok: false; error: string }> {
  const images: ForwardedImage[] = [];
  for (const [index, requested] of paths.entries()) {
    const probe = await probeImageView(realImageViewDeps, requested);
    if (!probe.ok)
      return { ok: false, error: `attachments[${index + 1}] ${requested}: ${probe.error}` };
    images.push({ path: probe.path, size: probe.size });
  }
  return { ok: true, value: images };
}

/** 校验并读出要转发的图片；任何一张不合法整条拒绝，写明是哪一张、为什么 */
async function loadAttachments(
  paths: readonly string[]
): Promise<{ ok: true; value: LoadedImage[] } | { ok: false; error: string }> {
  const images: LoadedImage[] = [];
  for (const [index, requested] of paths.entries()) {
    const read = await readImageView(realImageViewDeps, requested);
    if (!read.ok)
      return { ok: false, error: `attachments[${index + 1}] ${requested}: ${read.error}` };
    images.push({
      path: read.path,
      size: read.size,
      data: read.data,
      mimeType: read.facts.mimeType,
    });
  }
  return { ok: true, value: images };
}

/** 等依赖的派发真正开始时读图：读不到的不挡派发，记下原因写进 prompt */
export async function loadPendingAttachments(
  paths: readonly string[]
): Promise<{ images: LoadedImage[]; unavailable?: UnavailableImage[] }> {
  const images: LoadedImage[] = [];
  const unavailable: UnavailableImage[] = [];
  for (const requested of paths) {
    const read = await readImageView(realImageViewDeps, requested);
    if (read.ok)
      images.push({
        path: read.path,
        size: read.size,
        data: read.data,
        mimeType: read.facts.mimeType,
      });
    else unavailable.push({ path: requested, reason: read.error });
  }
  return { images, ...(unavailable.length > 0 ? { unavailable } : {}) };
}

/** 投递给目标会话的消息：模型能看图就带图片块，否则退回路径加 image_view */
async function sendableMessage(
  ports: SecretaryDispatchPorts,
  conversationId: string,
  text: string,
  images: readonly LoadedImage[]
): Promise<{ text: string; images?: AttachedImage[] }> {
  if (images.length === 0) return { text };
  const inline = (await ports.imageInput?.(conversationId)) === true;
  return forwardedMessage(text, images, {
    inline,
    canView: inline || (await targetCanViewImages(ports, conversationId)),
  });
}

/**
 * 目标会话是否装了 image_view：会话行里记着工具表就以它为准，
 * 读不到按可用处理（根会话默认装配这一份）。
 */
export async function targetCanViewImages(
  ports: SecretaryDispatchPorts,
  conversationId: string
): Promise<boolean> {
  const row = (await ports.rows())[conversationId];
  const tools = row?.tools;
  if (!Array.isArray(tools)) return true;
  return tools.includes('image_view');
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

/** 停止会话时撤掉驱动者的续跑与看门狗；同样由 IPC 层注册，避免静态依赖 driver */
let forgetListener: ((conversationId: string) => void) | null = null;

export function setSecretaryForgetListener(
  listener: ((conversationId: string) => void) | null
): void {
  forgetListener = listener;
}

export function notifySecretaryChanged(): void {
  try {
    stateListener?.();
  } catch {
    // 推送失败不影响写操作
  }
}

/**
 * 用户点了确认或提案执行完：立刻把进展投给秘书，不等下一分钟的 tick。
 * 由 IPC 层注册，避免本模块静态依赖回传宿主。
 */
let acceptedListener: (() => void) | null = null;

export function setProposalAcceptedListener(listener: (() => void) | null): void {
  acceptedListener = listener;
}

function notifyProposalAccepted(): void {
  try {
    acceptedListener?.();
  } catch {
    // 投递失败不影响执行
  }
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 派发模型：providerId + modelId 必填，thinkingLevel 可选；形状与秘书档案的 model 一致 */
function modelParam(value: unknown): DispatchModelRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const model = value as Record<string, unknown>;
  const providerId = stringParam(model, 'providerId');
  const modelId = stringParam(model, 'modelId');
  if (!providerId || !modelId) return undefined;
  const thinkingLevel = (THINKING_LEVELS as readonly unknown[]).includes(model.thinkingLevel)
    ? (model.thinkingLevel as ThinkingLevel)
    : undefined;
  return { providerId, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) };
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
export async function runningCount(
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

/** 会话的一句话标签：项目名 · 标题，回传正文与卡片共用 */
async function sessionLabelOf(
  ports: SecretaryDispatchPorts,
  conversationId: string
): Promise<string> {
  const record = ports.dispatchFile().dispatched[conversationId];
  const row = (await ports.rows())[conversationId];
  const project = record
    ? (await ports.projects()).find((candidate) => candidate.projectId === record.projectId)
    : undefined;
  return sessionLabel(
    secretaryProjectName(project, (await ports.projectAliases?.()) ?? {}),
    typeof row?.title === 'string' ? row.title : '',
    conversationId
  );
}

async function noteDispatchResumed(
  ports: SecretaryDispatchPorts,
  conversationId: string,
  options?: { newGoal?: boolean }
): Promise<void> {
  const file = ports.dispatchFile();
  const record = file.dispatched[conversationId];
  if (!record) return;
  const now = ports.now();
  // 手动标记完成的会话，只有发了新 goal 才解除完成锁定；普通追问/回复不拉回进行中
  if (record.lastResult?.manual === true && !options?.newGoal) {
    record.lastEventAt = now;
    record.sentAt = now;
    ports.saveDispatch(file);
    return;
  }
  if (record.lastState !== 'running') record.stateSince = now;
  record.lastState = 'running';
  record.lastEventAt = now;
  // 发过消息：这一轮没有可见回复时巡检按空闲阈值兜底
  record.sentAt = now;
  // 重新派活就是重新开始：上一次的停止与移出都不再生效
  delete record.stoppedAt;
  delete record.dismissedFromBoard;
  // 追加任务就重新跟踪：撤下旧结果（含手动标完成），这一轮的结束、完成、受阻、失败、停滞照常推，
  // 不会被旧终态或旧的停滞标记去重掉。收掉的旧目标也随手动标记一起作废
  record.reopenedAt = now;
  delete record.lastResult;
  delete record.goalResult;
  delete record.manualUndoneAt;
  delete record.closedGoal;
  delete record.stalledTurn;
  delete record.patrol;
  ports.saveDispatch(file);
  const resumed = resumeLinkedTodo(await ports.todos(), conversationId, now);
  if (resumed.changed) ports.saveTodos(resumed.todos);
}

async function dispatchContext(
  ports: SecretaryDispatchPorts,
  profile: SecretaryProfile,
  projectId: string,
  deferred = false
): Promise<Parameters<typeof validateDispatch>[1]> {
  const projects = await ports.projects();
  const file = ports.dispatchFile();
  const total = await ports.runningTotal?.();
  const rows = await ports.rows();
  return {
    project: projects.find((candidate) => candidate.projectId === projectId),
    visible: visibleProjects(projects, profile).some(
      (candidate) => candidate.projectId === projectId
    ),
    running: await runningCount(ports, file),
    max: profile.maxRunningDispatches,
    queued: queuedCount(rows, ports.secretaryId ?? ''),
    ...(total
      ? { runningTotal: total.running, maxTotal: total.max, queuedTotal: queuedCount(rows) }
      : {}),
    deferred,
  };
}

/** 待办文本的首个非空行就是它的标题 */
function todoTitle(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
}

/** 待办派发未显式传 goal 时，用待办文本作为默认 goal，确保巡检与续跑生效 */
function todoDefaultGoal(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 4000) : undefined;
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
  const base = baseFromParams(params);
  if (base) Object.assign(draft, base);
  const after = afterParam(params);
  if (after) draft.after = after;
  return draft;
}

type DispatchBaseFields = Pick<DispatchDraft, 'checkout' | 'baseRef' | 'branch'>;

/** checkout / baseRef / branch：三个都可选，只带其中一部分也照样校验 */
function baseFromParams(params: Record<string, unknown>): DispatchBaseFields | null {
  const checkout = stringParam(params, 'checkout');
  const baseRef = stringParam(params, 'baseRef');
  const branch = stringParam(params, 'branch');
  if (!checkout && !baseRef && !branch) return null;
  return {
    ...(checkout ? { checkout } : {}),
    ...(baseRef ? { baseRef } : {}),
    ...(branch ? { branch } : {}),
  };
}

/** after：会话 id 列表，去重后按给的顺序等 */
function afterParam(params: Record<string, unknown>): string[] | undefined {
  const value = params.after;
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 ? ids.slice(0, MAX_DISPATCH_DEPENDENCIES) : undefined;
}

type DispatchOutcome =
  | { kind: 'created'; conversationId: string }
  /** 超过上限：会话已经建好，排队等空位 */
  | { kind: 'queued'; conversationId: string; position: number; limit: DispatchLimit }
  | { kind: 'pending'; pendingId: string }
  | { kind: 'failed'; error: string };

/** 基线校验：越界、ref 不存在、分支重名都在建会话之前拒绝 */
async function checkBase(
  ports: SecretaryDispatchPorts,
  draft: DispatchDraft
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!draft.checkout && !draft.baseRef && !draft.branch) return { ok: true };
  const project = (await ports.projects()).find(
    (candidate) => candidate.projectId === draft.projectId
  );
  if (!project) return { ok: false, error: 'project-missing' };
  const facts = await ports.baseFacts({
    projectPath: project.canonicalPath,
    ...(draft.checkout ? { checkout: draft.checkout } : {}),
    ...(draft.baseRef ? { baseRef: draft.baseRef } : {}),
    ...(draft.branch ? { branch: draft.branch } : {}),
  });
  return validateDispatchBase(draft, facts);
}

/**
 * 清理提案：卡片上列出会删什么，用户确认后才执行。
 * 与派活提案共用同一套状态机与推送，只是执行体换成 applyCleanup。
 */
export function saveCleanupProposal(
  items: CleanupItem[],
  secretaryConversationId: string | null,
  ports: Pick<SecretaryDispatchPorts, 'dispatchFile' | 'saveDispatch'>
): SavedProposal {
  if (!secretaryConversationId) throw new Error('cleanup needs a secretary conversation');
  const now = Date.now();
  const proposal: SecretaryProposal = {
    id: randomUUID(),
    secretaryConversationId,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    kind: 'cleanup',
    draft: { items },
  };
  const file = ports.dispatchFile();
  const { saved, changed } = saveProposalRecord(file, proposal);
  if (!changed) return saved;
  ports.saveDispatch(file);
  notifySecretaryChanged();
  return saved;
}

async function executeDispatch(
  ports: SecretaryDispatchPorts,
  draft: DispatchDraft,
  secretaryConversationId: string,
  profile: SecretaryProfile,
  attachments?: MainSessionRequest['attachments'],
  limit?: DispatchLimit
): Promise<DispatchOutcome> {
  // 排队的会话只存图片路径，开始时再读
  const queuedPaths = limit ? draft.attachments : undefined;
  const created = await ports.createSession({
    projectId: draft.projectId,
    prompt: draft.prompt,
    worktree: draft.worktree,
    ...(attachments ? { attachments } : {}),
    ...(limit ? { queued: true } : {}),
    ...(queuedPaths?.length ? { attachmentPaths: queuedPaths } : {}),
    ...(draft.title ? { title: draft.title } : {}),
    ...(draft.model
      ? { model: { providerId: draft.model.providerId, modelId: draft.model.modelId } }
      : {}),
    ...(draft.model?.thinkingLevel ? { thinkingLevel: draft.model.thinkingLevel } : {}),
    ...(draft.goal ? { goal: draft.goal } : {}),
    ...(draft.checkout ? { checkout: draft.checkout } : {}),
    ...(draft.baseRef ? { baseRef: draft.baseRef } : {}),
    ...(draft.branch ? { branch: draft.branch } : {}),
    secretaryOrigin: {
      secretaryConversationId,
      ...(ports.secretaryId ? { secretaryId: ports.secretaryId } : {}),
    },
    // 只有新派出的会话固定静音且无人值守；接管的是用户已有会话，一概不碰
    muted: true,
    unattended: true,
    // 派出的会话一律把 ask_user 先转给秘书：无人值守时不再直接拒绝，也不会卡住
    ...(profile.name ? { askRelay: { name: profile.name } } : {}),
  });
  if (!created.ok) return { kind: 'failed', error: created.error };
  const now = ports.now();
  const file = ports.dispatchFile();
  file.dispatched[created.conversationId] = {
    conversationId: created.conversationId,
    projectId: draft.projectId,
    secretaryConversationId,
    createdAt: now,
    turn: 0,
    // 排队会话还没开始：记成空闲，启动时才标回运行中，重启恢复也不会把它报成中断
    lastState: limit ? 'idle' : 'running',
    lastEventAt: now,
    stateSince: now,
    ...(draft.todoId ? { todoId: draft.todoId } : {}),
    ...(draft.goal ? { goal: draft.goal } : {}),
    ...(draft.checkout ? { checkout: draft.checkout } : {}),
    ...(draft.baseRef ? { baseRef: draft.baseRef } : {}),
    ...(draft.branch ? { branch: draft.branch } : {}),
    ...(draft.model ? { model: draft.model } : {}),
  };
  ports.saveDispatch(file);
  if (draft.todoId) {
    const linked = linkTodo(await ports.todos(), draft.todoId, created.conversationId, ports.now());
    if (linked.changed) ports.saveTodos(linked.todos);
  }
  notifySecretaryChanged();
  if (!limit) return { kind: 'created', conversationId: created.conversationId };
  const rows = await ports.rows();
  const position =
    queuePositions(rows).get(created.conversationId) ??
    queuedCount(rows, ports.secretaryId ?? '') + 1;
  return { kind: 'queued', conversationId: created.conversationId, position, limit };
}

/** 带 after 的派发先落一条等待记录：不建会话、不占运行名额，重启后还在 */
async function queuePending(
  ports: SecretaryDispatchPorts,
  draft: DispatchDraft,
  secretaryConversationId: string
): Promise<string> {
  const now = ports.now();
  const id = ports.newId();
  const pending: PendingDispatch = {
    id,
    projectId: draft.projectId,
    secretaryConversationId,
    createdAt: now,
    updatedAt: now,
    status: 'waiting',
    after: [...(draft.after ?? [])],
    draft,
  };
  const file = ports.dispatchFile();
  file.pending = { ...(file.pending ?? {}), [id]: pending };
  ports.saveDispatch(file);
  ports.audit({
    at: now,
    secretaryConversationId,
    op: 'dispatch_pending',
    targetId: id,
    ok: true,
    detail: `waiting for ${pending.after.join(',')}`,
  });
  notifySecretaryChanged();
  return id;
}

/** 依赖满足就建会话，依赖出问题就标成出问题并给秘书推一条 */
async function startDispatch(
  ports: SecretaryDispatchPorts,
  draft: DispatchDraft,
  secretaryConversationId: string,
  profile: SecretaryProfile,
  attachments?: MainSessionRequest['attachments'],
  limit?: DispatchLimit
): Promise<DispatchOutcome> {
  if ((draft.after?.length ?? 0) > 0) {
    return {
      kind: 'pending',
      pendingId: await queuePending(ports, draft, secretaryConversationId),
    };
  }
  return executeDispatch(ports, draft, secretaryConversationId, profile, attachments, limit);
}

/**
 * 派发模型：没指定就跟随项目默认；指定了就一定校验：
 * provider 或 model 不可用就当场失败，绝不静默回退到默认模型。
 */
async function resolveDraftModel(
  ports: SecretaryDispatchPorts,
  draft: DispatchDraft
): Promise<{ ok: true; draft: DispatchDraft } | { ok: false; error: string }> {
  const wanted = draft.model;
  if (!wanted) return { ok: true, draft };
  const resolved = await ports.resolveModel(wanted);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return { ok: true, draft: { ...draft, model: resolved.model } };
}

async function dispatchDraft(
  ports: SecretaryDispatchPorts,
  secretaryConversationId: string,
  draft: DispatchDraft
): Promise<DispatchOutcome> {
  const profile = await profileOf(ports);
  const withModel = await resolveDraftModel(ports, draft);
  if (!withModel.ok) return { kind: 'failed', error: withModel.error };
  const wanted = withModel.draft;
  const validated = validateDispatch(
    wanted,
    await dispatchContext(ports, profile, wanted.projectId, (wanted.after?.length ?? 0) > 0)
  );
  if (!validated.ok) return { kind: 'failed', error: validated.error };
  const base = await checkBase(ports, validated.draft);
  if (!base.ok) return { kind: 'failed', error: base.error };
  const limit = validated.overLimit;
  const prepared = await prepareAttachments(validated.draft, limit !== undefined);
  if (!prepared.ok) return { kind: 'failed', error: prepared.error };
  // 派发固定直接执行，不出确认卡；派出的会话无人值守，审批照样自动拒绝
  const outcome = await startDispatch(
    ports,
    prepared.draft,
    secretaryConversationId,
    profile,
    prepared.attachments,
    limit
  );
  noteFollow(ports, secretaryConversationId, validated.draft, outcome);
  return outcome;
}

/**
 * 派发带图：现在就开始的当场读图；等依赖或排队的只校验并存真实路径，开始时再读。
 * 任何一张不合法整条拒绝，什么都不建。
 */
async function prepareAttachments(
  draft: DispatchDraft,
  queued: boolean
): Promise<
  | { ok: true; draft: DispatchDraft; attachments?: MainSessionRequest['attachments'] }
  | { ok: false; error: string }
> {
  const paths = draft.attachments ?? [];
  if (paths.length === 0) return { ok: true, draft };
  if (queued || (draft.after?.length ?? 0) > 0) {
    const probed = await probeAttachments(paths);
    if (!probed.ok) return probed;
    return { ok: true, draft: { ...draft, attachments: probed.value.map((image) => image.path) } };
  }
  const loaded = await loadAttachments(paths);
  if (!loaded.ok) return loaded;
  const { attachments: _paths, ...rest } = draft;
  return { ok: true, draft: rest, attachments: { images: loaded.value } };
}

/** 原始需求的一句话摘要：标题优先，没有就取 prompt 的首个非空行 */
function draftSummary(draft: DispatchDraft): string {
  const title = draft.title?.trim();
  if (title) return title;
  return todoTitle(draft.prompt) ?? draft.prompt.trim();
}

/**
 * 手机发起的回合里派生的会话：记进「手机关注」，结果一直推到手机上。
 * 等待中的派发与待确认的卡先记自己的 id，真正建出会话后由 refollow 改挂。
 */
function noteFollow(
  ports: SecretaryDispatchPorts,
  secretaryConversationId: string,
  draft: DispatchDraft,
  outcome: DispatchOutcome
): void {
  if (!ports.follow || outcome.kind === 'failed') return;
  const targetId = outcome.kind === 'pending' ? outcome.pendingId : outcome.conversationId;
  ports.follow({
    targetId,
    summary: draftSummary(draft),
    secretaryConversationId,
  });
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

/** 审计里带上实际用到的模型：事后能查清这次派发用的是哪个模型 */
function modelDetail(model: DispatchModelRef | undefined): string {
  return model ? ` · model ${model.providerId}/${model.modelId}` : '';
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
  // 审计记的是真正落盘的那个模型
  const file = ports.dispatchFile();
  if (outcome.kind === 'pending')
    return pendingResult(ports, ctx, op, outcome.pendingId, file.pending?.[outcome.pendingId]);
  const model = file.dispatched[outcome.conversationId]?.model;
  if (outcome.kind === 'queued') {
    ports.audit({
      at,
      secretaryConversationId: ctx.secretaryConversationId,
      op,
      targetId: outcome.conversationId,
      ok: true,
      detail: `queued #${outcome.position} ${outcome.limit}${modelDetail(model)}`,
    });
    return { ok: true, result: queuedResult(outcome) };
  }
  ports.audit({
    at,
    secretaryConversationId: ctx.secretaryConversationId,
    op,
    targetId: outcome.conversationId,
    ok: true,
    detail: `created${modelDetail(model)}`,
  });
  return { ok: true, result: { status: 'created', conversationId: outcome.conversationId } };
}

/** 排队派发的结果：说清会话已建好、为什么排队、怎么取消 */
function queuedResult(outcome: Extract<DispatchOutcome, { kind: 'queued' }>) {
  return {
    status: 'queued',
    conversationId: outcome.conversationId,
    position: outcome.position,
    reason: outcome.limit,
    note: `The ${outcome.limit === 'dispatch-limit-total' ? 'total dispatch limit across all secretaries' : 'dispatch limit'} is reached, so the session was created but queued (position ${outcome.position}). It starts automatically, first in first out, when a slot frees up; the user can also start it right away. Cancel it with session_stop if it is no longer needed.`,
  };
}

/** 等依赖的派发：结果里点名 pendingId，取消时把它当 conversationId 传给 session_stop */
function pendingResult(
  ports: SecretaryDispatchPorts,
  ctx: SecretaryOpContext,
  op: string,
  pendingId: string,
  pending?: PendingDispatch
): SecretaryOpResult {
  ports.audit({
    at: ports.now(),
    secretaryConversationId: ctx.secretaryConversationId,
    op,
    targetId: pendingId,
    ok: true,
    detail: `waiting_dependencies${modelDetail(pending?.draft.model)}`,
  });
  return { ok: true, result: { status: 'waiting', pendingId } };
}

/** 依赖会话此刻的事实：判定它是否真正结束 */
async function dependencyFacts(
  ports: SecretaryDispatchPorts,
  file: SecretaryDispatchFile,
  conversationIds: readonly string[]
): Promise<DependencyFacts[]> {
  const rows = await ports.rows();
  const facts: DependencyFacts[] = [];
  for (const conversationId of conversationIds) {
    const row = rows[conversationId];
    if (!row) {
      facts.push({
        conversationId,
        present: false,
        state: 'not-started',
        stopped: false,
        tracked: false,
      });
      continue;
    }
    const record = file.dispatched[conversationId];
    const status = await ports.status(conversationId);
    const goal = row.goal;
    const goalStatus =
      goal && typeof goal === 'object' && !Array.isArray(goal)
        ? (goal as Record<string, unknown>).status
        : undefined;
    facts.push({
      conversationId,
      present: true,
      state: row.sessionFile ? status.state : 'not-started',
      ...(typeof goalStatus === 'string' ? { goalStatus } : {}),
      ...(record?.backgroundRunning ? { backgroundRunning: true } : {}),
      ...(record?.lastResult ? { result: record.lastResult.kind } : {}),
      stopped: record?.stoppedAt !== undefined,
      tracked: record !== undefined,
    });
  }
  return facts;
}

/** 出问题：留在看板上等用户或秘书处理，同时给秘书推一条结果 */
async function failPending(
  ports: SecretaryDispatchPorts,
  pending: PendingDispatch,
  problem: PendingProblem,
  failedDependency: string | undefined,
  detail?: string
): Promise<void> {
  const now = ports.now();
  const failed: PendingDispatch = {
    ...pending,
    status: 'failed',
    updatedAt: now,
    problem,
    ...(failedDependency ? { failedDependency } : {}),
  };
  const file = ports.dispatchFile();
  file.pending = { ...(file.pending ?? {}), [pending.id]: failed };
  file.outbox = enqueueUpdate(file.outbox, pendingUpdate(failed, now));
  ports.saveDispatch(file);
  ports.audit({
    at: now,
    secretaryConversationId: pending.secretaryConversationId,
    op: 'dispatch_pending',
    targetId: pending.id,
    ok: false,
    detail: [problem, failedDependency, detail].filter(Boolean).join(' '),
  });
  notifySecretaryChanged();
}

/**
 * 依赖判定与真正开始。host 每分钟把「依赖已经全部结束」的派发 id 交过来，
 * 这里先把它从等待表里摘掉再建会话：并发的第二次调用读不到它，不会建两个会话。
 */
export async function startPendingDispatches(
  ports: SecretaryDispatchPorts,
  pendingIds: readonly string[],
  now: number
): Promise<void> {
  for (const pendingId of pendingIds) {
    const file = ports.dispatchFile();
    const pending = file.pending?.[pendingId];
    if (pending?.status !== 'waiting') continue;
    if (pending.nextRetryAt !== undefined && now < pending.nextRetryAt) continue;
    const outcome = pendingOutcome(await dependencyFacts(ports, file, pending.after));
    if (outcome.kind === 'wait') continue;
    if (outcome.kind === 'failed') {
      // 上面等过：并发的另一次判定可能已标过、用户已忽略或秘书已取消，别用旧副本写回
      if (ports.dispatchFile().pending?.[pendingId]?.status !== 'waiting') continue;
      await failPending(ports, pending, outcome.problem, outcome.conversationId);
      continue;
    }
    const claimed = ports.dispatchFile();
    if (!claimed.pending?.[pendingId]) continue;
    delete claimed.pending[pendingId];
    if (Object.keys(claimed.pending).length === 0) delete claimed.pending;
    ports.saveDispatch(claimed);

    const retryOrFailPending = async (error: string): Promise<void> => {
      const classified = classifyUpstreamError({ error }, now);
      if (classified.kind !== 'permanent') {
        const nextAttempt = (pending.retryCount ?? 0) + 1;
        const delay = nextPendingRetryDelayMs(nextAttempt);
        if (delay !== null) {
          const latest = ports.dispatchFile();
          latest.pending = {
            ...(latest.pending ?? {}),
            [pending.id]: {
              ...pending,
              status: 'waiting',
              updatedAt: now,
              retryCount: nextAttempt,
              nextRetryAt: now + delay,
              lastError: error,
            },
          };
          ports.saveDispatch(latest);
          ports.audit({
            at: now,
            secretaryConversationId: pending.secretaryConversationId,
            op: 'dispatch_pending',
            targetId: pending.id,
            ok: false,
            detail: `transient-retry ${nextAttempt} ${error}`,
          });
          notifySecretaryChanged();
          return;
        }
      }
      await failPending(ports, pending, 'dispatch-failed', undefined, error);
    };

    const profile = await profileOf(ports);
    const validated = validateDispatch(
      pending.draft,
      await dispatchContext(ports, profile, pending.projectId)
    );
    if (!validated.ok) {
      await failPending(ports, pending, 'dispatch-failed', undefined, validated.error);
      continue;
    }
    const base = await checkBase(ports, validated.draft);
    if (!base.ok) {
      await retryOrFailPending(base.error);
      continue;
    }
    const { attachments: paths, ...draft } = validated.draft;
    const limit = validated.overLimit;
    // 依赖都结束了但名额已满：照常建出会话，排队等空位，不再判失败
    const created = limit
      ? await executeDispatch(
          ports,
          validated.draft,
          pending.secretaryConversationId,
          profile,
          undefined,
          limit
        )
      : await executeDispatch(
          ports,
          draft,
          pending.secretaryConversationId,
          profile,
          paths?.length ? await loadPendingAttachments(paths) : undefined
        );
    if (created.kind === 'failed') {
      await retryOrFailPending(created.error);
      continue;
    }
    if (created.kind === 'pending') continue;
    // 关注项从等待中的派发改挂到真正建出来的会话上
    ports.refollow?.(pendingId, created.conversationId);
    ports.audit({
      at: now,
      secretaryConversationId: pending.secretaryConversationId,
      op: 'dispatch_pending',
      targetId: pendingId,
      ok: true,
      detail: `${created.kind === 'queued' ? 'queued' : 'started'} ${created.conversationId}`,
    });
  }
}

/** 取消一条等依赖的派发：从等待表里移除，并给秘书推一条 */
async function cancelPending(
  ports: SecretaryDispatchPorts,
  ctx: SecretaryOpContext,
  pendingId: string
): Promise<SecretaryOpResult | null> {
  const pending = ports.dispatchFile().pending?.[pendingId];
  if (!pending) return null;
  const profile = await profileOf(ports);
  const visible = visibleProjects(await ports.projects(), profile).some(
    (candidate) => candidate.projectId === pending.projectId
  );
  if (!visible) return deny(ports, ctx, 'session_stop', 'not-visible', pendingId);
  // 上面等过：重新读盘再写，别把期间用户忽略、或已开始的派发用旧副本写回去
  const file = ports.dispatchFile();
  if (!file.pending?.[pendingId]) return null;
  const now = ports.now();
  const cancelled: PendingDispatch = {
    ...pending,
    status: 'failed',
    updatedAt: now,
    problem: 'cancelled',
  };
  file.pending = { ...(file.pending ?? {}) };
  delete file.pending[pendingId];
  if (Object.keys(file.pending).length === 0) delete file.pending;
  file.outbox = enqueueUpdate(file.outbox, pendingUpdate(cancelled, now));
  ports.saveDispatch(file);
  ports.audit({
    at: now,
    secretaryConversationId: ctx.secretaryConversationId,
    op: 'session_stop',
    targetId: pendingId,
    ok: true,
    detail: 'cancelled waiting dispatch',
  });
  notifySecretaryChanged();
  return { ok: true, result: { status: 'cancelled', pendingId } };
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
  const own = ports.secretaryProjectId?.();
  // 多秘书时只在本秘书的会话里找：结果与授权不能落到别的秘书头上
  const secretaryProjects = new Set(
    projects
      .filter((project) =>
        own !== undefined ? project.projectId === own : project.kind === 'secretary'
      )
      .map((project) => project.projectId)
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
    managedElsewhere: Boolean(await ports.managedElsewhere?.(conversationId)),
  });
  if (refusal || !conversation || !row) return { ok: false, error: refusal ?? 'not-found' };
  return { ok: true, conversation, row };
}

export type TakeoverResult = { ok: true } | { ok: false; error: string };

type OperateCheck =
  | { ok: true; source: OperateSource; conversation: ConversationAuthority; projectId: string }
  | { ok: false; code: keyof typeof DENIALS };

/**
 * 能不能给这个会话发消息、停止它：派出的、逐个授权的，或所属项目在接管范围内。
 * 范围接管沿用逐个授权的边界：子会话、归档、别的秘书的会话、不可见项目一律拒绝。
 */
async function checkOperate(
  ports: SecretaryDispatchPorts,
  conversationId: string,
  profile: SecretaryProfile
): Promise<OperateCheck> {
  const conversation = await targetConversation(ports, conversationId);
  if (!conversation) return { ok: false, code: 'not-found' };
  const projects = await ports.projects();
  const project = projects.find((candidate) => candidate.projectId === conversation.projectId);
  const visible =
    project !== undefined &&
    visibleProjects(projects, profile).some(
      (candidate) => candidate.projectId === project.projectId
    );
  if (!visible) return { ok: false, code: 'not-visible' };
  // 一个会话只归一个秘书：别的秘书在管时，点名与接管范围都不算数
  if (await ports.managedElsewhere?.(conversationId))
    return { ok: false, code: 'managed-by-other' };
  const file = ports.dispatchFile();
  const source = operateSource(file, conversationId, profile.takeoverScope, conversation.projectId);
  if (!source) {
    // 用户收回过的会话被拒时要说清原因，否则秘书会当成「再申请一次就能用」。
    // 范围本来就不覆盖的项目仍报 not-operable：那和收回无关。
    const untracked =
      isUntracked(file, conversationId) &&
      inTakeoverScope(profile.takeoverScope, conversation.projectId);
    return { ok: false, code: untracked ? 'untracked' : 'not-operable' };
  }
  const projectId = conversation.projectId;
  if (source !== 'scope') return { ok: true, source, conversation, projectId };
  const refusal = takeoverRefusal(file, {
    conversationId,
    conversation,
    project,
    row: (await ports.rows())[conversationId],
    visible,
  });
  if (refusal === 'not-found' || refusal === 'not-visible') return { ok: false, code: refusal };
  if (refusal) return { ok: false, code: 'not-operable' };
  return { ok: true, source, conversation, projectId };
}

/** 归档的目标：单个 conversationId 与 ids 列表合并去重，超上限整单拒绝 */
function archiveIds(params: Record<string, unknown>): string[] | null {
  const ids: string[] = [];
  const single = stringParam(params, 'conversationId');
  if (single) ids.push(single);
  const list = params.ids;
  if (Array.isArray(list)) {
    for (const item of list) {
      const id = typeof item === 'string' ? item.trim() : '';
      if (id) ids.push(id);
    }
  }
  const unique = [...new Set(ids)];
  return unique.length > 0 && unique.length <= MAX_ARCHIVE_IDS ? unique : null;
}

/**
 * 归档一条会话的前置条件：只认派发或接管跟踪的记录，且已经终态、空闲、没有待处理项。
 * 返回原因码，null 表示可以归档。
 */
async function archiveRefusal(
  ports: SecretaryDispatchPorts,
  conversationId: string
): Promise<string | null> {
  const file = ports.dispatchFile();
  const record = file.dispatched[conversationId];
  if (!record) return 'not-operable';
  const row = (await ports.rows())[conversationId];
  if (!row) return 'not-found';
  if (row.archived === true) return 'already-archived';
  const status = await ports.status(conversationId);
  if (status.pendingAsks + status.pendingApprovals > 0) return 'needs-user';
  if (countsAsRunning(record, row, status)) return 'running';
  if (!record.lastResult || !SETTLED_RESULTS.has(record.lastResult.kind)) return 'not-terminal';
  return null;
}

/**
 * 取消归档的前置条件。只认派发或接管跟踪的记录，且这次归档必须是秘书做的
 * （session_archive、cleanup_apply，或旧版自动归档）。返回原因码，null 表示可以拉回。
 */
async function unarchiveRefusal(
  ports: SecretaryDispatchPorts,
  conversationId: string,
  profile: SecretaryProfile
): Promise<string | null> {
  const record = ports.dispatchFile().dispatched[conversationId];
  if (!record) return 'not-operable';
  const row = (await ports.rows())[conversationId];
  if (!row) return 'not-found';
  const visible = visibleProjects(await ports.projects(), profile);
  if (!visible.some((project) => project.projectId === record.projectId)) return 'not-visible';
  if (row.archived !== true) return 'not-archived';
  if (!archivedBySecretary(record, row)) return 'archived-by-user';
  return null;
}

/**
 * 范围接管的会话第一次被真正用上：从这一刻起才跟踪它的状态与结果。
 * 之前不建记录，所以范围里的其他会话不会被推给秘书，也不改未读与静音。
 */
async function trackScopeSession(
  ports: SecretaryDispatchPorts,
  conversationId: string,
  projectId: string,
  ctx: SecretaryOpContext
): Promise<void> {
  const file = ports.dispatchFile();
  if (Object.hasOwn(file.dispatched, conversationId)) return;
  const owner = ctx.secretaryConversationId ?? (await latestSecretaryConversation(ports));
  if (!owner) return;
  const now = ports.now();
  const status = await ports.status(conversationId);
  file.dispatched[conversationId] = {
    conversationId,
    projectId,
    secretaryConversationId: owner,
    createdAt: now,
    turn: 0,
    lastState: status.state,
    lastEventAt: now,
    stateSince: now,
    takeover: { grantedAt: now, via: 'scope' },
  };
  ports.saveDispatch(file);
  ports.audit({
    at: now,
    secretaryConversationId: owner,
    op: 'takeover_grant',
    targetId: conversationId,
    ok: true,
    detail: 'scope',
  });
  const name = (await profileOf(ports)).name;
  if (name) ports.relayAsk(conversationId, { name });
}

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
  // 逐个授权是用户亲手点的，撤销时记下的「不再跟踪」到此失效
  if (file.untracked?.includes(conversationId)) {
    file.untracked = file.untracked.filter((id) => id !== conversationId);
  }
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
  // 接管生效：这个会话的 ask_user 从此先转给秘书
  const name = (await profileOf(ports)).name;
  if (name) ports.relayAsk(conversationId, { name });
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
  // 收回接管：这个会话的结果不再推给秘书，手机关注也一并结束
  ports.unfollow?.(conversationId);
  file.outbox = file.outbox.filter(
    (update) => !('conversationId' in update && update.conversationId === conversationId)
  );
  // 挂起的转交提问一并作废：撤销后秘书不能再代答
  dropRelaysFor(file, conversationId);
  // 记进「不再跟踪」：范围权限不会再让秘书自动管回这个会话，只有确认卡能重新授权
  file.untracked = [
    conversationId,
    ...(file.untracked ?? []).filter((id) => id !== conversationId),
  ].slice(0, UNTRACKED_LIMIT);
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
  // 权限收回：ask_user 恢复成直接问用户
  ports.relayAsk(conversationId, null);
  return { ok: true };
}

export async function listTakeovers(
  ports: Pick<SecretaryDispatchPorts, 'dispatchFile' | 'rows' | 'projects' | 'projectAliases'>
): Promise<SecretaryTakeoverView[]> {
  return takeoverViews(
    ports.dispatchFile(),
    await ports.rows(),
    await ports.projects(),
    (await ports.projectAliases?.()) ?? {}
  );
}

/** 「不再跟踪」名单：设置页列出，用户可以逐个移除 */
export async function listUntracked(
  ports: Pick<SecretaryDispatchPorts, 'dispatchFile' | 'rows' | 'projects' | 'projectAliases'>
): Promise<SecretaryUntrackedView[]> {
  return untrackedViews(
    ports.dispatchFile(),
    await ports.rows(),
    await ports.projects(),
    (await ports.projectAliases?.()) ?? {}
  );
}

/** 把会话从「不再跟踪」名单里移除：只是恢复范围权限，不建立接管记录 */
export function untrack(ports: SecretaryDispatchPorts, conversationId: string): TakeoverResult {
  const file = ports.dispatchFile();
  if (!isUntracked(file, conversationId)) return { ok: false, error: 'not-found' };
  file.untracked = (file.untracked ?? []).filter((id) => id !== conversationId);
  ports.saveDispatch(file);
  ports.audit({
    at: ports.now(),
    secretaryConversationId: null,
    op: 'takeover_untrack_remove',
    targetId: conversationId,
    ok: true,
    detail: 'settings',
  });
  notifySecretaryChanged();
  return { ok: true };
}

/** 秘书侧的手动收口：与看板按钮同一条逻辑，审计里标明是秘书点的 */
async function markResultOp(
  ports: SecretaryDispatchPorts,
  ctx: SecretaryOpContext,
  params: Record<string, unknown>,
  action: MarkResultAction
): Promise<SecretaryOpResult> {
  const fields = sessionFields(params, ['conversationId']);
  if (!fields.ok) return fields;
  const { conversationId } = fields.value;
  const result = await markResult(ports, conversationId, action, 'secretary');
  if (!result.ok) {
    const op =
      action === 'done'
        ? 'result_mark_done'
        : action === 'undo'
          ? 'result_mark_undo'
          : 'result_dismiss_board';
    auditFailure(ports, ctx, op, result.error, conversationId);
    return { ok: false, error: MARK_REFUSALS[result.error] ?? result.error };
  }
  return {
    ok: true,
    result: {
      status: action === 'done' ? 'marked-done' : action === 'undo' ? 'undone' : 'dismissed',
      conversationId,
    },
  };
}

export function createSecretaryDispatchHandlers(
  ports: SecretaryDispatchPorts
): SecretaryDispatchHandlers {
  const handlers: SecretaryDispatchHandlers = {
    async session_create(params, ctx) {
      const draft = draftFromParams(params);
      if (!draft || !ctx.secretaryConversationId) return invalidArguments;
      const paths = attachmentPaths(params.attachments);
      if (!paths.ok) return paths;
      if (paths.value.length > 0) draft.attachments = paths.value;
      const outcome = await dispatchDraft(ports, ctx.secretaryConversationId, draft);
      return outcomeResult(ports, ctx, 'session_create', outcome, draft.projectId);
    },

    async session_send(params, ctx) {
      const fields = sessionFields(params, [
        'conversationId',
        'message',
        'mode',
        'attachments',
        'goal',
      ]);
      if (!fields.ok) return fields;
      const { conversationId, message: text, mode, attachments, goal } = fields.value;
      const profile = await profileOf(ports);
      const check = await checkOperate(ports, conversationId, profile);
      if (!check.ok) return deny(ports, ctx, 'session_send', check.code, conversationId);
      if (queuedStartOf((await ports.rows())[conversationId]))
        return deny(ports, ctx, 'session_send', 'session-queued', conversationId);
      const source = check.source;
      // 权限过了再读文件：图片全部校验通过才投递，任何一张不合法都在发出之前拒绝
      const forwarded = await loadAttachments(attachments);
      if (!forwarded.ok)
        return auditFailure(ports, ctx, 'session_send', forwarded.error, conversationId);
      const images = forwarded.value;
      const imageNote = images.length > 0 ? `; images: ${describeForwardedImages(images)}` : '';
      // 能不能看图要等会话就绪才知道：在每条投递路径上、真正发出前再拼
      const message = () => sendableMessage(ports, conversationId, text, images);
      const track = async () => {
        if (source === 'scope')
          await trackScopeSession(ports, conversationId, check.projectId, ctx);
      };
      const status = await ports.status(conversationId);
      // 秘书不能替用户回答提问或审批工具调用：两种模式都拒绝
      if (status.pendingAsks + status.pendingApprovals > 0) {
        return deny(ports, ctx, 'session_send', 'needs-user', conversationId);
      }
      // 带目标时先挂上再发：受阻、暂停的旧目标不会再续跑，可以替换；
      // 正在跑或在等外部条件的目标拒绝，不能把进行中的目标盖掉
      if (goal) {
        const attached = await ports.attachGoal?.(conversationId, goal, REPLACEABLE_GOAL_STATUSES);
        if (!attached?.ok) return deny(ports, ctx, 'session_send', 'goal-active', conversationId);
        if (attached.replaced) {
          ports.audit({
            at: ports.now(),
            secretaryConversationId: ctx.secretaryConversationId,
            op: 'session_goal_replace',
            targetId: conversationId,
            ok: true,
            detail: `${attached.replaced.status}: ${redactSecrets(attached.replaced.text).slice(0, 500)}`,
          });
        }
        const file = ports.dispatchFile();
        const record = file.dispatched[conversationId];
        if (record) {
          record.goal = goal;
          ports.saveDispatch(file);
        }
      }
      const ownStatus = ports.ownStatus ? await ports.ownStatus(conversationId) : status;
      if (ownStatus.state === 'running') {
        // 插话复用用户自己的 steer 通道：pi 在当前工具调用结束后读到它，不等整轮结束
        if (mode === 'steer') {
          const body = await message();
          const steered = await ports.steer(conversationId, body.text, ports.newId(), body.images);
          if (!steered.ok) {
            return auditFailure(
              ports,
              ctx,
              'session_send',
              steered.error ?? 'steer-failed',
              conversationId
            );
          }
          await track();
          await noteDispatchResumed(ports, conversationId, { newGoal: Boolean(goal) });
          ports.audit({
            at: ports.now(),
            secretaryConversationId: ctx.secretaryConversationId,
            op: 'session_send',
            targetId: conversationId,
            ok: true,
            detail: `steered (${source})${imageNote}`,
          });
          notifySecretaryChanged();
          return { ok: true, result: { status: 'steered' } };
        }
        const body = await message();
        const queued = await ports.appendQueued(conversationId, {
          id: ports.newId(),
          text: body.text,
          ...(body.images ? { images: body.images } : {}),
          origin: 'secretary',
          ...(ctx.secretaryConversationId ? { by: ctx.secretaryConversationId } : {}),
          at: ports.now(),
        });
        if (!queued) {
          return deny(ports, ctx, 'session_send', 'not-found', conversationId);
        }
        await track();
        await noteDispatchResumed(ports, conversationId, { newGoal: Boolean(goal) });
        ports.audit({
          at: ports.now(),
          secretaryConversationId: ctx.secretaryConversationId,
          op: 'session_send',
          targetId: conversationId,
          ok: true,
          detail: `queued (${source})${imageNote}`,
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
      const body = await message();
      const prompted = await ports.prompt(conversationId, body.text, ports.newId(), body.images);
      if (!prompted.ok) {
        return auditFailure(
          ports,
          ctx,
          'session_send',
          prompted.error ?? 'prompt-failed',
          conversationId
        );
      }
      await track();
      ports.audit({
        at: ports.now(),
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'session_send',
        targetId: conversationId,
        ok: true,
        detail: `sent (${source})${imageNote}`,
      });
      await noteDispatchResumed(ports, conversationId, { newGoal: Boolean(goal) });
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
      // 等依赖的派发还没有会话：用同一个 id 取消它
      const cancelled = await cancelPending(ports, ctx, conversationId);
      if (cancelled) return cancelled;
      const check = await checkOperate(ports, conversationId, await profileOf(ports));
      if (!check.ok) return deny(ports, ctx, 'session_stop', check.code, conversationId);
      // 排队会话还没开始：停止就是取消，会话直接删掉
      if (queuedStartOf((await ports.rows())[conversationId])) {
        const cancelled = (await ports.cancelQueued?.(
          conversationId,
          ctx.secretaryConversationId
        )) ?? { ok: false as const, error: 'queued sessions unsupported' };
        if (!cancelled.ok)
          return auditFailure(ports, ctx, 'session_stop', cancelled.error, conversationId);
        return { ok: true, result: { status: 'cancelled', conversationId, deleted: true } };
      }
      // 范围接管的会话：停下也算真正用上了它，从这里开始跟踪
      if (check.source === 'scope')
        await trackScopeSession(ports, conversationId, check.projectId, ctx);
      const file = ports.dispatchFile();
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
      // 停止就是停止：目标一并暂停，续跑与看门狗都撤掉，免得它自己又跑起来把代码合了
      await ports.pauseGoal(conversationId);
      ports.forget?.(conversationId);
      const record = file.dispatched[conversationId];
      // 停下就收口：残留的运行中与后台任务记录会让它一直被算在跑
      if (record) {
        const now = ports.now();
        if (record.lastState !== 'idle') record.stateSince = now;
        record.lastState = 'idle';
        record.stoppedAt = now;
        // 停之前已经交过完成结果保留；其余历史失败/受阻随主动停止清掉
        if (record.lastResult && record.lastResult.kind !== 'goal-complete')
          delete record.lastResult;
        delete record.backgroundRunning;
        delete record.reopenedAt;
        delete record.stalledTurn;
        delete record.patrol;
        delete record.failurePending;
        ports.saveDispatch(file);
      }
      const stopped = markTodoProblem(await ports.todos(), conversationId, 'stopped', ports.now());
      if (stopped.changed) ports.saveTodos(stopped.todos);
      // 等 worker 确认：最多 10 秒。没停下就如实返回 running，不假装停住了
      const state = ports.waitStopped
        ? await ports.waitStopped(conversationId, STOP_CONFIRM_TIMEOUT_MS)
        : (await ports.status(conversationId)).state;
      ports.audit({
        at: ports.now(),
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'session_stop',
        targetId: conversationId,
        ok: true,
        detail: `${state === 'running' ? 'still-running' : 'stopped'} (${check.source})${
          cleared > 0 ? `, cleared ${cleared} queued` : ''
        }`,
      });
      notifySecretaryChanged();
      if (state === 'running') {
        return {
          ok: true,
          result: {
            status: 'running',
            note: 'the worker has not stopped yet after 10 seconds; the goal is paused and it will not be continued, but the current turn may still finish',
            ...(cleared > 0 ? { clearedQueued: cleared } : {}),
          },
        };
      }
      return {
        ok: true,
        result: { status: 'stopped', ...(cleared > 0 ? { clearedQueued: cleared } : {}) },
      };
    },

    /**
     * 停一个后台任务。只允许停自己派发或跟踪的会话里的任务：
     * 范围权限还没真正用上的会话没有记录，一律拒绝。不杀进程以外的任何东西，审计留痕。
     */
    async session_task_stop(params, ctx) {
      const fields = sessionFields(params, ['conversationId', 'taskId']);
      if (!fields.ok) return fields;
      const { conversationId, taskId } = fields.value;
      const check = await checkOperate(ports, conversationId, await profileOf(ports));
      if (!check.ok) return deny(ports, ctx, 'session_task_stop', check.code, conversationId);
      if (check.source === 'scope' && !ports.dispatchFile().dispatched[conversationId])
        return deny(ports, ctx, 'session_task_stop', 'not-operable', conversationId);
      const task = (await ports.tasks(conversationId)).find(
        (candidate) => candidate.taskId === taskId
      );
      if (!task)
        return {
          ok: false,
          error: 'not-found: no background task with this id in that session',
        };
      if (task.status !== 'running')
        return { ok: false, error: `not-running: the task already ${task.status}` };
      const stopped = await ports.stopTask(conversationId, taskId);
      ports.audit({
        at: ports.now(),
        secretaryConversationId: ctx.secretaryConversationId,
        op: 'session_task_stop',
        targetId: conversationId,
        ok: stopped.ok,
        detail: stopped.ok ? `stopped ${taskId}` : `${taskId}: ${stopped.error ?? 'failed'}`,
      });
      notifySecretaryChanged();
      if (!stopped.ok) return { ok: false, error: stopped.error ?? 'stop failed' };
      return { ok: true, result: { status: 'stopped', conversationId, taskId } };
    },

    /**
     * 归档会话：效果与用户手动归档一致（侧栏消失、进归档区），只认派发或接管跟踪的记录，
     * 且必须已经终态、空闲、没有待处理项。批量逐条给结果，逐条审计。
     */
    async session_archive(params, ctx) {
      const ids = archiveIds(params);
      if (!ids) {
        return {
          ok: false,
          error: `invalid arguments: pass "conversationId" or "ids" with 1-${MAX_ARCHIVE_IDS} session ids`,
        };
      }
      const results: ArchiveOutcome[] = [];
      for (const conversationId of ids) {
        const refusal = await archiveRefusal(ports, conversationId);
        if (refusal) {
          results.push({ conversationId, status: 'skipped', reason: refusal });
          ports.audit({
            at: ports.now(),
            secretaryConversationId: ctx.secretaryConversationId,
            op: 'session_archive',
            targetId: conversationId,
            ok: false,
            detail: refusal,
          });
          continue;
        }
        try {
          await ports.cleanup.archive(conversationId, ports.now(), 'session_archive');
          results.push({ conversationId, status: 'archived' });
          // 归档的会话不会再报结果：关注项一并移除
          ports.unfollow?.(conversationId);
          ports.audit({
            at: ports.now(),
            secretaryConversationId: ctx.secretaryConversationId,
            op: 'session_archive',
            targetId: conversationId,
            ok: true,
            detail: 'archived',
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'archive failed';
          results.push({ conversationId, status: 'failed', reason });
          ports.audit({
            at: ports.now(),
            secretaryConversationId: ctx.secretaryConversationId,
            op: 'session_archive',
            targetId: conversationId,
            ok: false,
            detail: reason,
          });
        }
      }
      notifySecretaryChanged();
      const count = (status: ArchiveStatus) =>
        results.filter((entry) => entry.status === status).length;
      return {
        ok: true,
        result: {
          results: results.map((entry) => ({
            ...entry,
            ...(entry.reason ? { reason: ARCHIVE_REFUSALS[entry.reason] ?? entry.reason } : {}),
          })),
          archived: count('archived'),
          skipped: count('skipped'),
          failed: count('failed'),
        },
      };
    },

    /**
     * 取消归档：拉回自己派出或跟踪、且由秘书归档的会话。效果与用户手动取消归档一致。
     * 用户自己归档的、或分不清来源的，拒绝。
     */
    async session_unarchive(params, ctx) {
      const ids = archiveIds(params);
      if (!ids) {
        return {
          ok: false,
          error: `invalid arguments: pass "conversationId" or "ids" with 1-${MAX_ARCHIVE_IDS} session ids`,
        };
      }
      const profile = await profileOf(ports);
      const results: ArchiveOutcome[] = [];
      for (const conversationId of ids) {
        const refusal = await unarchiveRefusal(ports, conversationId, profile);
        if (refusal) {
          results.push({ conversationId, status: 'skipped', reason: refusal });
          ports.audit({
            at: ports.now(),
            secretaryConversationId: ctx.secretaryConversationId,
            op: 'session_unarchive',
            targetId: conversationId,
            ok: false,
            detail: refusal,
          });
          continue;
        }
        const via = archivedBySecretary(
          ports.dispatchFile().dispatched[conversationId]!,
          (await ports.rows())[conversationId]
        );
        try {
          await ports.cleanup.unarchive(conversationId);
          results.push({ conversationId, status: 'unarchived' });
          ports.audit({
            at: ports.now(),
            secretaryConversationId: ctx.secretaryConversationId,
            op: 'session_unarchive',
            targetId: conversationId,
            ok: true,
            detail: `unarchived (${via})`,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'unarchive failed';
          results.push({ conversationId, status: 'failed', reason });
          ports.audit({
            at: ports.now(),
            secretaryConversationId: ctx.secretaryConversationId,
            op: 'session_unarchive',
            targetId: conversationId,
            ok: false,
            detail: reason,
          });
        }
      }
      notifySecretaryChanged();
      const count = (status: ArchiveStatus) =>
        results.filter((entry) => entry.status === status).length;
      return {
        ok: true,
        result: {
          results: results.map((entry) => ({
            ...entry,
            ...(entry.reason ? { reason: UNARCHIVE_REFUSALS[entry.reason] ?? entry.reason } : {}),
          })),
          unarchived: count('unarchived'),
          skipped: count('skipped'),
          failed: count('failed'),
        },
      };
    },

    /** 看板「标记完成」：把派发记录收口为完成，与用户点按钮走同一条逻辑 */
    async result_mark_done(params, ctx) {
      return markResultOp(ports, ctx, params, 'done');
    },

    /** 看板「撤销标记」：只撤销手动标记的完成 */
    async result_mark_undo(params, ctx) {
      return markResultOp(ports, ctx, params, 'undo');
    },

    /** 筛选过的 needsUser：确实要用户亲手做或决定的那条升级进「需要你」 */
    async needs_user_escalate(params, ctx) {
      const { conversationId, needsUserIndex, text } = params;
      const extra = Object.keys(params).filter((key) => !ESCALATE_FIELDS.includes(key));
      if (
        extra.length > 0 ||
        typeof conversationId !== 'string' ||
        !conversationId.trim() ||
        typeof needsUserIndex !== 'number' ||
        !Number.isInteger(needsUserIndex) ||
        needsUserIndex < 0 ||
        (text !== undefined && typeof text !== 'string')
      ) {
        return {
          ok: false,
          error: `invalid arguments: pass conversationId (string), needsUserIndex (integer N from needs-user[N]) and optionally text (string); allowed fields: ${ESCALATE_FIELDS.join(', ')}`,
        };
      }
      const link = { conversationId: conversationId.trim(), needsUserIndex };
      const result = escalateNeedsUser(ports, link, text, 'secretary');
      if (!result.ok) {
        auditFailure(ports, ctx, 'needs_user_escalate', result.error, link.conversationId);
        return { ok: false, error: ESCALATE_REFUSALS[result.error] ?? result.error };
      }
      return { ok: true, result: { status: 'escalated', ...link } };
    },

    async session_answer(params, ctx) {
      const conversationId = stringParam(params, 'conversationId');
      if (!conversationId)
        return { ok: false, error: 'invalid arguments: "conversationId" is required' };
      const askId = stringParam(params, 'askId');
      if (!askId) return { ok: false, error: 'invalid arguments: "askId" is required' };
      const answer = stringParam(params, 'answer');
      if (!answer) return { ok: false, error: 'invalid arguments: "answer" is required' };
      if (!ctx.secretaryConversationId) return invalidArguments;
      const op = 'session_answer';
      if (answer.length > RELAY_ASK_MAX_CHARS) {
        return auditFailure(
          ports,
          ctx,
          op,
          `invalid arguments: "answer" is ${answer.length} characters, max ${RELAY_ASK_MAX_CHARS}`,
          conversationId
        );
      }
      const profile = await profileOf(ports);
      const check = await checkOperate(ports, conversationId, profile);
      if (!check.ok) return deny(ports, ctx, op, check.code, conversationId);
      const label = await sessionLabelOf(ports, conversationId);
      // 读改写之间不留 await：并发的两次回答只有一次写进去
      const file = ports.dispatchFile();
      const relay = pendingRelay(file, conversationId, askId);
      if (!relay)
        return auditFailure(
          ports,
          ctx,
          op,
          'not-found: no question with this id is waiting in that session',
          conversationId
        );
      const now = ports.now();
      if (relay.status !== 'pending') {
        const who =
          relay.status === 'answered'
            ? 'you already answered it'
            : relay.status === 'user-answered'
              ? 'the user answered it directly'
              : 'it timed out';
        return auditFailure(ports, ctx, op, `already-closed: ${who}`, conversationId);
      }
      if (relay.expiresAt !== undefined && now >= relay.expiresAt) {
        const closed = closeRelayAsk(file, { conversationId, askId, by: 'timeout' }, now, label);
        if (closed.update) file.outbox = enqueueUpdate(file.outbox, closed.update);
        ports.saveDispatch(file);
        return auditFailure(
          ports,
          ctx,
          op,
          'timed-out: the question already expired, so the session went on without an answer',
          conversationId
        );
      }
      closeRelayAsk(file, { conversationId, askId, by: 'relay', answer }, now, label);
      ports.saveDispatch(file);
      const delivered = await ports.answer(conversationId, askId, answer, profile.name);
      if (!delivered.ok) {
        // 送不进去：把记录退回挂起，会话恢复后秘书还能再答一次
        const retry = ports.dispatchFile();
        const current = pendingRelay(retry, conversationId, askId);
        if (current?.status === 'answered') {
          retry.relays = {
            ...(retry.relays ?? {}),
            [relayKey(conversationId, askId)]: {
              conversationId,
              askId,
              question: current.question,
              at: current.at,
              status: 'pending',
              ...(current.options ? { options: current.options } : {}),
              ...(current.defaultOption ? { defaultOption: current.defaultOption } : {}),
              ...(current.expiresAt !== undefined ? { expiresAt: current.expiresAt } : {}),
            },
          };
          ports.saveDispatch(retry);
        }
        return auditFailure(
          ports,
          ctx,
          op,
          `deliver-failed: ${delivered.error ?? 'unknown'}`,
          conversationId
        );
      }
      ports.audit({
        at: now,
        secretaryConversationId: ctx.secretaryConversationId,
        op,
        targetId: conversationId,
        ok: true,
        detail: askId,
      });
      notifySecretaryChanged();
      return { ok: true, result: { status: 'answered', conversationId, askId } };
    },

    async todo_list(params) {
      const status = stringParam(params, 'status');
      if (status && !(TODO_STATUSES as readonly string[]).includes(status)) return invalidArguments;
      const projectId = stringParam(params, 'projectId');
      const profile = await profileOf(ports);
      const projects = visibleProjects(await ports.projects(), profile);
      if (projectId && !projects.some((project) => project.projectId === projectId))
        return { ok: false, error: 'not-found' };
      const aliases = (await ports.projectAliases?.()) ?? {};
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
              await ports.status(todo.conversationId),
              false,
              ((await ports.subagents?.(todo.conversationId))?.length ?? 0) > 0
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
          ...(project ? { projectName: secretaryProjectName(project, aliases) } : {}),
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
      const now = ports.now();
      const title = typeof checked.row.title === 'string' ? checked.row.title.trim() : '';
      const reason = stringParam(params, 'reason');
      // 同一会话已有一张待确认的卡就复用，不再叠一张
      const { saved, changed } = saveProposalRecord(file, {
        id: ports.newId(),
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
      });
      if (changed) {
        ports.saveDispatch(file);
        notifySecretaryChanged();
      }
      ports.audit({
        at: now,
        secretaryConversationId: ctx.secretaryConversationId,
        op,
        targetId: saved.proposalId,
        ok: true,
        detail: saved.reused ? 'awaiting_confirmation (existing)' : 'awaiting_confirmation',
      });
      return {
        ok: true,
        result: {
          status: 'awaiting_confirmation',
          proposalId: saved.proposalId,
          ...(saved.reused ? { reused: true } : {}),
          ...(saved.note ? { note: saved.note } : {}),
        },
      };
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
      const paths = attachmentPaths(params.attachments);
      if (!paths.ok) return paths;
      const todos = await ports.todos();
      const todo = todos.find((candidate) => candidate.id === todoId);
      if (!todo) return auditFailure(ports, ctx, 'todo_item_dispatch', 'not-found', todoId);
      const projectId = stringParam(params, 'projectId') ?? todo.projectId;
      if (!projectId) {
        return auditFailure(ports, ctx, 'todo_item_dispatch', 'project-required', todoId);
      }
      const title = stringParam(params, 'title') ?? todoTitle(todo.text);
      // 待办多半是改代码的活：秘书没说就开 worktree，只读调查时它会显式传 false
      const worktree = typeof params.worktree === 'boolean' ? params.worktree : true;
      const base = baseFromParams(params);
      const goal = stringParam(params, 'goal') ?? todoDefaultGoal(todo.text);
      const draft: DispatchDraft = {
        projectId,
        prompt: todoDispatchPrompt(todo.text, stringParam(params, 'prompt')),
        // 不给标题时会话按 prompt 开头起名，prompt 常以共同背景开头，几个会话会重名
        ...(title ? { title } : {}),
        ...(goal ? { goal } : {}),
        worktree,
        todoId,
        ...(base ?? {}),
      };
      const after = afterParam(params);
      if (after) draft.after = after;
      const model = modelParam(params.model);
      if (model) draft.model = model;
      if (paths.value.length > 0) draft.attachments = paths.value;
      const outcome = await dispatchDraft(ports, ctx.secretaryConversationId, draft);
      return outcomeResult(ports, ctx, 'todo_item_dispatch', outcome, todoId);
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
  outcome: { ok: true; conversationId?: string; report?: string } | { ok: false; error: string }
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
  notifyProposalAccepted();
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
  // 点了就推：确认先推「已确认，正在执行」，取消直接推「已取消」。
  // 等执行完再推，秘书会以为卡还没被点，于是又提一张。
  // 档案、技能、工具只是写盘，转眼就完，且写完要释放秘书会话：只推终态，否则释放会中止这次投递
  const writesKit =
    action === 'confirm' &&
    (transitioned.proposal.kind === 'profile' ||
      transitioned.proposal.kind === 'skill' ||
      transitioned.proposal.kind === 'tool');
  if (!writesKit) {
    file.outbox = enqueueUpdate(file.outbox, proposalUpdate(transitioned.proposal, now));
  }
  ports.saveDispatch(file);
  ports.audit({
    at: now,
    secretaryConversationId: proposal.secretaryConversationId,
    op: action === 'confirm' ? 'proposal_confirm' : 'proposal_reject',
    targetId: proposalId,
    ok: true,
    ...(action === 'confirm' ? { detail: 'accepted' } : {}),
  });
  notifySecretaryChanged();
  if (action === 'reject') {
    // 卡被拒了：关注列表里那条待确认的派发不会再有结果
    ports.unfollow?.(proposalId);
    return { ok: true, proposal: transitioned.proposal };
  }
  // 立刻投递，不等下一分钟的 tick
  if (!writesKit) notifyProposalAccepted();
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
  if (transitioned.proposal.kind === 'cleanup') {
    // 卡片上的清单只是快照：执行时按 id 重新校验一遍，未合入、在用、有未提交改动的都跳过
    const applied = await applyCleanup(
      ports.cleanup,
      transitioned.proposal.draft,
      transitioned.proposal.secretaryConversationId
    );
    return finishProposal(ports, proposalId, {
      ok: true,
      report: cleanupReportText(applied),
    });
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
  const validated = validateDispatch(
    draft,
    await dispatchContext(ports, profile, draft.projectId, (draft.after?.length ?? 0) > 0)
  );
  if (!validated.ok)
    return finishProposal(ports, proposalId, { ok: false, error: validated.error });
  const base = await checkBase(ports, validated.draft);
  if (!base.ok) return finishProposal(ports, proposalId, { ok: false, error: base.error });
  const started = await startDispatch(
    ports,
    validated.draft,
    proposal.secretaryConversationId,
    profile,
    undefined,
    validated.overLimit
  );
  // 关注项从卡片改挂到真正建出来的会话（或等待中的派发）上
  if (started.kind === 'pending') ports.refollow?.(proposalId, started.pendingId);
  else if (started.kind !== 'failed') ports.refollow?.(proposalId, started.conversationId);
  return finishProposal(
    ports,
    proposalId,
    started.kind === 'failed'
      ? { ok: false, error: started.error }
      : started.kind === 'pending'
        ? { ok: true }
        : { ok: true, conversationId: started.conversationId }
  );
}

export type TodoMutateResult = { ok: true; todoId: string } | { ok: false; error: string };

export type DismissResultResult = { ok: true } | { ok: false; error: string };

export type MarkResultAction = 'done' | 'undo' | 'dismiss';

export type MarkResultResult = { ok: true } | { ok: false; error: string };

/** 谁点的：用户界面按钮、秘书的工具调用，还是用户答完了秘书带关联转问的全部 needsUser */
export type MarkResultSource = 'ui' | 'secretary' | 'answer';

const MARK_SOURCE_DETAIL: Record<MarkResultSource, string> = {
  ui: 'manual',
  secretary: 'secretary',
  answer: 'answered',
};

/**
 * 用户手动收口一条派发记录：done 记成完成并标 manual（卡片给撤销），
 * undo 把这条手动结果撤掉、放回进行中。只认派发或接管的记录，普通会话不动。
 * done 时受阻、暂停的目标不会再续跑，一并收掉，免得之后追加任务被它挡住；undo 放回去。
 */
export async function markResult(
  ports: SecretaryDispatchPorts,
  conversationId: string,
  action: MarkResultAction,
  source: MarkResultSource = 'ui'
): Promise<MarkResultResult> {
  const before = ports.dispatchFile().dispatched[conversationId];
  if (!before) return { ok: false, error: 'not-found' };
  if (action === 'undo' && before.lastResult?.manual !== true)
    return { ok: false, error: 'not-manual' };
  // 改会话行要等异步写回：先动目标，再读最新的派发记录改，免得用旧快照覆盖
  let goalNote: string | undefined;
  let closedGoal: ClosedGoal | null = null;
  if (action === 'done') {
    closedGoal = (await ports.closeGoal?.(conversationId, REPLACEABLE_GOAL_STATUSES)) ?? null;
    if (closedGoal) goalNote = `goal closed (${closedGoal.status})`;
  } else if (action === 'undo' && before.closedGoal) {
    if (await ports.restoreGoal?.(conversationId, before.closedGoal))
      goalNote = `goal restored (${before.closedGoal.status})`;
  }
  const file = ports.dispatchFile();
  const record = file.dispatched[conversationId];
  if (!record) return { ok: false, error: 'not-found' };
  const now = ports.now();
  const op =
    action === 'done'
      ? 'result_mark_done'
      : action === 'undo'
        ? 'result_mark_undo'
        : 'result_dismiss_board';
  if (action === 'done') {
    record.lastResult = { kind: 'goal-complete', turn: record.turn, at: now, manual: true };
    const cleanedGoalResult = stripGoalResultNeedsUser(record.goalResult);
    if (cleanedGoalResult) record.goalResult = cleanedGoalResult;
    else delete record.goalResult;
    if (record.lastState !== 'idle') record.stateSince = now;
    record.lastState = 'idle';
    delete record.stoppedAt;
    delete record.failurePending;
    delete record.backgroundRunning;
    delete record.backgroundPersistent;
    delete record.leftoverTasks;
    delete record.reopenedAt;
    delete record.manualUndoneAt;
    delete record.dismissedFromBoard;
    if (closedGoal) record.closedGoal = closedGoal;
    else delete record.closedGoal;
    if (ports.recordDaily) {
      const row = (await ports.rows())[conversationId];
      const title = typeof row?.title === 'string' && row.title.trim() ? row.title.trim() : '';
      ports.recordDaily({
        at: now,
        conversationId,
        kind: 'goal-complete',
        ...(record.projectId ? { projectId: record.projectId } : {}),
        ...(title ? { title: redactSecrets(title) } : {}),
      });
    }
  } else if (action === 'dismiss') {
    // 移出只动看板记录：不标完成，不碰会话与历史
    if (record.lastState !== 'idle') record.stateSince = now;
    record.lastState = 'idle';
    record.dismissedFromBoard = true;
    delete record.backgroundRunning;
    delete record.backgroundPersistent;
    delete record.reopenedAt;
    delete record.manualUndoneAt;
  } else {
    // 只撤销用户自己标的完成：会话给出的结果不能被界面抹掉
    if (record.lastResult?.manual !== true) return { ok: false, error: 'not-manual' };
    delete record.lastResult;
    if (record.lastState !== 'running') record.stateSince = now;
    record.lastState = 'running';
    record.manualUndoneAt = now;
    delete record.dismissedFromBoard;
    delete record.closedGoal;
  }
  ports.saveDispatch(file);
  ports.audit({
    at: now,
    secretaryConversationId: record.secretaryConversationId,
    op,
    targetId: conversationId,
    ok: true,
    detail: [MARK_SOURCE_DETAIL[source], goalNote].filter(Boolean).join('; '),
  });
  notifySecretaryChanged();
  return { ok: true };
}

export type AnswerNeedsUserResult = { ok: true; cleared: boolean } | { ok: false; error: string };

const ANSWER_MAX_CHARS = 500;
const ESCALATE_TEXT_MAX_CHARS = 300;
const ESCALATE_FIELDS: readonly string[] = ['conversationId', 'needsUserIndex', 'text'];

const ESCALATE_REFUSALS: Record<string, string> = {
  'not-found':
    'refused (not-found): only a session you dispatched or track has needsUser items to escalate',
  'nothing-pending':
    'refused (nothing-pending): this session has no unsettled goal-complete result with needsUser; a goal-blocked result already goes to the user directly',
  'bad-index': 'refused (bad-index): needsUserIndex is past the end of the needs-user[N] list',
};

/** 只认没收口的 goal-complete：goal-blocked 的 needsUser 不经筛选，答了也不能记成完成 */
function pendingNeedsUser(record: DispatchRecord): GoalResultView | undefined {
  const result = record.lastResult;
  const pending =
    result !== undefined &&
    result.kind === 'goal-complete' &&
    !result.manual &&
    !result.dismissed &&
    hasNeedsUser(record.goalResult);
  return pending ? record.goalResult : undefined;
}

/**
 * 秘书把一条 needsUser 升级给用户：卡片进「需要你」，显示改写后的文字。
 * 秘书带 relatesTo 提问时宿主也走这里（via ask），不用秘书再调工具。
 */
export function escalateNeedsUser(
  ports: SecretaryDispatchPorts,
  link: AskRelatesTo,
  text?: string,
  via: 'secretary' | 'ask' = 'secretary'
): { ok: true } | { ok: false; error: string } {
  const { conversationId, needsUserIndex } = link;
  const file = ports.dispatchFile();
  const record = file.dispatched[conversationId];
  // 秘书工具的失败由 handler 记审计；带关联提问的由宿主触发，在这里记
  const refuse = (error: string): { ok: false; error: string } => {
    if (via === 'ask')
      ports.audit({
        at: ports.now(),
        secretaryConversationId: record?.secretaryConversationId ?? null,
        op: 'needs_user_escalate',
        targetId: conversationId,
        ok: false,
        detail: `ask: ${error}`,
      });
    return { ok: false, error };
  };
  if (!record) return refuse('not-found');
  const view = pendingNeedsUser(record);
  if (!view) return refuse('nothing-pending');
  const count = needsUserItems(view).length;
  if (needsUserIndex !== undefined && needsUserIndex >= count) return refuse('bad-index');
  const now = ports.now();
  const rewritten = text ? redactSecrets(text.trim()).slice(0, ESCALATE_TEXT_MAX_CHARS) : '';
  record.goalResult = escalateGoalResultNeedsUser(
    view,
    needsUserIndex,
    rewritten || undefined,
    now
  );
  ports.saveDispatch(file);
  const targets = needsUserIndex === undefined ? [...Array(count).keys()] : [needsUserIndex];
  ports.audit({
    at: now,
    secretaryConversationId: record.secretaryConversationId,
    op: 'needs_user_escalate',
    targetId: conversationId,
    ok: true,
    detail: [`${via} #${targets.join(',')}`, rewritten].filter(Boolean).join(': '),
  });
  notifySecretaryChanged();
  return { ok: true };
}

/**
 * 秘书带 relatesTo 转问的 needsUser 被用户答复：答复记到那份结果上，卡片标出已答复；
 * 答复同时算升级；全部条目都答了就按 result_mark_done 收口，不用秘书再手动标；
 * 还剩没升级的条目时回到秘书手里，由它接着问、升级或手动收口。
 * 只认 goal-complete：goal-blocked 的活没干完，答了也不能记成完成。
 * 提问之后才到的新结果不认这次答复，免得旧问题的答案落到新条目上。
 */
export async function answerNeedsUser(
  ports: SecretaryDispatchPorts,
  link: AskRelatesTo,
  answer: string,
  askedAt: number
): Promise<AnswerNeedsUserResult> {
  const { conversationId, needsUserIndex } = link;
  const rows = await ports.rows();
  const file = ports.dispatchFile();
  const record = file.dispatched[conversationId];
  if (!record) return { ok: false, error: 'not-found' };
  const view = pendingNeedsUser(record);
  if (!view) return { ok: false, error: 'nothing-pending' };
  if (view.at > askedAt) return { ok: false, error: 'stale' };
  const count = needsUserItems(view).length;
  if (needsUserIndex !== undefined && needsUserIndex >= count)
    return { ok: false, error: 'bad-index' };
  const now = ports.now();
  const text = redactSecrets(answer.trim()).slice(0, ANSWER_MAX_CHARS);
  const targets = needsUserIndex === undefined ? [...Array(count).keys()] : [needsUserIndex];
  const escalated = new Set((view.escalations ?? []).map((item) => item.index));
  const withEscalation = targets
    .filter((target) => !escalated.has(target))
    .reduce((next, target) => escalateGoalResultNeedsUser(next, target, undefined, now), view);
  record.goalResult = answerGoalResultNeedsUser(withEscalation, needsUserIndex, text, now);
  ports.saveDispatch(file);
  ports.audit({
    at: now,
    secretaryConversationId: record.secretaryConversationId,
    op: 'needs_user_answered',
    targetId: conversationId,
    ok: true,
    detail: `#${targets.join(',')}: ${text}`,
  });
  const shown = shownNeedsUser(
    record.goalResult,
    secretaryLiveIn(
      rows,
      record.secretaryConversationId,
      (await ports.secretaryEnabled?.()) ?? true
    ),
    now
  );
  if (shown.triaging || shown.answers.length < shown.items.length) {
    notifySecretaryChanged();
    return { ok: true, cleared: false };
  }
  const marked = await markResult(ports, conversationId, 'done', 'answer');
  return marked.ok ? { ok: true, cleared: true } : marked;
}

/** 用户点过「知道了」：只标记这条结果，会话本身不动；新结果整体替换 lastResult，标记自然失效 */
export function dismissResult(
  ports: SecretaryDispatchPorts,
  conversationId: string
): DismissResultResult {
  const file = ports.dispatchFile();
  const record = file.dispatched[conversationId];
  if (!record) return { ok: false, error: 'not-found' };
  const result = record.lastResult;
  const needsUser =
    result !== undefined &&
    (NEEDS_YOU_RESULTS.has(result.kind) ||
      ((result.kind === 'goal-complete' || result.kind === 'goal-blocked') &&
        !result.manual &&
        hasNeedsUser(record.goalResult)));
  if (!result || !needsUser) return { ok: false, error: 'not-dismissible' };
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

/** 用户忽略一条出问题的等待派发：它不会再开始，直接从等待表里移除；等待中的不动 */
export function dismissPending(
  ports: SecretaryDispatchPorts,
  pendingId: string
): DismissResultResult {
  const file = ports.dispatchFile();
  const pending = file.pending?.[pendingId];
  if (!file.pending || !pending) return { ok: false, error: 'not-found' };
  if (pending.status !== 'failed') return { ok: false, error: 'not-dismissible' };
  delete file.pending[pendingId];
  if (Object.keys(file.pending).length === 0) delete file.pending;
  ports.saveDispatch(file);
  ports.audit({
    at: ports.now(),
    secretaryConversationId: pending.secretaryConversationId,
    op: 'pending_dismiss',
    targetId: pendingId,
    ok: true,
    detail: pending.problem ?? 'dispatch-failed',
  });
  notifySecretaryChanged();
  return { ok: true };
}

/**
 * 看板「停止遗留任务」：只停这条派发记录里疑似闲置的后台任务，已保留的和仍有活动的不动。
 * 只认派发或接管的记录；全部停完才把遗留标记清掉，不等下一次 tick。
 */
export async function stopLeftoverTasks(
  ports: SecretaryDispatchPorts,
  conversationId: string
): Promise<{ ok: true; stopped: string[] } | { ok: false; error: string }> {
  const record = ports.dispatchFile().dispatched[conversationId];
  if (!record) return { ok: false, error: 'not-found' };
  const running = (await ports.tasks(conversationId)).filter(
    (task: ObservedTask) => task.status === 'running'
  );
  const stopped: string[] = [];
  for (const task of running.filter((task) => task.suspectedIdle)) {
    const result = await ports.stopTask(conversationId, task.taskId);
    if (result.ok) stopped.push(task.taskId);
  }
  if (stopped.length > 0 && stopped.length === running.length) {
    const file = ports.dispatchFile();
    const current = file.dispatched[conversationId];
    if (current) {
      delete current.backgroundRunning;
      delete current.backgroundPersistent;
      delete current.leftoverTasks;
      delete current.leftoverPatrol;
      ports.saveDispatch(file);
    }
  }
  ports.audit({
    at: ports.now(),
    secretaryConversationId: record.secretaryConversationId,
    op: 'session_task_stop',
    targetId: conversationId,
    ok: true,
    detail: stopped.length > 0 ? `ui: ${stopped.join(',')}` : 'ui: nothing running',
  });
  notifySecretaryChanged();
  return { ok: true, stopped };
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
  projectAliases?(): MaybePromise<Readonly<Record<string, string>>>;
  status(conversationId: string): MaybePromise<SecretarySessionStatus>;
  subagents?(conversationId: string): MaybePromise<readonly AgentRunProgress[]>;
  reminders?(conversationId: string): MaybePromise<readonly SessionReminder[]>;
  threads?(): MaybePromise<readonly SecretaryDemandThreadView[]>;
  /** 秘书功能开关；缺省按开着 */
  secretaryEnabled?(): MaybePromise<boolean>;
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
    takeovers: takeoverViews(loaded.file, loaded.rows, loaded.projects, loaded.aliases),
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

/** 面板的工作台投影：手机上的只读命令与侧栏读同一份，不另拼一套 */
export async function secretaryBoard(ports: SecretaryStatePorts): Promise<SecretaryBoard> {
  return (await loadSecretaryBoard(ports)).board;
}

async function loadSecretaryBoard(ports: SecretaryStatePorts): Promise<{
  file: SecretaryDispatchFile;
  rows: Record<string, Record<string, unknown>>;
  projects: readonly ProjectAuthority[];
  aliases: Readonly<Record<string, string>>;
  board: SecretaryBoard;
}> {
  const file = ports.dispatchFile();
  const rows = await ports.rows();
  const projects = await ports.projects();
  const aliases = (await ports.projectAliases?.()) ?? {};
  const statuses: Record<string, SecretarySessionStatus> = {};
  const subagents: Record<string, readonly AgentRunProgress[]> = {};
  const reminders: Record<string, readonly SessionReminder[]> = {};
  for (const record of Object.values(file.dispatched)) {
    if (!rows[record.conversationId]) continue;
    statuses[record.conversationId] = await ports.status(record.conversationId);
    const runs = await ports.subagents?.(record.conversationId);
    if (runs && runs.length > 0) subagents[record.conversationId] = runs;
    const items = await ports.reminders?.(record.conversationId);
    if (items && items.length > 0) reminders[record.conversationId] = items;
  }
  return {
    file,
    rows,
    projects,
    aliases,
    board: buildBoard(file, {
      rows,
      statuses,
      subagents,
      reminders,
      projects,
      aliases,
      todos: await ports.todos(),
      threads: (await ports.threads?.()) ?? [],
      secretaryEnabled: (await ports.secretaryEnabled?.()) ?? true,
    }),
  };
}

/**
 * 一个秘书的生产端口：存储、审计、关注都落在它自己的目录里。
 * Main 的既有函数全部经动态 import 取：本模块被 tools.ts 静态依赖，静态反向依赖会成环。
 */
export function dispatchPortsFor(ctx: SecretaryContext): SecretaryDispatchPorts {
  const store = () => new SecretaryStore(ctx.dir);
  const follow = () => followDepsFor(ctx.dir);
  return {
    secretaryId: ctx.id,
    secretaryProjectId: () => ctx.projectId,
    secretaryEnabled: async () => (await import('./enabled')).secretaryEnabled(),
    managedElsewhere: async (conversationId) =>
      (await import('./crossSecretary')).managedElsewhere(ctx.id, conversationId),
    runningTotal: async () => (await import('./crossSecretary')).runningTotal(),
    cancelQueued: async (conversationId, secretaryConversationId) =>
      (await import('./queuedSessions')).cancelQueuedSession(
        conversationId,
        secretaryConversationId
      ),
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
    audit: (entry) => appendAudit(ctx.dir, entry),
    recordDaily: (entry) => appendDailyRecord(ctx.dir, entry),
    cleanup: realCleanupPorts(ctx),
    projects: async () =>
      (await import('../../ipc/agent')).getSourceAuthorityRegistry()?.projection().projects ?? [],
    async projectAliases() {
      return projectAliasesFromSettings((await import('../../ipc/settings')).readSettings());
    },
    conversations: async () =>
      (await import('../../ipc/agent')).getSourceAuthorityRegistry()?.projection().conversations ??
      [],
    rows: async () => (await import('../../ipc/settings')).readPersistedConversations(),
    status: async (conversationId) =>
      (await import('../../ipc/agent')).observedSessionStatus(conversationId),
    ownStatus: async (conversationId) =>
      (await import('../../ipc/agent')).observedOwnSessionStatus(conversationId),
    subagents: async (conversationId) =>
      (await import('../../ipc/agent')).observedSubagentProgress(conversationId),
    reminders: async (conversationId) =>
      (await import('../sessionReminders')).readSessionReminders(conversationId),
    async threads() {
      const rows = await (await import('../../ipc/settings')).readPersistedConversations();
      return (await import('../demandThreads')).secretaryDemandThreadViews(rows);
    },
    createSession: async (request) =>
      (await import('../../ipc/secretary')).createSessionViaMain(request),
    prompt: async (conversationId, text, deliveryId, images) =>
      (await import('../../ipc/agent')).promptRootFromMain(
        conversationId,
        text,
        deliveryId,
        images
      ),
    resume: async (conversationId) =>
      (await import('../../ipc/agent')).resumeRootFromMain(conversationId),
    alive: async (conversationId) =>
      (await import('../../ipc/agent')).isRootSessionAlive(conversationId),
    abort: async (conversationId) =>
      (await import('../../ipc/agent')).abortRootFromMain(conversationId),
    steer: async (conversationId, text, deliveryId, images) =>
      (await import('../../ipc/agent')).steerRootFromMain(conversationId, text, deliveryId, images),
    imageInput: async (conversationId) =>
      (await import('../../ipc/agent')).rootImageInput(conversationId),
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
          const id =
            value && typeof value === 'object' ? (value as { id?: unknown }).id : undefined;
          const hit = typeof id === 'string' && drop.has(id);
          if (hit) removed += 1;
          return !hit;
        });
        if (removed === 0) return;
        state.conversations[conversationId] = { ...row, queuedMessages: kept };
      });
      return removed;
    },
    attachGoal: async (conversationId, goal, replaceable) => {
      const { getDispatchDriver } = await import('../../ipc/secretary');
      const driver = getDispatchDriver();
      if (!driver) return { ok: false, error: 'driver unavailable' };
      return driver.attachGoal(conversationId, goal, replaceable);
    },
    closeGoal: async (conversationId, statuses) => {
      const { patchConversationsState } = await import('../../ipc/settings');
      let closed: ClosedGoal | null = null;
      patchConversationsState((state) => {
        const row = state.conversations[conversationId];
        const goal = row?.goal as Record<string, unknown> | undefined;
        if (!row || !goal || typeof goal !== 'object' || typeof goal.text !== 'string') return;
        if (!statuses.includes(goal.status as string)) return;
        closed = {
          text: goal.text,
          status: goal.status as ClosedGoal['status'],
          ...(typeof goal.note === 'string' && goal.note ? { note: goal.note } : {}),
        };
        state.conversations[conversationId] = { ...row, goal: undefined };
      });
      return closed;
    },
    restoreGoal: async (conversationId, goal) => {
      const { patchConversationsState } = await import('../../ipc/settings');
      let restored = false;
      patchConversationsState((state) => {
        const row = state.conversations[conversationId];
        if (!row || (row.goal && typeof row.goal === 'object')) return;
        restored = true;
        state.conversations[conversationId] = {
          ...row,
          goal: { ...goal, autoTurns: 0, noProgressRuns: 0 },
        };
      });
      return restored;
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
      const { secretaryProfileFor } = await import('./profile');
      const result = await secretaryProfileFor(ctx).save(draft, secretaryConversationId);
      return result.ok ? { ok: true } : result;
    },
    applySkill: async (draft, secretaryConversationId) => {
      const { secretarySkillFor } = await import('./skills');
      const result = await secretarySkillFor(ctx).save(draft, secretaryConversationId);
      return result.ok ? { ok: true } : result;
    },
    applyTool: async (draft, secretaryConversationId) => {
      const { secretaryToolFor } = await import('./customTools');
      const result = await secretaryToolFor(ctx).save(draft, secretaryConversationId);
      return result.ok ? { ok: true } : result;
    },
    newId: () => randomUUID(),
    now: () => Date.now(),
    baseFacts: async (input) => {
      const { probeDispatchBase } = await import('../worktree/service');
      return probeDispatchBase(input);
    },
    waitStopped: async (conversationId, timeoutMs) => {
      const { observedSessionStatus } = await import('../../ipc/agent');
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const state = observedSessionStatus(conversationId).state;
        if (state !== 'running' || Date.now() >= deadline) return state;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    forget: (conversationId) => {
      forgetListener?.(conversationId);
    },
    answer: async (conversationId, askId, answer, name) =>
      (await import('../../ipc/agent')).answerAskFromMain(conversationId, askId, answer, name),
    relayAsk: (conversationId, relay) => {
      void import('../../ipc/agent')
        .then((agent) => agent.setAskRelayFromMain(conversationId, relay ?? undefined))
        .catch(() => undefined);
    },
    tasks: async (conversationId) =>
      (await import('../../ipc/agent')).observedBackgroundTasks(conversationId),
    stopTask: async (conversationId, taskId) =>
      (await import('../../ipc/agent')).stopTaskFromMain(conversationId, taskId),
    /**
     * 与子代理可选模型同一套可用性判定：provider 存在且启用、有凭证、非分类器专用、
     * 模型行启用；虚拟模型按目录解析。这里只判定，不改任何配置。
     */
    resolveModel: async (ref) => {
      const {
        modelRefForSpawnConfig,
        providersFromSettings,
        resolveModelSelection,
        virtualModelsFromSettings,
      } = await import('../agentHost');
      const { readStoredOauthCredentialKeys } = await import('../oauthProviders');
      const { modelUsability } = await import('@shared/defaultModel');
      const { resolveDispatchModel } = await import('./dispatchModel');
      let keys: ReadonlySet<string>;
      try {
        keys = await readStoredOauthCredentialKeys();
      } catch {
        return { ok: false, error: 'model credentials unavailable' };
      }
      const providers = providersFromSettings();
      const credentials = {
        oauthCredentials: { status: 'ready' as const, authenticatedAccountKeys: keys },
      };
      return resolveDispatchModel(ref, {
        providers,
        virtualModels: virtualModelsFromSettings(),
        resolve: (wanted) => {
          const resolved = resolveModelSelection(wanted.providerId, wanted.modelId, keys, {
            allowVirtual: true,
          });
          return resolved.ok
            ? { ok: true, ref: modelRefForSpawnConfig(resolved.selection.config) }
            : resolved;
        },
        usable: (wanted) => modelUsability(wanted, providers, credentials) === 'usable',
      });
    },
    follow: (input) => {
      recordPhoneFollow(
        {
          kind: 'session',
          targetId: input.targetId,
          summary: input.summary,
          secretaryConversationId: input.secretaryConversationId,
        },
        follow()
      );
    },
    refollow: (from, to) => renameFollowedTarget(from, to, follow()),
    unfollow: (targetId) => unfollowTarget(targetId, follow()),
  };
}
