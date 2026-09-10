import type { AgentTypeKey } from '@shared/builtinAgents';
import type { CapabilityAskRequest } from '@shared/capabilities/types';
import { parseCompactCommand } from '@shared/compactCommand';
import {
  type DefaultModelRef,
  defaultApprovalMode,
  resolveChatModel,
  resolveChatReasoning,
  scopedDefaultModels,
} from '@shared/defaultModel';
import { isContinuationTurn } from '@shared/titleContinuation';
import type {
  ApprovalMode,
  AttachedImage,
  ChildConversationMetadata,
  ContextOccupancy,
  ConversationAuthorityProjection,
  DispatchMainEvent,
  ProjectAuthorityProjection,
  ProjectedMessage,
  RendererAgentEvent,
  ThinkingLevel,
  TitleSummaryInput,
  TurnDigest,
} from '@shared/types/agent';
import type { AgentDispatchResult, AgentDispatchTask } from '@shared/types/mentions';
import type { PairCreatedSession } from '@shared/types/pair';
import type {
  SessionWorktree,
  WorkspaceBranchSwitchResult,
  WorktreeStatus,
} from '@shared/types/worktree';
// 纯逻辑模块(仅类型级依赖),store 引用不破坏 node 环境测试
import {
  cleanTitleSummarySource,
  extractRepresentativeTitle,
} from '@/components/chat/mentionComposer';

/** 会话目标(pi-goal 式):active 时每次轮次收束自动续跑一次,直到终止信号或安全限制 */
export interface SessionGoal {
  text: string;
  status: 'active' | 'paused' | 'completed' | 'blocked' | 'waiting';
  /** 终止/暂停原因(goal 信号的 note 或安全限制说明) */
  note?: string;
  /** 已自动续跑的轮数(安全上限 25) */
  autoTurns: number;
  /** 连续无进展轮数(上一轮最终文本归一化后相同/为空;3 次暂停) */
  noProgressRuns: number;
  /** 上一轮最终 assistant 文本的归一化指纹 */
  lastOutput?: string;
}

/** 排队待发的用户消息(agent running 时入队,轮次结束自动投递) */
export interface QueuedMessage {
  id: string;
  text: string;
  images?: AttachedImage[];
}

import { projectSafeJournal } from '@shared/safeJournalProjection';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { oauthCredentialContext, useOauthCredentialStore } from '@/stores/oauthCredentials';
import { useSettingsStore } from '@/stores/settings';
import { createElectronPersistStorage, openPersistWriteGate } from '@/stores/settings/storage';
import { purgeConversationAuthority } from './authorityCleanup';
import {
  canWakeConversationForRewind,
  rewindWorkerPhase,
  shouldSendRewindCommand,
} from './conversationRewind';
import {
  evictColdMessages,
  hasAuthoritativeMessages,
  isBulkyAgentEvent,
  isMessageCacheHot,
  MESSAGE_CACHE_TTL_MS,
  needsHistoryHydration,
  needsWorkerSnapshot,
  pruneSessionClocks,
  stampViewDeparture,
  viewedConversationId,
} from './messageCache';
import { migrateSessions, SESSIONS_VERSION } from './migrate';
import { cachedPartializeSessions } from './persistSnapshot';
import { staleArchivedConversationIdsToDelete, staleUnarchivedConversationIds } from './pinned';
import { remapConversationProjectIds } from './projectAuthorityRemap';
import {
  applyAgentEvent,
  applyDispatchEvent,
  applyHistoryPage,
  emptyProjection,
  type SessionProjection,
  type TimelineMessage,
  truncatedNeedsSnapshotResync,
  upsertOutOfRange,
} from './reducer';
import { applyConversationReload } from './reload';
import { isPairViewed, nextUnread } from './unread';
import {
  DIRTY_MAIN_TREE,
  workspaceBranchChangedNote,
  workspaceFallbackNote,
  workspaceMigratedNote,
} from './worktree';

/** 离开时盖章；正在看的会话由 viewedId 保热，TTL 从离开起算 */
const lastViewedAt: Record<string, number> = {};
const parentTailInFlight = new Set<string>();
const olderHistoryInFlight = new Set<string>();
/**
 * 手动重读在途：同会话合并为一次 IPC；缓冲期间到达的实时事件，快照落地后按 seq 水位重放，
 * 防止 IPC reply 晚于实时事件时旧快照把新消息抹掉。实时事件本身仍照常即时上屏。
 */
const branchSwitchesInFlight = new Set<string>();
const consumedBranchContexts = new Map<string, string>();
const withoutBranchNote = (
  note: string | undefined,
  branch: string | undefined
): string | undefined =>
  branch ? note?.replace(workspaceBranchChangedNote(branch), '').trim() || undefined : note;

const reloadInFlight = new Map<
  string,
  { promise: Promise<string | null>; buffered: RendererAgentEvent[] }
>();
let evictTimer: ReturnType<typeof setTimeout> | null = null;
/** 正文脱节时向 worker 补要 snapshot 的去抖：同一会话一轮重叠的 upsert 不重复要 */
const snapshotResyncAt: Record<string, number> = {};
const SNAPSHOT_RESYNC_DEBOUNCE_MS = 2_000;
function resyncSnapshot(sessionId: string): void {
  const now = Date.now();
  if (now - (snapshotResyncAt[sessionId] ?? 0) < SNAPSHOT_RESYNC_DEBOUNCE_MS) return;
  snapshotResyncAt[sessionId] = now;
  void window.electronAPI.agent.requestSnapshot(sessionId);
}

function forgetUnknownSessionClocks(conversations: Record<string, unknown>): void {
  const known = new Set(Object.keys(conversations));
  pruneSessionClocks(lastViewedAt, known);
  pruneSessionClocks(snapshotResyncAt, known);
}

function viewedFromState(state: {
  activeId: string | null;
  conversations: Record<string, { activeTabId?: string }>;
}): string | null {
  const tab = state.activeId ? state.conversations[state.activeId]?.activeTabId : undefined;
  return viewedConversationId(state.activeId, tab, (id) => Boolean(state.conversations[id]));
}

function startGoalPrompt(objective: string): string {
  return (
    `<goal-continuation>\nSession goal: ${objective}\n` +
    'Work toward this goal autonomously. When done call goal_complete with evidence; ' +
    'if blocked call goal_blocked; if waiting on something external call goal_wait.\n</goal-continuation>'
  );
}

export interface Conversation extends SessionProjection {
  id: string;
  projectId: string;
  /** 首条消息的截断，作为列表展示名 */
  title: string;
  /** 用户手动改过名：此后一切自动标题总结（首条即时 / 每轮滚动）都跳过；随 partialize 持久化 */
  titleLocked?: boolean;
  /** 标题总结在飞：pendingTitleBaselines 的 UI 镜像（Map 在 store 闭包里，组件读不到）；侧栏转圈。不持久化 */
  titleSummaryPending?: boolean;
  /** 最近一次标题总结失败原因（含模型标识）；侧栏红叹号 + tooltip。成功/改名/重试时清。不持久化 */
  titleSummaryError?: string;
  /** 最近一次成功回合的 digest，供手动重试走 rolling；无则退 initial。不持久化 */
  lastTurnDigest?: TurnDigest;
  /** 是否已在 worker 侧 spawn（首条消息发出时才 spawn） */
  started: boolean;
  spawning: boolean;
  createdAt: number;
  /** pi 会话 jsonl 路径，app 重启后凭它 resume */
  sessionFile?: string;
  /** 侧栏置顶（项目内排最前 + 进顶部 Pinned 栏目）；随 partialize 持久化 */
  pinned?: boolean;
  /** 侧栏归档（移出项目分组/置顶栏,进底部 Archived 栏目）；随 partialize 持久化 */
  archived?: boolean;
  /** 归档时刻；清理「N 天前已归档」用。取消归档时清掉 */
  archivedAt?: number;
  /**
   * 最后活跃时刻（最后一条消息的 timestamp）。partialize 剥离 messages 前写入，
   * 重启后侧栏排序靠它——否则回落 createdAt，「昨晚建、今早用」的会话会掉序消失
   */
  lastActiveAt?: number;
  /** 当前模型上下文窗口（session-meta 下发；未知则水位表显示 ?） */
  contextWindow?: number;
  /** Worker 拆账单；未 spawn 时缺省 */
  occupancy?: ContextOccupancy;
  /** 上下文压缩进度：排队中（等本轮收束）/ 压缩中；未压缩时缺省 */
  compaction?: 'queued' | 'running';
  /** 最近一次压缩失败的原文（如「Nothing to compact」），UI 弹完 toast 后清除 */
  compactionError?: string;
  /**
   * 压缩结束那一刻的消息数：压完提示按它锚定在时间线中间。
   * 不能靠「存在 compaction 行」推导，否则提示永远贴底、新消息被顶到它上方。
   */
  compactionNoticeAt?: number;
  forkedFromConversationId?: string;
  forkedFromEntryId?: string;
  /** 上次使用的模型，resume 时沿用 */
  lastProviderId?: string;
  lastModelId?: string;
  /** 是否开启推理（per 会话记忆） */
  reasoningEnabled?: boolean;
  /** 推理档位（reasoning 开启时有效） */
  thinkingLevel?: ThinkingLevel;
  /** 注入组合预设（per 会话记忆）；缺省 = 默认预设。下次 spawn 生效 */
  presetId?: string;
  /** 审批档位（per 会话记忆）；缺省 full（完全放行） */
  approvalMode?: ApprovalMode;
  /** coworker 会话专有：父会话 id（有值则不进 order/侧栏） */
  parentId?: string;
  coworkerName?: string;
  agentType?: string;
  /** typed mention child 的 Main 权威 metadata；普通 coworker 无此字段。 */
  child?: ChildConversationMetadata;
  /** 已结束 child：内容来自 safe journal 的只读回放，不可继续对话。不持久化。 */
  historyOnly?: boolean;
  /** 已尝试过只读回放（含失败），避免反复打 IPC。不持久化。 */
  historyLoadAttempted?: boolean;
  /** 上滑翻页在途；不持久化 */
  historyLoading?: boolean;
  /** 手动重读在途（菜单项禁用 / 反馈）；不持久化 */
  reloading?: boolean;
  /** 当前 child TAB 的危险 capability ASK；不持久化。 */
  pendingCapabilityAsks?: CapabilityAskRequest[];
  /** allow ACK 后留在 child TAB 的 OAuth 宿主请求；不持久化。 */
  activeOauthAsk?: CapabilityAskRequest;
  /** Main summon 注入的一次性 typed recipient。 */
  prefillAgentTypeKey?: AgentTypeKey;
  /** 父会话专有：在编 coworker id 列表（驱动 tab 条） */
  coworkerIds?: string[];
  /** 父会话专有：当前 tab（undefined = 主会话） */
  activeTabId?: string;
  /** 完成未读:后台完成且用户未查看(侧栏绿点);选中时清除。持久化 */
  unread?: boolean;
  /** 排队待发消息(running 时用户消息先入队) */
  queuedMessages?: QueuedMessage[];
  /** 会话目标(设定后空闲自动续跑) */
  goal?: SessionGoal;
  /** 回退后待预填输入框的文本(rewind-done 回流,ChatInput 消费一次) */
  draftText?: string;
  /** 隔离会话的 worktree 绑定（main 权威的投影）；持久化，resume 时据此校验与定 cwd */
  worktree?: SessionWorktree;
  /** 工作区迁移/回退提醒，随下一条用户消息前置注入后清除；持久化 */
  pendingWorkspaceNote?: string;
  pendingWorkspaceBranch?: { requestId: string; branch: string };
  /** resume 时发现 worktree 丢失（驱动重建/回退选择 UI）；不持久化 */
  worktreeMissing?: boolean;
  /** 用户点了停止：抑制这一轮收束触发的排队投递/目标续跑（否则停完立刻自己跑起来）。不持久化 */
  abortRequested?: boolean;
  /** 工作区迁移进行中：挡住自动 resume。不能复用 spawning——它会被 worker 事件
   *  （含 release 触发的 parent-ended）清掉，守卫窗口期失效（CDP 实测）；不持久化 */
  workspaceMigrating?: boolean;
}

interface SendTarget {
  providerId: string;
  modelId: string;
  cwd: string;
}

interface SessionsState {
  conversations: Record<string, Conversation>;
  /** 新的在前 */
  order: string[];
  activeId: string | null;
  /** 隔离会话的 worktree 状态快照（侧边栏徽标）；不持久化 */
  worktreeStatuses: Record<string, WorktreeStatus>;
  workspaceRevisionByConversation: Record<string, number>;
  switchWorkspaceBranch(
    id: string,
    branch: string,
    create?: boolean
  ): Promise<WorkspaceBranchSwitchResult>;
  /** 无 project 时保留的一次性 summon；下一条普通 draft 消费。 */
  pendingAgentPrefill?: AgentTypeKey;

  newConversation(
    projectId: string,
    options?: {
      forkedFrom?: { conversationId: string; entryId: string };
      worktreeFromConversationId?: string;
    }
  ): Promise<string | null>;
  /** 会话切到隔离 worktree（composer 选择器/右键菜单入口）。
   *  fresh（未开聊）直接绑定；已有内容走完整迁移（主树干净检查 + release + 迁移提醒）。
   *  主树脏时返回 DIRTY_MAIN_TREE 哨兵等 UI 确认，confirm 后传 allowDirtyMainTree 重试。返回错误或 null */
  moveConversationToWorktree(
    id: string,
    options?: { allowDirtyMainTree?: boolean }
  ): Promise<string | null>;
  attachConversationToWorktree(id: string, sourceConversationId: string): Promise<string | null>;
  renameWorktree(id: string, name: string): Promise<string | null>;
  /** 清理 worktree 保留会话：cwd 回退主工作树 + 注入回退提醒。拦截确认在 UI 层 */
  cleanupWorktree(id: string): Promise<string | null>;
  /** resume 发现 worktree 丢失后：从记录分支/基准重建 */
  rebuildWorktree(id: string): Promise<string | null>;
  /** resume 发现 worktree 丢失后：回退主工作树继续 */
  fallbackToMainWorkspace(id: string): Promise<void>;
  /** 刷新全部隔离会话的 worktree 状态（侧边栏徽标） */
  refreshWorktreeStatuses(): Promise<void>;
  selectConversation(id: string): void;
  /** 手机打开会话时清未读，不改桌面选中 */
  markConversationRead(id: string): void;
  removeConversation(id: string): void;
  /** 切换会话置顶 */
  togglePinConversation(id: string): void;
  /** 手动改会话标题（侧栏 / tab 双击或右键） */
  renameConversation(id: string, title: string): void;
  /** 标题总结失败后手动重试（侧栏红叹号）：有最近回合 digest 走 rolling，否则退 initial */
  retryTitleSummary(id: string): void;
  /** 开关关闭时清掉全部在飞与失败残留（在飞 Map 在闭包里，只能由 store 自己清） */
  clearTitleSummaryState(): void;
  /** 切换会话归档(归档时同时清置顶) */
  toggleArchiveConversation(id: string): void;
  /** 闲置自动归档；清理已合并开时对候选隔离会话先 cleanup 再归档 */
  autoArchiveStaleConversations(now?: number): Promise<void>;
  /** 归档超期自动删除：days<=0 no-op，否则对候选走 removeConversation */
  autoDeleteStaleArchived(now?: number): void;
  dispatchAgent(
    typeKey: AgentTypeKey,
    task: AgentDispatchTask,
    selectedModel: DefaultModelRef | null
  ): Promise<AgentDispatchResult>;
  prefillAgent(typeKey: AgentTypeKey, prompt?: string): void;
  clearAgentPrefill(conversationId: string): void;
  respondCapabilityAsk(
    conversationId: string,
    requestId: string,
    decision: 'allow' | 'deny'
  ): Promise<void>;
  send(text: string, target: SendTarget, images?: AttachedImage[]): Promise<string | null>;
  /** app 重启后从 jsonl 恢复会话并回放历史（未 started 且有 sessionFile 时有效） */
  resumeConversation(id: string): Promise<void>;
  /** 上滑加载更早历史：只读 jsonl，不 spawn */
  loadOlderHistory(id: string): Promise<void>;
  /**
   * 手动「重新读取会话」：绕过本地缓存向 Main 要权威正文（来源由 Main 选）。只读不 spawn，
   * 不动草稿 / 排队 / started。同会话在途合并；失败保留旧正文并返回原因，成功返 null。
   */
  reloadConversation(id: string): Promise<string | null>;
  /** 登记一条手机端新建的会话（worker 侧已 spawn，这里只补桌面投影） */
  adoptPairSession(session: PairCreatedSession): void;
  /** 登记一条从外部应用导入的对话（选中后自动 resume 回放） */
  addImportedConversation(
    projectId: string,
    imported: { sessionFile: string; title: string }
  ): Promise<string | null>;
  /** 设置推理开关；已 spawn 的会话即时下发命令（worker 就地改 model，下条请求生效） */
  setReasoning(id: string, enabled: boolean): void;
  /** 设置推理档位；已 spawn 的会话即时生效 */
  setThinking(id: string, level: ThinkingLevel): void;
  /** 设置注入预设；下次 spawn 生效 */
  setPreset(id: string, presetId: string): void;
  /** 记忆会话选用的模型（选择器读写;send/resume 沿用） */
  setModel(id: string, providerId: string, modelId: string): void;
  /** 设置审批档位；已 spawn 的会话即时下发 */
  setApprovalMode(id: string, mode: ApprovalMode): void;
  abort(): Promise<void>;
  /** 切换聊天区 tab（undefined = 主会话） */
  selectTab(parentId: string, tabId?: string): void;
  /** 解雇 coworker：活会话删除靠 coworker-update 回流（单一数据流）；
   * 重启后 worker/Main 侧无实体的死 tab（IPC 拒绝且未 started）本地移除兑底 */
  dismissCoworkerFromUI(parentId: string, coworkerId: string): Promise<void>;
  /** 手动雇佣 coworker（会话建立靠 coworker-update 回流;主 agent 经 worker 通知感知） */
  hireCoworker(parentId: string, name: string, agentType?: string): Promise<string | null>;
  /** 指定会话入队（不依赖 activeId）：手机端在轮次进行中发消息走这里 */
  enqueueMessage(conversationId: string, text: string, images?: AttachedImage[]): void;
  removeQueuedMessage(conversationId: string, messageId: string): void;
  updateQueuedMessage(conversationId: string, messageId: string, text: string): void;
  /** 立即发送队列中某条(running 时 steer 插入,否则直接 prompt) */
  sendQueuedNow(conversationId: string, messageId: string): void;
  /** 打断当前轮并立即发送队列中某条(中断收束后以新一轮 prompt 投递) */
  interruptAndSendQueued(conversationId: string, messageId: string): Promise<void>;
  /** 回退到倒数第 N+1 条 user 消息(0 = 最后一条)。冷会话先 resume 并等到 worker 会话可用（snapshot / ready）。
   *  restoreFiles 同时还原工作树文件 */
  rewind(conversationId: string, userIndexFromEnd: number, restoreFiles?: boolean): void;
  /** 手动压缩上下文（/compact 与上下文面板按钮共用）。忙碌时 worker 排队，本轮结束后执行 */
  compact(conversationId: string, instructions?: string): void;
  /** UI 提示过压缩失败后清掉错误，避免重复弹提示 */
  clearCompactionError(conversationId: string): void;
  forkFromMessage(conversationId: string, userIndexFromEnd: number): Promise<string | null>;
  forkFromEntry(conversationId: string, entryId: string): Promise<string | null>;
  /** 终态失败后不新增 user 消息，从当前上下文续跑 */
  retry(conversationId: string): void;
  /** ChatInput 消费预填文本后清除 */
  clearDraft(conversationId: string): void;
  /** 设定会话目标并立即开跑 */
  setGoal(conversationId: string, text: string): void;
  /** 暂停/继续/清除目标 */
  pauseGoal(conversationId: string): void;
  resumeGoal(conversationId: string): void;
  clearGoal(conversationId: string): void;
}

/** 未投递成功的乐观消息回队：文本 + 图片都不丢 */
function toQueuedMessage(message: ProjectedMessage): QueuedMessage {
  const images = message.content.flatMap((part) =>
    part.type === 'image' ? [{ data: part.data, mimeType: part.mimeType }] : []
  );
  return {
    id: crypto.randomUUID(),
    text: userMessageRawText(message),
    ...(images.length > 0 ? { images } : {}),
  };
}

function userMessageRawText(message: ProjectedMessage): string {
  if (message.role !== 'user') return '';
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .trim();
}

function truncateTitle(text: string): string {
  // 提炼代表行作为标题：chat 引用块折叠成 @标题，跳过无业务意义引导行，引用块原文不得污染标题
  return extractRepresentativeTitle(text);
}

/** 首条用户消息的文本，用作手机端建会话的标题（桌面建的在 spawn 时已有标题） */
function firstUserText(projection: SessionProjection): string {
  const message = projection.messages.find((m) => m.role === 'user');
  if (!message) return '';
  return truncateTitle(userMessageRawText(message));
}

function firstUserRawText(projection: SessionProjection): string {
  const message = projection.messages.find((m) => m.role === 'user');
  return message ? userMessageRawText(message) : '';
}

const patch = (
  state: SessionsState,
  id: string,
  updates: Partial<Conversation>
): Pick<SessionsState, 'conversations'> => ({
  conversations: { ...state.conversations, [id]: { ...state.conversations[id], ...updates } },
});

export const useSessionsStore = create<SessionsState>()(
  persist(
    (set, get) => {
      const pendingSelectionUpdates = new Map<string, Promise<void>>();
      const pendingDispatchEvents = new Map<string, DispatchMainEvent[]>();
      /**
       * 标题总结在飞时的基准截断标题。title-generated 回流时只有当前标题仍等于基准
       * 才覆盖——用户已手动改名的绝不动。不持久化：重启后在飞的总结直接作废。
       */
      const pendingTitleBaselines = new Map<string, string>();
      const rewindInFlight = new Set<string>();

      /**
       * 标题总结在飞的开/关必须走这两个 helper：保证不变量
       * `conversation.titleSummaryPending === pendingTitleBaselines.has(id)`，侧栏转圈才能跟实际在飞对齐。
       */
      function markTitlePending(conversationId: string, baseline: string): void {
        pendingTitleBaselines.set(conversationId, baseline);
        set((state) =>
          state.conversations[conversationId]
            ? patch(state, conversationId, {
                titleSummaryPending: true,
                titleSummaryError: undefined,
              })
            : state
        );
      }

      /** 返回原本是否在飞（迟到的 title-generated / title-failed 靠它识别） */
      function clearTitlePending(conversationId: string): boolean {
        const wasPending = pendingTitleBaselines.delete(conversationId);
        set((state) => {
          const conversation = state.conversations[conversationId];
          if (!conversation || conversation.titleSummaryPending === undefined) return state;
          return patch(state, conversationId, { titleSummaryPending: undefined });
        });
        return wasPending;
      }

      /** 所有发起路径的收口：记在飞基准、清错误、发 IPC；Main 同步拒绝时按 title-failed 语义处理 */
      function requestTitleSummary(
        conversationId: string,
        baseline: string,
        input: TitleSummaryInput,
        sessionModel?: { providerId?: string; modelId?: string }
      ): void {
        markTitlePending(conversationId, baseline);
        void (async () => {
          let result: { ok: boolean; error?: string };
          try {
            result = await window.electronAPI.agent.summarizeTitle(
              conversationId,
              input,
              sessionModel?.providerId && sessionModel?.modelId
                ? { providerId: sessionModel.providerId, modelId: sessionModel.modelId }
                : undefined
            );
          } catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          if (!result.ok) {
            failTitleSummary(conversationId, result.error ?? 'title summary request rejected');
          }
        })();
      }

      /** title-failed 事件与 IPC 同步拒绝共用：只对仍在飞的会话生效，锁定的会话不写错误 */
      function failTitleSummary(conversationId: string, error: string): void {
        if (!clearTitlePending(conversationId)) return;
        set((state) => {
          const conversation = state.conversations[conversationId];
          if (!conversation || conversation.titleLocked) return state;
          return patch(state, conversationId, { titleSummaryError: error.slice(0, 500) });
        });
      }

      function trySummarizeTitle(
        conversationId: string,
        rawText: string,
        baselineTitle: string,
        sessionModel?: { providerId?: string; modelId?: string }
      ): void {
        const cleanedText = cleanTitleSummarySource(rawText);
        if (
          !useSettingsStore.getState().titleSummaryEnabled ||
          !cleanedText.trim() ||
          !baselineTitle.trim() ||
          pendingTitleBaselines.has(conversationId)
        ) {
          return;
        }
        // resume 与否由各调用点用触发时刻的快照判断（spawn 路径 !sessionFile、事件路径空标题）。
        // 这里不能再读 live sessionFile：parent-ready 常抢在 spawn IPC 返回之前落地，
        // 新会话此刻已带 sessionFile，按它判断会把桌面首条消息的总结整个误杀。
        const conversation = get().conversations[conversationId];
        if (!conversation || conversation.titleLocked) return;

        requestTitleSummary(
          conversationId,
          baselineTitle,
          { kind: 'initial', text: cleanedText },
          sessionModel
        );
      }

      /**
       * 回合成功结束后的滚动标题刷新：开场请求（主旨锚点）+ 当前标题 + worker 切出的本轮摘要送模型，
       * 模型可原样返回当前标题（不改）。每个成功回合都触发，不收敛；在飞未回流时跳过。
       * 本轮 user 是推进类短句（“继续 / 开始实施 / go ahead”）时直接跳过：同一话题往前走不该重写标题，
       * 真机已证不听话的模型会把“开始实施”总结成“开始实施：先读 PRD”这种脱离主旨的标题。
       * 冷会话/手机端会话没有正文也能触发——摘要来自 worker，不依赖 renderer 的 messages。
       */
      function tryRollingSummarizeTitle(
        conversationId: string,
        digest: TurnDigest | undefined
      ): void {
        if (!digest || !useSettingsStore.getState().titleSummaryEnabled) return;
        if (!digest.userText.trim() && !digest.assistantText.trim()) return;
        if (isContinuationTurn(digest.userText)) return;
        const conversation = get().conversations[conversationId];
        if (
          !conversation ||
          conversation.parentId ||
          conversation.coworkerName ||
          conversation.titleLocked ||
          !conversation.title.trim() ||
          pendingTitleBaselines.has(conversationId)
        ) {
          return;
        }
        requestTitleSummary(
          conversationId,
          conversation.title,
          {
            kind: 'rolling',
            currentTitle: conversation.title,
            firstUserText: digest.firstUserText,
            userText: digest.userText,
            assistantText: digest.assistantText,
          },
          { providerId: conversation.lastProviderId, modelId: conversation.lastModelId }
        );
      }

      /**
       * 已结束 child TAB 的惰性只读回放。四个条件全满足才发请求，失败也标记已尝试，
       * 避免每次切 TAB 都打一次 IPC。活会话（started）走正常事件流，不走这里。
       */
      async function loadChildHistory(conversationId: string): Promise<void> {
        const conversation = get().conversations[conversationId];
        if (
          !conversation?.parentId ||
          conversation.started ||
          conversation.messages.length > 0 ||
          conversation.historyLoadAttempted
        ) {
          return;
        }
        set((state) => patch(state, conversationId, { historyLoadAttempted: true }));
        const result = await window.electronAPI.agent.readChildHistory(conversationId);
        if (!result.ok) return;
        const timeline = projectSafeJournal(result.projection.records);
        if (timeline.messages.length === 0 && timeline.customEntries.length === 0) return;
        set((state) =>
          state.conversations[conversationId]
            ? patch(state, conversationId, {
                messages: timeline.messages,
                customEntries: timeline.customEntries,
                historyOnly: true,
              })
            : state
        );
      }

      async function adoptMissingRootAuthority(
        conversationId: string,
        projectId: string
      ): Promise<boolean> {
        const projection = await window.electronAPI.sourceAuthority.read();
        if (
          projection.conversations.some(
            (candidate) =>
              candidate.conversationId === conversationId &&
              candidate.kind === 'root' &&
              candidate.lifecycle !== 'ended'
          )
        ) {
          return true;
        }
        const project = projection.projects.find(
          (candidate) => candidate.projectId === projectId && candidate.state === 'active'
        );
        if (!project) return false;
        const created = await window.electronAPI.sourceAuthority.createConversation({
          requestId: crypto.randomUUID(),
          projectId: project.projectId,
          projectVersion: project.version,
          conversationId,
        });
        return created.accepted;
      }

      async function activateConversationAuthority(conversationId: string): Promise<{
        project: ProjectAuthorityProjection;
        conversation: ConversationAuthorityProjection;
      } | null> {
        // markReady（fork-done / parent-ready）会抬 version；读投影与 select 之间可能过期。
        for (let attempt = 0; attempt < 2; attempt++) {
          const projection = await window.electronAPI.sourceAuthority.read();
          const conversation = projection.conversations.find(
            (candidate) =>
              candidate.conversationId === conversationId &&
              candidate.kind === 'root' &&
              candidate.lifecycle !== 'ended'
          );
          if (!conversation) return null;
          const project = projection.projects.find(
            (candidate) =>
              candidate.projectId === conversation.projectId && candidate.state === 'active'
          );
          if (!project) return null;
          const projectResult = await window.electronAPI.sourceAuthority.selectProject({
            requestId: crypto.randomUUID(),
            projectId: project.projectId,
            version: project.version,
          });
          if (!projectResult.accepted) {
            if (attempt === 0) continue;
            return null;
          }
          const conversationResult = await window.electronAPI.sourceAuthority.selectConversation({
            requestId: crypto.randomUUID(),
            conversationId: conversation.conversationId,
            version: conversation.version,
          });
          if (!conversationResult.accepted) {
            if (attempt === 0) continue;
            return null;
          }
          if (conversationResult.value.forkedFrom) {
            const origin = conversationResult.value.forkedFrom;
            set((state) => {
              const local = state.conversations[conversationId];
              if (!local) return state;
              if (
                local.forkedFromConversationId === origin.conversationId &&
                local.forkedFromEntryId === origin.entryId
              ) {
                return state;
              }
              return patch(state, conversationId, {
                forkedFromConversationId: origin.conversationId,
                forkedFromEntryId: origin.entryId,
              });
            });
          }
          return { project: projectResult.value, conversation: conversationResult.value };
        }
        return null;
      }
      window.electronAPI.agent.onFocusSession((sessionId) => {
        const conversation = get().conversations[sessionId];
        if (!conversation) return;
        const parentId = conversation.parentId;
        if (parentId) {
          set((state) => ({
            activeId: parentId,
            conversations: patch(state, parentId, { activeTabId: sessionId }).conversations,
          }));
        } else {
          set({ activeId: sessionId });
        }
      });
      window.electronAPI.capabilities.onAsk((request) => {
        set((state) => {
          const conversation = state.conversations[request.child.sessionId];
          if (
            !conversation ||
            conversation.generation !== request.child.generation ||
            (conversation.pendingCapabilityAsks ?? []).some(
              (pending) => pending.requestId === request.requestId
            )
          ) {
            return state;
          }
          return patch(state, conversation.id, {
            pendingCapabilityAsks: [...(conversation.pendingCapabilityAsks ?? []), request],
          });
        });
      });
      window.electronAPI.agentDispatch.onEvent((event) => {
        set((state) => {
          const conversation = state.conversations[event.child.sessionId];
          if (!conversation) {
            pendingDispatchEvents.set(event.child.sessionId, [
              ...(pendingDispatchEvents.get(event.child.sessionId) ?? []),
              event,
            ]);
            return state;
          }
          const next = applyDispatchEvent(conversation, conversation.id, event);
          return next === conversation
            ? state
            : patch(state, conversation.id, next as Conversation);
        });
      });

      window.electronAPI.agent.onEvent((event) => {
        if (event.type === 'worker-exited') {
          set((state) => {
            const conversations = { ...state.conversations };
            for (const id of Object.keys(conversations)) {
              if (conversations[id].started) {
                conversations[id] = applyAgentEvent(conversations[id], id, event) as Conversation;
              }
            }
            return { conversations };
          });
          return;
        }

        if (event.type === 'snapshot') {
          set((state) => {
            const alive = new Map(
              event.sessions.map((snapshot) => [snapshot.identity.sessionId, snapshot])
            );
            const partial = event.partial === true;
            const conversations = { ...state.conversations };

            // Persist 只保存 parent→child metadata；快照从各自 jsonl 恢复真实 history。
            for (const [sessionId, snapshot] of alive) {
              const metadata = snapshot.child;
              if (conversations[sessionId] || !metadata) continue;
              const parent = conversations[metadata.parentId];
              if (!parent) continue;
              conversations[sessionId] = {
                ...emptyProjection,
                generation: snapshot.identity.generation,
                id: sessionId,
                projectId: parent.projectId,
                parentId: metadata.parentId,
                coworkerName: metadata.agentInstanceName,
                agentType: metadata.agentTypeKey,
                child: metadata,
                title: metadata.agentInstanceName,
                started: true,
                spawning: false,
                createdAt: Date.now(),
              };
              if (!(parent.coworkerIds ?? []).includes(sessionId)) {
                conversations[metadata.parentId] = {
                  ...parent,
                  coworkerIds: [...(parent.coworkerIds ?? []), sessionId],
                };
              }
            }

            const viewed = viewedFromState(state);
            const now = Date.now();
            for (const id of Object.keys(conversations)) {
              const conversation = conversations[id];
              const snapshot = alive.get(id);
              if (snapshot) {
                // 只看热度：手机 subscribe/history 触发的 targeted 快照也会广播到桌面，
                // partial 就留正文会把当时的半截灌进冷会话，之后 upsert 又因冷被丢，半截常驻
                const keepBody = isMessageCacheHot(id, viewed, lastViewedAt, now);
                const next = applyAgentEvent(conversation, id, event);
                const title = conversation.title || firstUserText(next) || '';
                conversations[id] = {
                  ...conversation,
                  ...next,
                  title,
                  ...(keepBody
                    ? {}
                    : {
                        messages: [],
                        customEntries: [],
                        historyBaseIndex: undefined,
                        historyLoading: undefined,
                      }),
                  ...(snapshot.child
                    ? {
                        parentId: snapshot.child.parentId,
                        coworkerName: snapshot.child.agentInstanceName,
                        agentType: snapshot.child.agentTypeKey,
                        child: snapshot.child,
                      }
                    : {}),
                  started: true,
                  spawning: false,
                  error: undefined,
                  pendingCapabilityAsks: [],
                  activeOauthAsk: undefined,
                };
                continue;
              }
              // targeted 快照回空 = worker 已释放该会话（闲置回收 / 重启）：收回 started，
              // 否则后续 prompt 绕过 spawn 直发空会话；正在看的话清掉旧正文让尾窗补
              const absentTarget =
                partial &&
                event.sessionId === id &&
                !conversation.spawning &&
                (conversation.started || Boolean(conversation.sessionFile));
              if (!absentTarget && (partial || !conversation.started)) continue;
              conversations[id] = conversation.sessionFile
                ? {
                    ...conversation,
                    started: false,
                    status: 'idle',
                    error: undefined,
                    pendingCapabilityAsks: [],
                    activeOauthAsk: undefined,
                    // 只有渲染层原以为 worker 还持有（started）时本地正文才可能掉队；
                    // 浏览态（尾窗上屏、started=false）的正文是 jsonl 来的，不动
                    ...(absentTarget &&
                    conversation.started &&
                    id === viewed &&
                    hasAuthoritativeMessages(conversation.messages)
                      ? {
                          messages: [],
                          customEntries: [],
                          historyBaseIndex: undefined,
                          historyLoading: undefined,
                        }
                      : {}),
                  }
                : {
                    ...conversation,
                    status: 'failed',
                    error: 'Session ended — history not restored',
                    pendingCapabilityAsks: [],
                    activeOauthAsk: undefined,
                  };
            }
            return { conversations };
          });
          if (event.partial) {
            for (const session of event.sessions) continueGoal(session.identity.sessionId);
            if (event.sessionId) {
              const state = get();
              const target = state.conversations[event.sessionId];
              if (
                target &&
                viewedFromState(state) === event.sessionId &&
                needsHistoryHydration(target)
              ) {
                void hydrateParentHistoryTail(event.sessionId);
              }
            }
          }
          return;
        }

        if (event.type === 'child-reserved') {
          set((state) => {
            const parentId = event.identity.parent.sessionId;
            const parent = state.conversations[parentId];
            if (!parent) return state;
            const childId = event.identity.sessionId;
            const existing = state.conversations[childId];
            if (existing?.generation === event.identity.generation) return state;
            let child: Conversation = {
              ...emptyProjection,
              generation: event.identity.generation,
              lastSeq: event.seq,
              id: childId,
              projectId: parent.projectId,
              parentId,
              coworkerName: event.metadata.agentInstanceName,
              agentType: event.metadata.agentTypeKey,
              child: event.metadata,
              title: event.metadata.agentInstanceName,
              started: false,
              spawning: true,
              createdAt: Date.now(),
            };
            for (const dispatchEvent of [...(pendingDispatchEvents.get(childId) ?? [])].sort(
              (left, right) => left.mainSeq - right.mainSeq
            )) {
              child = applyDispatchEvent(child, childId, dispatchEvent) as Conversation;
            }
            pendingDispatchEvents.delete(childId);
            return {
              activeId: parentId,
              conversations: {
                ...state.conversations,
                [childId]: child,
                [parentId]: {
                  ...parent,
                  generation: parent.generation ?? event.identity.parent.generation,
                  coworkerIds: (parent.coworkerIds ?? []).includes(childId)
                    ? parent.coworkerIds
                    : [...(parent.coworkerIds ?? []), childId],
                  activeTabId: childId,
                  error: undefined,
                },
              },
            };
          });
          return;
        }

        if (event.type === 'title-generated') {
          const baseline = pendingTitleBaselines.get(event.conversationId);
          clearTitlePending(event.conversationId);
          set((state) => {
            const conversation = state.conversations[event.conversationId];
            // 会话已删 / 用户已手动改名（标题离开基准）→ 丢弃结果
            if (!conversation || baseline === undefined || conversation.title !== baseline) {
              return state;
            }
            const title = event.title.trim().slice(0, 80);
            if (!title) return state;
            // 模型认为标题已准确（原样返回）也是成功：清错误，但不必改写标题
            if (title === conversation.title) {
              return conversation.titleSummaryError === undefined
                ? state
                : patch(state, event.conversationId, { titleSummaryError: undefined });
            }
            return patch(state, event.conversationId, { title, titleSummaryError: undefined });
          });
          return;
        }

        if (event.type === 'title-failed') {
          failTitleSummary(event.conversationId, event.error);
          return;
        }
        // 通用补全结果在 Main 就已结算，不应到达渲染层；到了也与会话无关
        if (event.type === 'text-completed' || event.type === 'text-failed') return;

        const identity = event.type === 'capability-invoke' ? event.child : event.identity;
        const id = identity.sessionId;
        reloadInFlight.get(id)?.buffered.push(event);

        if (event.type === 'workspace-branch-context-consumed') {
          set((state) => {
            const current = state.conversations[id];
            if (!current) return state;
            const next = applyAgentEvent(current, id, event);
            if (next === current) return state;
            if (branchSwitchesInFlight.size)
              consumedBranchContexts.set(`${event.requestId}:${id}`, identity.generation);
            return patch(state, id, {
              ...next,
              ...(current.pendingWorkspaceBranch?.requestId === event.requestId
                ? {
                    pendingWorkspaceNote: withoutBranchNote(
                      current.pendingWorkspaceNote,
                      current.pendingWorkspaceBranch.branch
                    ),
                    pendingWorkspaceBranch: undefined,
                  }
                : {}),
            });
          });
          return;
        }

        if (event.type === 'coworker-update') {
          set((state) => {
            const parent = state.conversations[id];
            if (!parent) return state;
            const nextParent = applyAgentEvent(parent, id, event);
            if (nextParent === parent) return state;
            const coworker = event.coworker;
            const conversations = { ...state.conversations, [id]: nextParent as Conversation };
            if (coworker.status === 'dismissed') {
              delete conversations[coworker.id];
              conversations[id] = {
                ...(nextParent as Conversation),
                coworkerIds: (parent.coworkerIds ?? []).filter(
                  (coworkerId) => coworkerId !== coworker.id
                ),
                activeTabId: parent.activeTabId === coworker.id ? undefined : parent.activeTabId,
              };
              forgetUnknownSessionClocks(conversations);
              return { conversations };
            }
            const existing = conversations[coworker.id];
            const metadata = coworker.child;
            const sameGeneration =
              !metadata || !existing || existing.generation === metadata.childGeneration;
            conversations[coworker.id] =
              existing && sameGeneration
                ? {
                    ...existing,
                    started: true,
                    spawning: false,
                    // worker 侧有实体 = 复活，清掉上一代的终态标记
                    ended: undefined,
                    sessionFile: coworker.sessionFile ?? existing.sessionFile,
                    coworkerName: coworker.name,
                    ...(coworker.agentType ? { agentType: coworker.agentType } : {}),
                    ...(metadata
                      ? {
                          generation: metadata.childGeneration,
                          child: metadata,
                          agentType: metadata.agentTypeKey,
                        }
                      : {}),
                  }
                : {
                    ...emptyProjection,
                    ...(metadata ? { generation: metadata.childGeneration, child: metadata } : {}),
                    id: coworker.id,
                    projectId: parent.projectId,
                    parentId: id,
                    coworkerName: coworker.name,
                    agentType: metadata?.agentTypeKey ?? coworker.agentType,
                    title: coworker.name,
                    started: true,
                    spawning: false,
                    createdAt: coworker.createdAt,
                    ...(coworker.sessionFile ? { sessionFile: coworker.sessionFile } : {}),
                    ...(coworker.modelId ? { lastModelId: coworker.modelId } : {}),
                  };
            if (!(parent.coworkerIds ?? []).includes(coworker.id)) {
              conversations[id] = {
                ...(conversations[id] as Conversation),
                coworkerIds: [...(parent.coworkerIds ?? []), coworker.id],
              };
            }
            return { conversations };
          });
          return;
        }

        if (event.type === 'goal-signal') {
          set((state) => {
            const conversation = state.conversations[id];
            if (!conversation?.goal) return state;
            const next = applyAgentEvent(conversation, id, event);
            if (next === conversation) return state;
            if (event.kind === 'complete') {
              return patch(state, id, { ...next, goal: undefined });
            }
            const status = event.kind === 'blocked' ? ('blocked' as const) : ('waiting' as const);
            return patch(state, id, {
              ...next,
              goal: { ...conversation.goal, status, note: event.note },
            });
          });
          return;
        }

        if (event.type === 'fork-done') {
          const targetId = event.targetConversationId;
          const source = get().conversations[id];
          if (event.error || !event.sessionFile) {
            if (get().conversations[targetId]) get().removeConversation(targetId);
            return;
          }
          void window.electronAPI.worktree
            .get(targetId)
            .then((worktree) => {
              set((state) => {
                const target = state.conversations[targetId];
                if (!target) return state;
                return patch(state, targetId, {
                  sessionFile: event.sessionFile,
                  started: false,
                  spawning: false,
                  title: target.title || `${source?.title || ''} (分支)`.trim(),
                  lastProviderId: source?.lastProviderId ?? target.lastProviderId,
                  lastModelId: source?.lastModelId ?? target.lastModelId,
                  reasoningEnabled: source?.reasoningEnabled ?? target.reasoningEnabled,
                  thinkingLevel: source?.thinkingLevel ?? target.thinkingLevel,
                  presetId: source?.presetId ?? target.presetId,
                  approvalMode: source?.approvalMode ?? target.approvalMode,
                  worktree: worktree ?? undefined,
                  forkedFromConversationId: id,
                  forkedFromEntryId: event.entryId,
                  pendingWorkspaceNote: worktree
                    ? `本会话从 ${source?.title || '源会话'} 分出，与源会话共用工作区`
                    : undefined,
                });
              });
              if (!get().conversations[targetId]) return;
              void get().resumeConversation(targetId);
              get().selectConversation(targetId);
            })
            .catch((error: unknown) => {
              set((state) =>
                state.conversations[targetId]
                  ? patch(state, targetId, { spawning: false, error: String(error) })
                  : state
              );
            });
          return;
        }

        if (event.type === 'compaction') {
          set((state) =>
            state.conversations[id]
              ? patch(state, id, {
                  compaction:
                    event.state === 'queued'
                      ? 'queued'
                      : event.state === 'start'
                        ? 'running'
                        : undefined,
                  ...(event.state === 'end'
                    ? {
                        compactionError: event.error,
                        // 真正压完才钉提示；失败 / 放弃排队都不改锚点
                        ...(event.error || event.abandoned
                          ? {}
                          : {
                              compactionNoticeAt: state.conversations[id].messages?.length ?? 0,
                            }),
                      }
                    : {}),
                })
              : state
          );
          // 压缩不发 turn-completed：成功结束后再泵队列，否则排队消息会卡住
          if (event.state === 'end') {
            if (get().conversations[id]?.abortRequested) {
              set((state) => patch(state, id, { abortRequested: false }));
              return;
            }
            flushQueue(id);
            continueGoal(id);
          }
          return;
        }

        if (event.type === 'rewind-done') {
          set((state) => {
            const conversation = state.conversations[id];
            if (!conversation) return state;
            const next = applyAgentEvent(conversation, id, event);
            if (next === conversation) return state;
            return patch(state, id, {
              ...next,
              ...(event.editorText ? { draftText: event.editorText } : {}),
            });
          });
          return;
        }

        if (event.type === 'session-meta') {
          set((state) => {
            const conversation = state.conversations[id];
            if (!conversation) return state;
            const next = applyAgentEvent(conversation, id, event);
            if (next === conversation) return state;
            return patch(state, id, {
              ...next,
              // 与 Main 同款守卫：空值不覆写，否则 resume 路径丢失 → 重启后历史无法找回
              ...(event.sessionFile ? { sessionFile: event.sessionFile } : {}),
              ...(event.contextWindow !== undefined ? { contextWindow: event.contextWindow } : {}),
              ...(event.occupancy ? { occupancy: event.occupancy } : {}),
            });
          });
          return;
        }

        const current = get();
        const currentConversation = current.conversations[id];
        if (!currentConversation) return;
        // 手机创建的冷会话仍需从首条用户消息提取标题。
        const rawUserText =
          !currentConversation.title &&
          event.type === 'message-upsert' &&
          event.message.role === 'user'
            ? userMessageRawText(event.message)
            : undefined;
        const extractedTitle = rawUserText ? truncateTitle(rawUserText) : undefined;
        if (
          isBulkyAgentEvent(event.type) &&
          !isMessageCacheHot(id, viewedFromState(current), lastViewedAt, Date.now())
        ) {
          if (extractedTitle && rawUserText) {
            trySummarizeTitle(id, rawUserText, extractedTitle, {
              providerId: currentConversation.lastProviderId,
              modelId: currentConversation.lastModelId,
            });
            set((state) => patch(state, id, { title: extractedTitle }));
          }
          // persist 在 set 返回原 state 时也会写，必须在调用 set 之前跳过。
          return;
        }

        set((state) => {
          const conversation = state.conversations[id];
          if (!conversation) return state;
          // 冷缓存清空后用户先发了一句（乐观回显占位），worker 推来的 upsert 带原 index 对不上
          // 本地权威区：reducer 会丢正文只推 seq，若不补要 snapshot，历史与正在跑的工具卡永远不出现。
          if (
            event.type === 'message-upsert' &&
            conversation.started &&
            upsertOutOfRange(conversation.messages, event.index, conversation.historyBaseIndex)
          ) {
            resyncSnapshot(id);
          }
          if (
            event.type === 'messages-truncated' &&
            truncatedNeedsSnapshotResync(conversation.historyBaseIndex, event.length)
          ) {
            resyncSnapshot(id);
          }
          const next = applyAgentEvent(conversation, id, event);
          // dev：首个 worker 事件即 spawn 完成信号，即使投影未变也要清 spawning（resume loading 依赖它）
          if (next === conversation && !conversation.spawning) return state;
          // 桌面建的会话在 spawn 时就有标题；空标题只会出现在手机建的会话上，
          // 用它的首条用户消息补一个，否则侧边栏永远显示「新对话」
          const title = conversation.title || extractedTitle || firstUserText(next) || '';
          if (!conversation.title && title) {
            const raw = rawUserText || firstUserRawText(next);
            if (raw) {
              trySummarizeTitle(id, raw, title, {
                providerId: conversation.lastProviderId,
                modelId: conversation.lastModelId,
              });
            }
          }
          return patch(state, id, {
            ...next,
            unread: nextUnread({
              prevStatus: conversation.status,
              nextStatus: (next as Conversation).status,
              prevUnread: conversation.unread,
              viewed: state.activeId === id || isPairViewed(id),
            }),
            title,
            spawning: false,
            // 未提交的消息被 reducer 收回乐观回显（最早一条）：连同图片回到队首，
            // 多条连续失败也不互相覆盖；队列区可编辑/删除/立即发送
            ...(event.type === 'turn-failed' &&
            event.undelivered &&
            next.messages.length < conversation.messages.length
              ? {
                  // 追加到队尾：连续多条失败按 FIFO 回流，保持原发送顺序（A,B → [A,B]）
                  queuedMessages: [
                    ...(conversation.queuedMessages ?? []),
                    toQueuedMessage(conversation.messages.find((m) => m.optimistic)!),
                  ],
                }
              : {}),
            ...(event.type === 'parent-ready'
              ? {
                  started: true,
                  sessionFile: event.sessionFile,
                  lastModelId: event.model.modelId,
                }
              : {}),
            ...(event.type === 'child-ready'
              ? {
                  started: true,
                  sessionFile: event.sessionFile,
                }
              : {}),
            ...(event.type === 'session-custom-entry' &&
            event.entry.kind === 'capability-receipt' &&
            conversation.activeOauthAsk?.requestId === event.entry.receipt.requestId
              ? { activeOauthAsk: undefined }
              : {}),
            ...(event.type === 'parent-ended' || event.type === 'child-ended'
              ? { started: false, pendingCapabilityAsks: [], activeOauthAsk: undefined }
              : {}),
            // worker 释放冷会话：冷缓存期间 upsert 已被丢，本地正文可能掉队，而回收定时器只在切会话时
            // 武装、夜里不再切就永远不清。这里直接清掉，切回时走 jsonl 尾窗；热正文可信，保留
            ...(event.type === 'parent-ended' &&
            !isMessageCacheHot(id, viewedFromState(state), lastViewedAt, Date.now()) &&
            (next.messages.length > 0 || next.customEntries.length > 0)
              ? {
                  messages: [],
                  customEntries: [],
                  historyBaseIndex: undefined,
                  historyLoading: undefined,
                }
              : {}),
            // spawn IPC ack 时已乐观置 started:true；拒绝到达不清回 false 的话，
            // 重发会绕过 spawn 分支直接 prompt 到 worker 里不存在的会话，重试无声失败。
            ...(event.type === 'parent-rejected' || event.type === 'child-rejected'
              ? { started: false }
              : {}),
          });
        });
        if (event.type === 'turn-completed' || event.type === 'turn-failed') {
          // 用户中断的轮次不自动续跑：清掉一次性标记后直接收口
          if (get().conversations[id]?.abortRequested) {
            set((state) => patch(state, id, { abortRequested: false }));
            return;
          }
          if (event.type !== 'turn-completed') return;
          // 留下本轮摘要供侧栏红叹号的手动重试用；在发起滚动总结之前写，重试拿到的是最新一轮
          if (event.digest) {
            const digest = event.digest;
            set((state) =>
              state.conversations[id] ? patch(state, id, { lastTurnDigest: digest }) : state
            );
          }
          tryRollingSummarizeTitle(id, event.digest);
          flushQueue(id);
          continueGoal(id);
        }
      });

      /**
       * prompt/steer 统一投递：静默失败就是「发了没反应只能重启」。失败时收回乐观回显、
       * 文本退回输入框、显式报错，并清 started 让下次发送重新 spawn（worker 退出 /
       * generation 过期都靠这条路自愈）。返回错误文案，成功为 null。
       */
      async function deliver(
        id: string,
        text: string,
        images: AttachedImage[] | undefined,
        mode: 'prompt' | 'steer',
        /** 投递失败时按 deliveryId 收回的乐观回显，及内容退回何处 */
        rollback: {
          deliveryId: string;
          restore:
            | { kind: 'draft'; text: string }
            | { kind: 'queue'; item: QueuedMessage }
            | { kind: 'goal' };
        }
      ): Promise<string | null> {
        const result =
          mode === 'steer'
            ? await window.electronAPI.agent.steer(id, text, images)
            : await window.electronAPI.agent.prompt(id, text, images);
        if (result.ok) return null;
        const error = result.error ?? 'send failed';
        const { restore } = rollback;
        set((state) => {
          const current = state.conversations[id];
          if (!current) return state;
          return patch(state, id, {
            messages: current.messages.filter(
              (message) => message.deliveryId !== rollback.deliveryId
            ),
            // 纯文本退回输入框；带图片的连同附件回队首，不丢附件
            ...(restore.kind === 'draft' && !images?.length ? { draftText: restore.text } : {}),
            ...(restore.kind === 'queue' || (restore.kind === 'draft' && images?.length)
              ? {
                  queuedMessages: [
                    restore.kind === 'queue'
                      ? restore.item
                      : { id: crypto.randomUUID(), text: restore.text, images },
                    ...(current.queuedMessages ?? []),
                  ],
                }
              : {}),
            // goal 内部指令不进输入框：暂停并标注原因，由用户重新 resume
            ...(restore.kind === 'goal' && current.goal
              ? { goal: { ...current.goal, status: 'paused' as const, note: error } }
              : {}),
            started: false,
            status: 'failed',
            error,
          });
        });
        return error;
      }

      function optimisticUserMessage(
        text: string,
        images: AttachedImage[] | undefined,
        deliveryId: string
      ): TimelineMessage {
        return {
          role: 'user',
          content: [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...(images ?? []).map((image) => ({ type: 'image' as const, ...image })),
          ],
          timestamp: Date.now(),
          optimistic: true,
          deliveryId,
        };
      }

      /** goal 续跑:轮次收束且空闲、无排队消息/挂起项时,自动注入一条继续指令(带安全限制) */
      function continueGoal(id: string): void {
        const conversation = get().conversations[id];
        const goal = conversation?.goal;
        if (
          !conversation?.started ||
          conversation.workspaceMigrating ||
          conversation.status === 'running'
        )
          return;
        if (goal?.status !== 'active') return;
        if ((conversation.queuedMessages ?? []).length > 0) return;
        if (
          (conversation.pendingApprovals ?? []).length > 0 ||
          (conversation.pendingAsks ?? []).length > 0 ||
          (conversation.pendingCapabilityAsks ?? []).length > 0
        ) {
          return;
        }
        // 无进展守卫:最终 assistant 文本归一化比对,连续 3 次相同/为空即暂停
        const lastAssistant = [...conversation.messages]
          .reverse()
          .find((message) => message.role === 'assistant');
        const output = (lastAssistant?.content ?? [])
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('')
          .normalize('NFKC')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
        const noProgress = output === '' || output === goal.lastOutput;
        const noProgressRuns = noProgress ? goal.noProgressRuns + 1 : 0;
        if (noProgressRuns >= 3) {
          set((state) =>
            patch(state, id, {
              goal: {
                ...goal,
                status: 'paused',
                note: 'no progress in 3 consecutive runs',
                noProgressRuns,
              },
            })
          );
          return;
        }
        // 自动轮数上限:防无界烧钱
        if (goal.autoTurns >= 25) {
          set((state) =>
            patch(state, id, {
              goal: { ...goal, status: 'paused', note: 'automatic-turn limit (25) reached' },
            })
          );
          return;
        }
        set((state) =>
          patch(state, id, {
            goal: {
              ...goal,
              autoTurns: goal.autoTurns + 1,
              noProgressRuns,
              lastOutput: output,
            },
          })
        );
        const text =
          `<goal-continuation>\nSession goal: ${goal.text}\n` +
          'Continue working toward it. If it is genuinely done, call goal_complete with evidence; ' +
          'if you cannot proceed without the user, call goal_blocked; if waiting on something ' +
          'external, call goal_wait. Otherwise take the next concrete step now.\n</goal-continuation>';
        const deliveryId = crypto.randomUUID();
        set((state) =>
          patch(state, id, {
            messages: [
              ...state.conversations[id].messages,
              optimisticUserMessage(text, undefined, deliveryId),
            ],
          })
        );
        void deliver(id, text, undefined, 'prompt', { deliveryId, restore: { kind: 'goal' } });
      }
      /** 逐条投递排队消息:每次轮次收束只发队首一条(每条获得完整一轮),下轮结束再发下一条 */
      function flushQueue(id: string): void {
        const conversation = get().conversations[id];
        if (
          !conversation?.started ||
          conversation.workspaceMigrating ||
          conversation.status !== 'idle'
        )
          return;
        // 压缩排队/进行中先等压完：上下文还没换形就发下一条会打在旧占用上
        if (conversation.compaction) return;
        const [next, ...rest] = conversation.queuedMessages ?? [];
        if (!next) return;
        if (
          (conversation.pendingApprovals ?? []).length > 0 ||
          (conversation.pendingAsks ?? []).length > 0 ||
          (conversation.pendingCapabilityAsks ?? []).length > 0
        ) {
          return;
        }
        const deliveryId = crypto.randomUUID();
        set((state) =>
          patch(state, id, {
            queuedMessages: rest,
            messages: [
              ...state.conversations[id].messages,
              optimisticUserMessage(next.text, next.images, deliveryId),
            ],
          })
        );
        void deliver(id, next.text, next.images, 'prompt', {
          deliveryId,
          restore: { kind: 'queue', item: next },
        });
      }

      return {
        conversations: {},
        order: [],
        activeId: null,
        pendingAgentPrefill: undefined,
        worktreeStatuses: {},
        workspaceRevisionByConversation: {},

        async switchWorkspaceBranch(id, branch, create = false) {
          const conversation = get().conversations[id];
          const project = useSettingsStore
            .getState()
            .projects.find((item) => item.id === conversation?.projectId);
          if (
            !conversation ||
            conversation.parentId ||
            conversation.historyOnly ||
            conversation.archived ||
            !project ||
            project.kind === 'ssh'
          ) {
            return {
              ok: false,
              code: 'unavailable',
              error: 'Local root workspace is unavailable.',
            };
          }
          const cwd = conversation.worktree?.path ?? project.path;
          const roots = new Set(
            Object.values(get().conversations)
              .filter(
                (current) =>
                  !current.parentId &&
                  current.projectId === conversation.projectId &&
                  (current.worktree?.path ?? project.path) === cwd
              )
              .map((current) => current.id)
          );
          const targets = Object.values(get().conversations).filter(
            (current) =>
              roots.has(current.id) || Boolean(current.parentId && roots.has(current.parentId))
          );
          if (targets.some((current) => current.workspaceMigrating))
            return { ok: false, code: 'busy', error: 'Workspace operation in progress.' };
          if (
            targets.some(
              (current) => current.status === 'running' || current.spawning || current.compaction
            )
          )
            return {
              ok: false,
              code: 'running',
              error: 'A session using this workspace is running.',
            };
          set((state) => ({
            conversations: Object.fromEntries(
              Object.entries(state.conversations).map(([key, current]) => [
                key,
                targets.some((target) => target.id === key)
                  ? { ...current, workspaceMigrating: true }
                  : current,
              ])
            ),
          }));
          branchSwitchesInFlight.add(id);
          let remainsBlocked = false;
          try {
            const result = await window.electronAPI.worktree.switchBranch({
              conversationId: id,
              branch,
              create,
            });
            const projection = result.ok ? result.value : result.changed;
            remainsBlocked =
              !result.ok &&
              (result.workspaceBlocked === true || projection?.blockedReason === 'busy');
            if (!projection) return result;
            const affected = new Set(projection.affectedConversationIds);
            const records = new Map(
              projection.worktrees.map((record) => [record.conversationId, record])
            );
            set((state) => {
              const conversations = { ...state.conversations };
              const workspaceRevisionByConversation = { ...state.workspaceRevisionByConversation };
              for (const [key, current] of Object.entries(conversations)) {
                if (!affected.has(key) && !(current.parentId && affected.has(current.parentId)))
                  continue;
                const nextBranch = projection.currentBranch ?? branch;
                const consumed =
                  consumedBranchContexts.get(`${projection.requestId}:${key}`) ===
                    current.generation && current.generation !== undefined;
                conversations[key] = {
                  ...current,
                  ...(remainsBlocked ? { workspaceMigrating: true } : {}),
                  pendingWorkspaceBranch: consumed
                    ? undefined
                    : { requestId: projection.requestId, branch: nextBranch },
                  ...(records.has(key) ? { worktree: records.get(key) } : {}),
                  pendingWorkspaceNote:
                    [
                      withoutBranchNote(
                        current.pendingWorkspaceNote,
                        current.pendingWorkspaceBranch?.branch
                      ),
                      consumed ? undefined : workspaceBranchChangedNote(nextBranch),
                    ]
                      .filter(Boolean)
                      .join('\n\n') || undefined,
                };
                workspaceRevisionByConversation[key] =
                  (workspaceRevisionByConversation[key] ?? 0) + 1;
              }
              return { conversations, workspaceRevisionByConversation };
            });
            void get()
              .refreshWorktreeStatuses()
              .catch(() => {});
            return result;
          } catch (error) {
            return {
              ok: false,
              code: 'git-error',
              error: error instanceof Error ? error.message : String(error),
            };
          } finally {
            branchSwitchesInFlight.delete(id);
            if (!branchSwitchesInFlight.size) consumedBranchContexts.clear();
            set((state) => ({
              conversations: Object.fromEntries(
                Object.entries(state.conversations).map(([key, current]) => [
                  key,
                  !remainsBlocked && targets.some((target) => target.id === key)
                    ? { ...current, workspaceMigrating: undefined }
                    : current,
                ])
              ),
            }));
          }
        },

        async attachConversationToWorktree(id, sourceConversationId) {
          const conversation = get().conversations[id];
          const source = get().conversations[sourceConversationId];
          if (
            !conversation ||
            conversation.started ||
            conversation.spawning ||
            conversation.workspaceMigrating ||
            conversation.sessionFile ||
            conversation.parentId ||
            conversation.historyOnly ||
            conversation.archived ||
            conversation.worktree ||
            conversation.forkedFromConversationId ||
            conversation.messages.length > 0
          ) {
            return 'only fresh local root conversations can attach a worktree';
          }
          if (
            !source?.worktree ||
            source.parentId ||
            source.historyOnly ||
            source.worktreeMissing ||
            source.workspaceMigrating ||
            source.projectId !== conversation.projectId ||
            get().worktreeStatuses[sourceConversationId]?.exists === false
          ) {
            return 'source worktree is unavailable';
          }
          set((state) => patch(state, id, { workspaceMigrating: true }));
          try {
            const bound = await window.electronAPI.worktree.bind(id, sourceConversationId);
            if (!bound.ok) return bound.error;
            if (!get().conversations[id]) {
              await window.electronAPI.worktree.remove(id);
              return 'conversation was removed';
            }
            set((state) => patch(state, id, { worktree: bound.value, worktreeMissing: undefined }));
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          } finally {
            if (get().conversations[id]) {
              set((state) => patch(state, id, { workspaceMigrating: undefined }));
            }
          }
        },

        async renameWorktree(id, name) {
          if (!get().conversations[id]?.worktree) return 'conversation has no worktree';
          try {
            const renamed = await window.electronAPI.worktree.rename(id, name);
            if (!renamed.ok) return renamed.error;
            set((state) => {
              const conversations = { ...state.conversations };
              for (const worktree of renamed.value) {
                const current = conversations[worktree.conversationId];
                if (current?.worktree?.path === worktree.path) {
                  conversations[current.id] = { ...current, worktree };
                }
              }
              return { conversations };
            });
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },

        async moveConversationToWorktree(id, options) {
          const conversation = get().conversations[id];
          if (!conversation) return 'conversation not found';
          if (conversation.worktree) return 'conversation is already isolated';
          if (conversation.parentId) return 'coworker sessions cannot be isolated';
          // 迁移门必须在任何 await 之前立起来：未 started 的会话随时可能被
          // ChatView 自动 resume 用旧 cwd 复活（CDP 实测连续踩到多种时序）。
          set((state) => patch(state, id, { workspaceMigrating: true }));
          // fresh = 还没开聊的会话（composer 选择器入口）：没有需要「干净切换」的会话内容，
          // 不查主树干净（worktree 从 HEAD 建，主树脏不脏无关），也不注迁移提醒（无旧路径可失效）
          const fresh =
            !conversation.started &&
            !conversation.sessionFile &&
            conversation.messages.length === 0;
          try {
            // 主树脏不是硬错：worktree 从 HEAD 切，脏改动留在主树不会丢；
            // 仅当这些改动属于本会话时才可能「落下」，无法可靠推断，交给用户二次确认
            if (!fresh && !options?.allowDirtyMainTree) {
              const clean = await window.electronAPI.worktree.repoClean(conversation.projectId);
              if (!clean.ok) return clean.error;
              if (!clean.value) return DIRTY_MAIN_TREE;
            }
            // 运行中/已挂载的 worker 会话：cwd 在 spawn 时就固定了，必须释放后携新 cwd resume。
            // 重读 started：守卫立起前可能有 resume 溠进来把会话复活了
            if (get().conversations[id]?.started) {
              const released = await window.electronAPI.agent.release(id);
              if (!released.ok) return released.error ?? 'failed to release session';
            }
            const created = await window.electronAPI.worktree.create(id, conversation.projectId);
            if (!created.ok) return created.error;
            set((state) =>
              patch(state, id, {
                worktree: created.value,
                started: false,
                status: 'idle',
                ...(fresh
                  ? {}
                  : { pendingWorkspaceNote: workspaceMigratedNote(created.value.path) }),
              })
            );
            return null;
          } finally {
            set((state) => patch(state, id, { workspaceMigrating: undefined }));
          }
        },

        async cleanupWorktree(id) {
          const conversation = get().conversations[id];
          if (!conversation?.worktree) return 'conversation has no worktree';
          // 同 moveConversationToWorktree：迁移门挡住 release 后的自动 resume，
          // 否则会用即将被删的 worktree cwd 复活会话
          set((state) => patch(state, id, { workspaceMigrating: true }));
          try {
            // 重读 started：守卫立起前可能有自动 resume 溠进来把会话复活了
            if (get().conversations[id]?.started) {
              const released = await window.electronAPI.agent.release(id);
              if (!released.ok) return released.error ?? 'failed to release session';
            }
            const removed = await window.electronAPI.worktree.remove(id);
            if (!removed.ok) return removed.error;
            const projectPath = useSettingsStore
              .getState()
              .projects.find((project) => project.id === conversation.projectId)?.path;
            set((state) => ({
              conversations: patch(state, id, {
                worktree: undefined,
                worktreeMissing: undefined,
                started: false,
                spawning: false,
                status: 'idle',
                ...(projectPath
                  ? { pendingWorkspaceNote: workspaceFallbackNote(projectPath) }
                  : {}),
              }).conversations,
              worktreeStatuses: Object.fromEntries(
                Object.entries(state.worktreeStatuses).filter(([key]) => key !== id)
              ),
            }));
            return null;
          } finally {
            set((state) => patch(state, id, { workspaceMigrating: undefined }));
          }
        },

        async rebuildWorktree(id) {
          const conversation = get().conversations[id];
          if (!conversation?.worktree) return 'conversation has no worktree';
          const rebuilt = await window.electronAPI.worktree.rebuild(id);
          if (!rebuilt.ok) return rebuilt.error;
          set((state) => ({
            conversations: Object.fromEntries(
              Object.entries(state.conversations).map(([key, current]) => [
                key,
                current.worktree?.path === conversation.worktree!.path &&
                current.projectId === conversation.projectId
                  ? {
                      ...current,
                      worktree: { ...rebuilt.value, conversationId: key },
                      worktreeMissing: undefined,
                      pendingWorkspaceNote: current.sessionFile
                        ? workspaceMigratedNote(rebuilt.value.path)
                        : undefined,
                    }
                  : current,
              ])
            ),
          }));
          return null;
        },

        async fallbackToMainWorkspace(id) {
          const conversation = get().conversations[id];
          if (!conversation?.worktree) return;
          // 清掉 main 侧的登记与残留元数据（目录已丢，幂等）
          await window.electronAPI.worktree.remove(id);
          const projectPath = useSettingsStore
            .getState()
            .projects.find((project) => project.id === conversation.projectId)?.path;
          set((state) =>
            patch(state, id, {
              worktree: undefined,
              worktreeMissing: undefined,
              ...(projectPath ? { pendingWorkspaceNote: workspaceFallbackNote(projectPath) } : {}),
            })
          );
        },

        async refreshWorktreeStatuses() {
          const targets = get().conversations;
          const records = await window.electronAPI.worktree.list();
          const entries = await Promise.all(
            records
              .filter((record) => targets[record.conversationId])
              .map(async (record) => {
                const result = await window.electronAPI.worktree.status(record.conversationId);
                return { record, status: result.ok ? result.value : undefined };
              })
          );
          set((state) => {
            const conversations = { ...state.conversations };
            const worktreeStatuses = { ...state.worktreeStatuses };
            for (const { record, status } of entries) {
              const conversation = conversations[record.conversationId];
              if (
                !conversation ||
                conversation !== targets[record.conversationId] ||
                conversation.workspaceMigrating ||
                conversation.projectId !== record.projectId
              )
                continue;
              conversations[conversation.id] = {
                ...conversation,
                worktree: record,
                worktreeMissing: status
                  ? !status.exists || undefined
                  : conversation.worktreeMissing,
                ...(conversation.sessionFile && conversation.worktree?.path !== record.path
                  ? { pendingWorkspaceNote: workspaceMigratedNote(record.path) }
                  : {}),
              };
              if (status) worktreeStatuses[conversation.id] = status;
            }
            return { conversations, worktreeStatuses };
          });
        },

        async newConversation(projectId, options) {
          const sourceId = options?.worktreeFromConversationId;
          if (sourceId !== undefined) {
            const source = get().conversations[sourceId];
            if (
              options?.forkedFrom ||
              !source?.worktree ||
              source.projectId !== projectId ||
              source.parentId ||
              source.historyOnly ||
              source.worktreeMissing ||
              source.workspaceMigrating ||
              get().worktreeStatuses[sourceId]?.exists === false
            )
              return null;
          }
          const projection = await window.electronAPI.sourceAuthority.read();
          const activeConversationIds = new Set(
            projection.conversations
              .filter(
                (conversation) =>
                  conversation.projectId === projectId &&
                  conversation.kind === 'root' &&
                  conversation.lifecycle !== 'ended'
              )
              .map((conversation) => conversation.conversationId)
          );
          const existing =
            options?.forkedFrom || sourceId !== undefined
              ? undefined
              : get().order.find((id) => {
                  const conversation = get().conversations[id];
                  return (
                    activeConversationIds.has(id) &&
                    conversation.projectId === projectId &&
                    !conversation.started &&
                    !conversation.spawning &&
                    !conversation.workspaceMigrating &&
                    !conversation.worktree &&
                    !conversation.parentId &&
                    !conversation.historyOnly &&
                    conversation.archived !== true &&
                    !conversation.sessionFile &&
                    conversation.messages.length === 0 &&
                    !conversation.title
                  );
                });
          if (existing) {
            if (!(await activateConversationAuthority(existing))) return null;
            const pendingAgentPrefill = get().pendingAgentPrefill;
            set((state) => ({
              activeId: existing,
              pendingAgentPrefill: undefined,
              conversations: patch(state, existing, {
                unread: false,
                ...(pendingAgentPrefill
                  ? { activeTabId: undefined, prefillAgentTypeKey: pendingAgentPrefill }
                  : {}),
              }).conversations,
            }));
            return existing;
          }
          const project = projection.projects.find(
            (candidate) => candidate.projectId === projectId && candidate.state === 'active'
          );
          if (!project) return null;
          const created = await window.electronAPI.sourceAuthority.createConversation({
            requestId: crypto.randomUUID(),
            projectId,
            projectVersion: project.version,
            ...(options?.forkedFrom ? { forkedFrom: options.forkedFrom } : {}),
          });
          if (!created.accepted) return null;
          const id = created.value.conversationId;
          let worktree: SessionWorktree | undefined;
          if (sourceId !== undefined) {
            try {
              const bound = await window.electronAPI.worktree.bind(id, sourceId);
              if (!bound.ok) throw new Error(bound.error);
              worktree = bound.value;
            } catch {
              await purgeConversationAuthority(window.electronAPI.sourceAuthority, id, () =>
                crypto.randomUUID()
              );
              return null;
            }
          }
          const pendingAgentPrefill = get().pendingAgentPrefill;
          // 新会话应用默认预设；'default'（内置全局）或预设已删除时不写，spawn 时自然回落全局
          const settings = useSettingsStore.getState();
          const {
            defaultPresetId,
            presets,
            defaultReasoningEnabled,
            defaultThinkingLevel,
            approvalReviewer,
            lastApprovalMode,
            providers,
            projects,
            projectGroups,
          } = settings;
          const scopedReasoning = resolveChatReasoning({
            ...scopedDefaultModels(
              projects.find((entry) => entry.id === projectId),
              projectGroups
            ),
            defaultReasoningEnabled,
            defaultThinkingLevel,
          });
          const defaultPreset =
            defaultPresetId !== 'default' && presets.some((preset) => preset.id === defaultPresetId)
              ? { presetId: defaultPresetId }
              : {};
          const conversation: Conversation = {
            ...emptyProjection,
            id,
            projectId,
            title: '',
            started: false,
            spawning: false,
            createdAt: Date.now(),
            reasoningEnabled: scopedReasoning.reasoningEnabled,
            thinkingLevel: scopedReasoning.thinkingLevel,
            approvalMode: defaultApprovalMode(
              approvalReviewer,
              providers,
              oauthCredentialContext(useOauthCredentialStore.getState().snapshot),
              lastApprovalMode
            ),
            ...defaultPreset,
            ...(worktree ? { worktree } : {}),
            ...(pendingAgentPrefill ? { prefillAgentTypeKey: pendingAgentPrefill } : {}),
            ...(options?.forkedFrom
              ? {
                  forkedFromConversationId: options.forkedFrom.conversationId,
                  forkedFromEntryId: options.forkedFrom.entryId,
                }
              : {}),
          };
          set((state) => ({
            conversations: { ...state.conversations, [id]: conversation },
            order: [id, ...state.order],
            activeId: id,
            pendingAgentPrefill: undefined,
          }));
          await activateConversationAuthority(id);
          return id;
        },

        adoptPairSession(session) {
          // 幂等：手机重连可能重发，已登记就别覆盖本地状态
          if (get().conversations[session.sessionId]) return;
          const conversation: Conversation = {
            ...emptyProjection,
            id: session.sessionId,
            projectId: session.projectId,
            // 标题留空，首条用户消息到达时再补（手机建会话时还没有内容）
            title: '',
            // worker 侧已经起来了，这里直接标记为已启动，否则发消息会重复 spawn
            started: true,
            spawning: false,
            createdAt: Date.now(),
            reasoningEnabled: session.reasoningEnabled,
            thinkingLevel: (session.thinkingLevel as Conversation['thinkingLevel']) ?? 'medium',
            lastProviderId: session.providerId,
            lastModelId: session.modelId,
            ...(session.presetId ? { presetId: session.presetId } : {}),
            ...(session.approvalMode
              ? { approvalMode: session.approvalMode as Conversation['approvalMode'] }
              : {}),
          };
          set((state) => ({
            conversations: { ...state.conversations, [session.sessionId]: conversation },
            order: [session.sessionId, ...state.order],
          }));
          // 手机 spawn 自带 sessionId，桌面 newConversation 才会走 Main 发号。
          // 不登记的话点开会话会被当成 history-only。
          void adoptMissingRootAuthority(session.sessionId, session.projectId);
        },

        markConversationRead(id) {
          if (!get().conversations[id]) return;
          set((state) => patch(state, id, { unread: false }));
        },

        selectConversation(id) {
          if (!get().conversations[id]) return;
          const pendingAgentPrefill = get().pendingAgentPrefill;
          const local = get().conversations[id];
          set((state) => ({
            activeId: id,
            pendingAgentPrefill: undefined,
            conversations: patch(state, id, {
              unread: false,
              ...(pendingAgentPrefill
                ? { activeTabId: undefined, prefillAgentTypeKey: pendingAgentPrefill }
                : {}),
            }).conversations,
          }));
          void (async () => {
            if (local && !local.parentId) {
              await adoptMissingRootAuthority(id, local.projectId);
            }
            const authority = await activateConversationAuthority(id);
            if (authority || !get().conversations[id]) return;
            set((state) =>
              patch(state, id, {
                error: 'This conversation is history-only and cannot be dispatched.',
              })
            );
          })();
        },

        togglePinConversation(id) {
          set((state) => {
            const conversation = state.conversations[id];
            if (!conversation) return state;
            return patch(state, id, { pinned: conversation.pinned === true ? undefined : true });
          });
        },

        renameConversation(id, title) {
          const next = title.trim().slice(0, 80);
          if (!next) return;
          // 手动改名即永久锁定：在飞的自动总结作废，之后的回合也不再刷；失败红叹号一并清掉
          clearTitlePending(id);
          set((state) => {
            const conversation = state.conversations[id];
            if (!conversation) return state;
            if (
              conversation.title === next &&
              conversation.titleLocked &&
              conversation.titleSummaryError === undefined
            ) {
              return state;
            }
            return patch(state, id, {
              title: next,
              titleLocked: true,
              titleSummaryError: undefined,
            });
          });
        },

        retryTitleSummary(id) {
          const conversation = get().conversations[id];
          if (
            !conversation ||
            conversation.titleLocked ||
            !useSettingsStore.getState().titleSummaryEnabled ||
            pendingTitleBaselines.has(id)
          ) {
            return;
          }
          const model = {
            providerId: conversation.lastProviderId,
            modelId: conversation.lastModelId,
          };
          const currentTitle = conversation.title.trim();
          if (conversation.lastTurnDigest && currentTitle) {
            requestTitleSummary(
              id,
              conversation.title,
              { kind: 'rolling', currentTitle: conversation.title, ...conversation.lastTurnDigest },
              model
            );
            return;
          }
          // 首条总结就失败且还没跑完一轮：退回 initial；正文被冷驱逐时用当前标题兑底
          const text = cleanTitleSummarySource(firstUserRawText(conversation)) || currentTitle;
          if (!text.trim()) return;
          requestTitleSummary(id, conversation.title, { kind: 'initial', text }, model);
        },

        clearTitleSummaryState() {
          pendingTitleBaselines.clear();
          set((state) => {
            let changed = false;
            const conversations = Object.fromEntries(
              Object.entries(state.conversations).map(([id, conversation]) => {
                if (
                  conversation.titleSummaryPending === undefined &&
                  conversation.titleSummaryError === undefined
                ) {
                  return [id, conversation];
                }
                changed = true;
                return [
                  id,
                  { ...conversation, titleSummaryPending: undefined, titleSummaryError: undefined },
                ];
              })
            );
            return changed ? { conversations } : state;
          });
        },

        toggleArchiveConversation(id) {
          set((state) => {
            const conversation = state.conversations[id];
            if (!conversation) return state;
            return conversation.archived === true
              ? patch(state, id, { archived: undefined, archivedAt: undefined })
              : patch(state, id, { archived: true, pinned: undefined, archivedAt: Date.now() });
          });
        },

        async autoArchiveStaleConversations(now = Date.now()) {
          const idleDays = useSettingsStore.getState().autoArchiveIdleDays;
          if (!(idleDays > 0)) return;
          const cleanupMerged = useSettingsStore.getState().autoArchiveMergedWorktrees;
          const { order, conversations, activeId, worktreeStatuses } = get();
          const ids = staleUnarchivedConversationIds({
            order,
            conversations,
            now,
            idleDays,
            activeId,
            cleanupMergedWorktrees: cleanupMerged,
            worktreeStatuses,
          });
          if (ids.length === 0) return;
          const archive = (id: string) => {
            set((state) => {
              const conversation = state.conversations[id];
              if (!conversation || conversation.archived === true) return state;
              return patch(state, id, {
                archived: true,
                archivedAt: now,
                pinned: undefined,
              });
            });
          };
          const plain: string[] = [];
          const isolated: string[] = [];
          for (const id of ids) {
            if (conversations[id]?.worktree) isolated.push(id);
            else plain.push(id);
          }
          if (plain.length > 0) {
            set((state) => {
              let changed = false;
              const next = { ...state.conversations };
              for (const id of plain) {
                const conversation = next[id];
                if (!conversation || conversation.archived === true) continue;
                next[id] = {
                  ...conversation,
                  archived: true,
                  archivedAt: now,
                  pinned: undefined,
                };
                changed = true;
              }
              return changed ? { conversations: next } : state;
            });
          }
          for (const id of isolated) {
            const conversation = get().conversations[id];
            if (!conversation?.worktree || conversation.archived === true) continue;
            const status = worktreeStatuses[id];
            if (status?.exists !== false) {
              const error = await get().cleanupWorktree(id);
              if (error) continue;
            }
            archive(id);
          }
        },

        autoDeleteStaleArchived(now = Date.now()) {
          const days = useSettingsStore.getState().autoDeleteArchivedDays;
          if (!(days > 0)) return;
          const { order, conversations, activeId } = get();
          const ids = staleArchivedConversationIdsToDelete(
            order,
            conversations,
            days,
            now,
            activeId
          );
          for (const id of ids) get().removeConversation(id);
        },

        removeConversation(id) {
          const conversation = get().conversations[id];
          if (!conversation) return;
          // 先等 worker 释放、worktree 解绑成功，再丢弃投影与 authority。
          if (conversation.worktree) {
            if (conversation.workspaceMigrating) return;
            const reportError = (error: string) => {
              if (get().conversations[id]) set((state) => patch(state, id, { error }));
              void import('@/components/ui/toast')
                .then(({ addToast }) => addToast({ type: 'error', description: error }))
                .catch(() => {});
            };
            void get()
              .cleanupWorktree(id)
              .then((error) => {
                if (error) reportError(error);
                else get().removeConversation(id);
              })
              .catch((error: unknown) => reportError(String(error)));
            return;
          }
          // 级联解雇 coworker,防 worker 侧孤儿泄漏
          for (const coworkerId of conversation.coworkerIds ?? []) {
            if (conversation.started) {
              void window.electronAPI.agent.dismissCoworker(id, coworkerId);
            }
          }
          // release 内部会先 abort 再销毁 worker 侧会话树；只 abort 会让 ManagedSession
          // 留在 supervisor 的 Map 里直到 app 退出（jsonl 全量上下文常驻）
          if (conversation.started && !conversation.parentId) {
            void window.electronAPI.agent.release(id);
          } else if (conversation.started && conversation.status === 'running') {
            void window.electronAPI.agent.abort(id);
          }
          if (!conversation.parentId) {
            void purgeConversationAuthority(window.electronAPI.sourceAuthority, id, () =>
              crypto.randomUUID()
            );
          }
          set((state) => {
            const conversations = { ...state.conversations };
            for (const coworkerId of conversation.coworkerIds ?? []) {
              delete conversations[coworkerId];
            }
            delete conversations[id];
            const order = state.order.filter((entry) => entry !== id);
            forgetUnknownSessionClocks(conversations);
            return {
              conversations,
              order,
              activeId: state.activeId === id ? (order[0] ?? null) : state.activeId,
            };
          });
        },
        async dispatchAgent(typeKey, task, selectedModel) {
          const requestId = crypto.randomUUID();
          const parentId = get().activeId;
          const parent = parentId ? get().conversations[parentId] : undefined;
          if (!parentId || !parent || parent.parentId || parent.workspaceMigrating) {
            return {
              accepted: false,
              requestId,
              code: 'invalid-binding',
              message: 'Open a parent conversation before dispatching an Agent.',
            };
          }
          if (!selectedModel) {
            const result: AgentDispatchResult = {
              accepted: false,
              requestId,
              code: 'parent-model-unavailable',
              message:
                'Choose a usable model for the parent conversation before dispatching an Agent.',
              action: 'select-model',
            };
            set((state) => patch(state, parentId, { error: result.message }));
            return result;
          }
          try {
            await pendingSelectionUpdates.get(parentId);
            const authority = await activateConversationAuthority(parentId);
            if (!authority) {
              const result: AgentDispatchResult = {
                accepted: false,
                requestId,
                code: 'invalid-binding',
                message: 'This conversation is not an active Main-authorized source.',
              };
              set((state) => patch(state, parentId, { error: result.message }));
              return result;
            }
            const sourceBinding = await window.electronAPI.agentDispatch.bindSource({
              requestId: crypto.randomUUID(),
            });
            if (!sourceBinding.accepted) {
              const result: AgentDispatchResult = {
                accepted: false,
                requestId,
                code: 'invalid-binding',
                message: sourceBinding.error,
              };
              set((state) => patch(state, parentId, { error: result.message }));
              return result;
            }
            const selectionBinding = await window.electronAPI.agentDispatch.registerModelSelection({
              parentBindingId: sourceBinding.parentBindingId,
              selection: selectedModel,
            });
            if (!selectionBinding.accepted) {
              const result: AgentDispatchResult = {
                accepted: false,
                requestId,
                code: 'parent-model-unavailable',
                message: selectionBinding.error,
                action: 'select-model',
              };
              set((state) => patch(state, parentId, { error: result.message }));
              return result;
            }
            const result = await window.electronAPI.agentDispatch.dispatch({
              requestId,
              selectionBindingId: selectionBinding.binding.selectionBindingId,
              typeKey,
              task,
            });
            set((state) =>
              patch(state, parentId, {
                error: result.accepted ? undefined : result.message,
              })
            );
            return result;
          } catch (error) {
            const result: AgentDispatchResult = {
              accepted: false,
              requestId,
              code: 'dispatch-failed',
              message: error instanceof Error ? error.message : String(error),
              action: 'retry',
            };
            set((state) => patch(state, parentId, { error: result.message }));
            return result;
          }
        },

        prefillAgent(typeKey, prompt) {
          const parentId = get().activeId;
          if (parentId && get().conversations[parentId]) {
            set((state) => ({
              pendingAgentPrefill: undefined,
              conversations: patch(state, parentId, {
                activeTabId: undefined,
                prefillAgentTypeKey: typeKey,
                ...(prompt ? { draftText: prompt } : {}),
              }).conversations,
            }));
            return;
          }
          set({ pendingAgentPrefill: typeKey });
          const project = useSettingsStore.getState().projects[0];
          if (project) {
            void get()
              .newConversation(project.id)
              .then(() => {
                const newActiveId = get().activeId;
                if (newActiveId && prompt) {
                  set((state) => patch(state, newActiveId, { draftText: prompt }));
                }
              });
          }
        },

        clearAgentPrefill(conversationId) {
          const conversation = get().conversations[conversationId];
          if (!conversation?.prefillAgentTypeKey) return;
          set((state) => patch(state, conversationId, { prefillAgentTypeKey: undefined }));
        },

        async respondCapabilityAsk(conversationId, requestId, decision) {
          const conversation = get().conversations[conversationId];
          const request = conversation?.pendingCapabilityAsks?.find(
            (candidate) => candidate.requestId === requestId
          );
          if (!conversation || !request) return;
          const result = await window.electronAPI.capabilities.respond({
            child: request.child,
            turnId: request.turnId,
            requestId: request.requestId,
            decision,
          });
          if (!result.ok || !result.accepted) {
            set((state) =>
              patch(state, conversationId, {
                error: !result.ok ? result.error : 'This approval is no longer active.',
              })
            );
            return;
          }
          set((state) => {
            const current = state.conversations[conversationId];
            if (!current || current.generation !== request.child.generation) return state;
            return patch(state, conversationId, {
              pendingCapabilityAsks: (current.pendingCapabilityAsks ?? []).filter(
                (candidate) => candidate.requestId !== requestId
              ),
              activeOauthAsk:
                decision === 'allow' && request.host?.kind === 'oauth-login'
                  ? request
                  : current.activeOauthAsk?.requestId === requestId
                    ? undefined
                    : current.activeOauthAsk,
              error: undefined,
            });
          });
        },

        async send(text, target, images) {
          const submittedText = text;
          const activeId = get().activeId;
          if (!activeId) return 'no conversation';
          const activeTab = get().conversations[activeId]?.activeTabId;
          const id = activeTab && get().conversations[activeTab] ? activeTab : activeId;
          const conversation = get().conversations[id];
          if (conversation?.workspaceMigrating) return 'workspace operation in progress';
          // 只读回放的已结束实例：必须在乐观回显之前拦，否则会往只读历史里插一条
          // 根本没发出去的用户消息。
          if (conversation?.historyOnly) {
            return 'this Agent instance has ended — its history is read-only';
          }
          // /compact 应用级命令:压缩上下文,不发给 agent。会话未启动时无上下文可压
          const compactCommand = parseCompactCommand(text);
          if (compactCommand) {
            if (!conversation.started) return 'nothing to compact yet';
            get().compact(id, compactCommand.instructions);
            return null;
          }
          // /goal 应用级命令:设定/暂停/继续/清除会话目标,不发给 agent
          const goalMatch = /^\/goal(?:\s+([\s\S]+))?$/.exec(text.trim());
          let spawnTitle: string | undefined;
          if (goalMatch) {
            const arg = goalMatch[1]?.trim();
            if (!arg) return 'usage: /goal <objective> | /goal pause|resume|clear';
            if (arg === 'clear') {
              get().clearGoal(id);
              return null;
            }
            if (arg === 'pause') {
              get().pauseGoal(id);
              return null;
            }
            if (arg === 'resume') {
              get().resumeGoal(id);
              return null;
            }
            get().setGoal(id, arg);
            // 已 spawn:空闲由 setGoal kickoff,忙碌等本轮收束 continueGoal
            if (conversation.started) return null;
            // 未 spawn:把 kickoff 当首条消息走下面的 spawn+prompt,否则 GoalBar 会一直停在「推进中」
            spawnTitle = arg.slice(0, 40);
            text = startGoalPrompt(arg);
          }
          // 工作区迁移/回退提醒：随下一条实际发出的消息前置注入一次（同 goal 模式，可见）
          // 标题总结的输入在注入前定格：goal 用目标原文，普通消息清洗掉内部引用块与引导行
          const titleSummarySource = goalMatch?.[1]?.trim() ?? cleanTitleSummarySource(text);
          const workspaceNote = conversation.pendingWorkspaceNote;
          if (workspaceNote && !(conversation.started && conversation.status === 'running')) {
            text = `${workspaceNote}\n\n${text}`;
            set((state) => patch(state, id, { pendingWorkspaceNote: undefined }));
          }
          // agent 干活或压缩中消息进队列(不打断);收束后自动投递。压缩时 status 仍是 idle，
          // 立刻 prompt 会撞上 isStreaming 僵尸轮报错。
          if (
            conversation.started &&
            (conversation.status === 'running' || conversation.compaction)
          ) {
            const queuedId = crypto.randomUUID();
            set((state) =>
              patch(state, id, {
                queuedMessages: [
                  ...(state.conversations[id].queuedMessages ?? []),
                  { id: queuedId, text, ...(images?.length ? { images } : {}) },
                ],
              })
            );
            return null;
          }
          // 乐观回显：立即上屏，不等 spawn/prompt 往返。optimistic 标记使其作为
          // 未确认尾巴浮在权威消息之后，同文本 user upsert 到达时被消费；
          // 万一错位由 agent_end 的全量 reconcile 兜底。
          // coworker 由 worker 侧创建/恢复,永不走 spawn 分支；未恢复时在回显前拦下并显式报错
          if (!conversation.started && conversation.parentId) {
            const error = 'coworker not restored yet — resume the conversation first';
            set((state) =>
              patch(state, id, {
                status: 'failed',
                error,
                ...(images?.length
                  ? {
                      queuedMessages: [
                        { id: crypto.randomUUID(), text: submittedText, images },
                        ...(state.conversations[id].queuedMessages ?? []),
                      ],
                    }
                  : { draftText: submittedText }),
              })
            );
            return error;
          }
          const deliveryId = crypto.randomUUID();
          set((state) =>
            patch(state, id, {
              // 用户主动发新消息：上一次停止的抑制标记到此失效
              abortRequested: false,
              messages: [
                ...state.conversations[id].messages,
                optimisticUserMessage(text, images, deliveryId),
              ],
            })
          );
          if (!conversation.started && !conversation.spawning) {
            set((state) =>
              patch(state, id, {
                spawning: true,
                title:
                  conversation.title ||
                  spawnTitle ||
                  // 代表行提炼：chat 引用块折叠成 @标题，跳过无业务意义引导行，与 firstUserText 同规则
                  extractRepresentativeTitle(text),
              })
            );
            const result = await window.electronAPI.agent.spawn({
              sessionId: id,
              providerId: target.providerId,
              modelId: target.modelId,
              // 隔离会话一律在自己的 worktree 里跑，不信任调用方传的 cwd
              cwd: conversation.worktree?.path ?? target.cwd,
              resumeFile: conversation.sessionFile,
              reasoningEnabled: conversation.reasoningEnabled,
              thinkingLevel: conversation.thinkingLevel,
              loadLocalSkills: useSettingsStore.getState().loadLocalSkills,
              presetId: conversation.presetId,
              approvalMode: conversation.approvalMode ?? 'full',
            });
            if (!result.ok) {
              // 与 deliver 失败同口径：收回回显、原文退回输入框，不留“看起来发出去了”的假象
              set((state) =>
                patch(state, id, {
                  spawning: false,
                  status: 'failed',
                  error: result.error,
                  messages: state.conversations[id].messages.filter(
                    (message) => message.deliveryId !== deliveryId
                  ),
                  ...(images?.length
                    ? {
                        queuedMessages: [
                          { id: crypto.randomUUID(), text: submittedText, images },
                          ...(state.conversations[id].queuedMessages ?? []),
                        ],
                      }
                    : { draftText: submittedText }),
                })
              );
              return result.error ?? 'spawn failed';
            }
            set((state) =>
              patch(state, id, {
                started: true,
                lastProviderId: target.providerId,
                lastModelId: target.modelId,
              })
            );
            // 标题总结：仅全新会话（resume 有 sessionFile）且未被用户预先命名；
            // 并行发起不阻塞发消息，失败静默（截断标题已是可用兑底）
            if (
              useSettingsStore.getState().titleSummaryEnabled &&
              !conversation.sessionFile &&
              !conversation.title &&
              titleSummarySource.trim()
            ) {
              const baseline = get().conversations[id]?.title;
              if (baseline) {
                trySummarizeTitle(id, titleSummarySource, baseline, {
                  providerId: target.providerId,
                  modelId: target.modelId,
                });
              }
            }
          }
          // 注入过 goal/工作区提醒的文本不退回输入框，退用户原文
          return deliver(
            id,
            text,
            images,
            get().conversations[id]?.status === 'running' ? 'steer' : 'prompt',
            { deliveryId, restore: { kind: 'draft', text: submittedText } }
          );
        },

        async resumeConversation(id) {
          const conversation = get().conversations[id];
          if (
            !conversation ||
            conversation.started ||
            conversation.spawning ||
            // 工作区迁移中：此刻 resume 会用错 cwd 把会话复活（spawning 会被 worker 事件清掉，挡不住）
            conversation.workspaceMigrating
          ) {
            return;
          }
          if (!conversation.sessionFile) return;
          const settings = useSettingsStore.getState();
          const project = settings.projects.find((p) => p.id === conversation.projectId);
          if (!project) return;
          const snapshot = useOauthCredentialStore.getState().snapshot;
          const resolution = resolveChatModel({
            defaultModel: settings.defaultModel,
            ...scopedDefaultModels(project, settings.projectGroups),
            lastProviderId: conversation.lastProviderId,
            lastModelId: conversation.lastModelId,
            providers: settings.providers,
            credentials: oauthCredentialContext(snapshot),
          });
          // 有明确历史模型的旧会话只允许按原组合恢复；真实 logout/失效时不静默改模 spawn。
          const hasRememberedModel = Boolean(
            conversation.lastProviderId && conversation.lastModelId
          );
          if (
            resolution.source === 'none' ||
            (hasRememberedModel && resolution.source !== 'session')
          ) {
            return;
          }
          const { providerId, modelId } = resolution;
          // 隔离会话：resume 前先校验 worktree 还在不在（可能被 prune/手动删除）。
          // 丢失时不自动重建，标记 worktreeMissing 让用户选重建/回退（设计决策）。
          if (conversation.worktree) {
            const status = await window.electronAPI.worktree.status(id);
            if (!status.ok || !status.value.exists) {
              set((state) => patch(state, id, { worktreeMissing: true }));
              return;
            }
          }
          set((state) => patch(state, id, { spawning: true }));
          const result = await window.electronAPI.agent.spawn({
            sessionId: id,
            providerId,
            modelId,
            cwd: conversation.worktree?.path ?? project.path,
            resumeFile: conversation.sessionFile,
            reasoningEnabled: conversation.reasoningEnabled,
            thinkingLevel: conversation.thinkingLevel,
            loadLocalSkills: settings.loadLocalSkills,
            presetId: conversation.presetId,
            approvalMode: conversation.approvalMode ?? 'full',
          });
          set((state) =>
            result.ok
              ? // spawning 不在此清除——worker 侧 spawn 要跑几秒到几十秒（runtime/skill/MCP/回放），
                // IPC 只是命令入队的同步 ack；等该会话首个 worker 事件（status/snapshot）到达再清
                patch(state, id, {
                  started: true,
                  status: 'idle',
                  error: undefined,
                  lastProviderId: providerId,
                  lastModelId: modelId,
                })
              : patch(state, id, { spawning: false, status: 'failed', error: result.error })
          );
          // child 的级联恢复在 Main 侧：parent-ready 后 Main 按自己读的持久化恢复
          // 未 ended 的 child（渲染层不传路径、不指定身份），tab 由事件回流重建。
        },

        async loadOlderHistory(id) {
          if (olderHistoryInFlight.has(id)) return;
          const conversation = get().conversations[id];
          const beforeIndex = conversation?.historyBaseIndex;
          if (!conversation || conversation.parentId || !beforeIndex || beforeIndex <= 0) return;
          const read = window.electronAPI.agent.readParentHistoryTail;
          if (!read) return;
          olderHistoryInFlight.add(id);
          set((state) => patch(state, id, { historyLoading: true }));
          try {
            const result = await read(id, beforeIndex);
            if (!result.ok || result.messages.length === 0) return;
            const latest = get().conversations[id];
            if (!latest || latest.historyBaseIndex !== beforeIndex) return;
            set((state) => {
              const current = state.conversations[id];
              if (!current) return state;
              const next = applyHistoryPage(current, {
                baseIndex: result.baseIndex,
                messages: result.messages,
              });
              return next === current ? state : patch(state, id, next);
            });
          } catch {
            // 翻页失败保持已有尾窗，下次到顶再试
          } finally {
            olderHistoryInFlight.delete(id);
            if (get().conversations[id]) {
              set((state) => patch(state, id, { historyLoading: undefined }));
            }
          }
        },

        reloadConversation(id) {
          const inFlight = reloadInFlight.get(id);
          if (inFlight) return inFlight.promise;
          const before = get().conversations[id];
          if (!before) return Promise.resolve('Conversation not found.');
          const entry: { buffered: RendererAgentEvent[]; promise: Promise<string | null> } = {
            buffered: [],
            promise: Promise.resolve(null),
          };
          entry.promise = (async (): Promise<string | null> => {
            set((state) => patch(state, id, { reloading: true }));
            try {
              const result = await window.electronAPI.agent.reloadConversation(id);
              if (!result.ok) return result.error;
              const latest = get().conversations[id];
              // 在途中被删除：丢弃，不复活。代际已变（重新 spawn）：旧代 live 快照不得覆盖新代
              if (!latest || latest.generation !== before.generation) return null;
              set((state) => {
                const current = state.conversations[id];
                if (!current) return state;
                const next = applyConversationReload(current, id, result, entry.buffered);
                return next === current ? state : patch(state, id, next as Conversation);
              });
              return null;
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            } finally {
              reloadInFlight.delete(id);
              if (get().conversations[id]) {
                set((state) => patch(state, id, { reloading: undefined }));
              }
            }
          })();
          reloadInFlight.set(id, entry);
          return entry.promise;
        },

        async addImportedConversation(projectId, imported) {
          const id = await get().newConversation(projectId);
          if (!id) return null;
          set((state) =>
            patch(state, id, {
              title: imported.title || '[imported]',
              sessionFile: imported.sessionFile,
            })
          );
          return id;
        },

        setReasoning(id, enabled) {
          const conversation = get().conversations[id];
          if (!conversation) return;
          set((state) => patch(state, id, { reasoningEnabled: enabled }));
          // 已 spawn 的会话即时切换：worker 就地改 model.reasoning，下条请求生效
          if (conversation.started) {
            void window.electronAPI.agent.setReasoning(
              id,
              enabled,
              enabled ? (conversation.thinkingLevel ?? 'medium') : undefined
            );
          }
        },

        setThinking(id, level) {
          const conversation = get().conversations[id];
          if (!conversation) return;
          set((state) => patch(state, id, { thinkingLevel: level }));
          if (conversation.started && conversation.reasoningEnabled) {
            void window.electronAPI.agent.setThinking(id, level);
          }
        },

        setPreset(id, presetId) {
          if (!get().conversations[id]) return;
          set((state) => patch(state, id, { presetId }));
        },
        setModel(id, providerId, modelId) {
          const conversation = get().conversations[id];
          if (!conversation) return;
          const parentId = conversation.parentId ?? id;
          set((state) =>
            patch(state, parentId, { lastProviderId: providerId, lastModelId: modelId })
          );
          // 已启动的会话必须真正换掉 worker 里的模型：只改记忆会让选择器显示新模型
          // 而请求仍走旧 provider，且后续 @Agent 派发因 selection 对不上而被拒（issue #30）。
          if (get().conversations[parentId]?.started) {
            void window.electronAPI.agent.setModel(parentId, providerId, modelId).then((result) => {
              if (!result.ok && get().conversations[parentId]) {
                set((state) => patch(state, parentId, { error: result.error }));
              }
            });
          }
          const update = window.electronAPI.sourceAuthority
            .read()
            .then((projection) => {
              const authority = projection.conversations.find(
                (candidate) =>
                  candidate.conversationId === parentId && candidate.lifecycle !== 'ended'
              );
              if (!authority) return null;
              return window.electronAPI.sourceAuthority.updateConversationSelection({
                requestId: crypto.randomUUID(),
                conversationId: parentId,
                version: authority.version,
                selection: { providerId, modelId },
              });
            })
            .then((result) => {
              if (!result || result.accepted || !get().conversations[parentId]) return;
              set((state) => patch(state, parentId, { error: result.error }));
            })
            .finally(() => {
              if (pendingSelectionUpdates.get(parentId) === update) {
                pendingSelectionUpdates.delete(parentId);
              }
            });
          pendingSelectionUpdates.set(parentId, update);
        },

        setApprovalMode(id, mode) {
          const previous = get().conversations[id]?.approvalMode;
          set((state) => patch(state, id, { approvalMode: mode }));
          useSettingsStore.getState().setLastApprovalMode(mode);
          const conversation = get().conversations[id];
          if (conversation?.started) {
            void window.electronAPI.agent.setApprovalMode(id, mode).then((result) => {
              if (result && !result.ok) {
                set((state) => patch(state, id, { approvalMode: previous ?? 'full' }));
                if (previous) useSettingsStore.getState().setLastApprovalMode(previous);
              }
            });
          }
        },

        async abort() {
          const activeId = get().activeId;
          if (!activeId) return;
          const activeTab = get().conversations[activeId]?.activeTabId;
          const id = activeTab && get().conversations[activeTab] ? activeTab : activeId;
          const conversation = get().conversations[id];
          if (!conversation?.started) return;
          // 停止 = 用户接管：本轮收束不再自动续跑，活动目标一并暂停（可手动恢复）
          const goal = conversation.goal;
          set((state) =>
            patch(state, id, {
              abortRequested: true,
              ...(goal?.status === 'active'
                ? { goal: { ...goal, status: 'paused' as const, note: 'stopped by user' } }
                : {}),
            })
          );
          await window.electronAPI.agent.abort(id);
        },

        setGoal(conversationId, text) {
          const conversation = get().conversations[conversationId];
          if (!conversation || conversation.workspaceMigrating || !text.trim()) return;
          set((state) =>
            patch(state, conversationId, {
              goal: {
                text: text.trim(),
                status: 'active',
                autoTurns: 0,
                noProgressRuns: 0,
              },
            })
          );
          // kickoff:目标说明 + 终止工具指引;后续每轮收束由 continueGoal 续跑
          if (conversation.started && conversation.status === 'idle') {
            const kickoff = startGoalPrompt(text.trim());
            const deliveryId = crypto.randomUUID();
            set((state) =>
              patch(state, conversationId, {
                messages: [
                  ...state.conversations[conversationId].messages,
                  optimisticUserMessage(kickoff, undefined, deliveryId),
                ],
              })
            );
            void deliver(conversationId, kickoff, undefined, 'prompt', {
              deliveryId,
              restore: { kind: 'goal' },
            });
          }
        },

        pauseGoal(conversationId) {
          const goal = get().conversations[conversationId]?.goal;
          if (!goal) return;
          set((state) =>
            patch(state, conversationId, { goal: { ...goal, status: 'paused', note: undefined } })
          );
        },

        resumeGoal(conversationId) {
          if (get().conversations[conversationId]?.workspaceMigrating) return;
          const goal = get().conversations[conversationId]?.goal;
          if (!goal) return;
          // 恢复即重置安全计数(与 pi-goal 的 guided review 语义一致:人已过目)
          set((state) =>
            patch(state, conversationId, {
              goal: {
                ...goal,
                status: 'active',
                note: undefined,
                autoTurns: 0,
                noProgressRuns: 0,
              },
            })
          );
          const conversation = get().conversations[conversationId];
          if (conversation?.started && conversation.status === 'idle') {
            const text =
              `<goal-continuation>\nSession goal resumed: ${goal.text}\n` +
              'Continue working toward it (goal_complete / goal_blocked / goal_wait to stop).\n</goal-continuation>';
            const deliveryId = crypto.randomUUID();
            set((state) =>
              patch(state, conversationId, {
                messages: [
                  ...state.conversations[conversationId].messages,
                  optimisticUserMessage(text, undefined, deliveryId),
                ],
              })
            );
            void deliver(conversationId, text, undefined, 'prompt', {
              deliveryId,
              restore: { kind: 'goal' },
            });
          }
        },

        clearGoal(conversationId) {
          if (!get().conversations[conversationId]) return;
          set((state) => patch(state, conversationId, { goal: undefined }));
        },

        selectTab(parentId, tabId) {
          if (!get().conversations[parentId]) return;
          set((state) => patch(state, parentId, { activeTabId: tabId }));
          if (tabId && tabId !== parentId) void loadChildHistory(tabId);
        },

        async dismissCoworkerFromUI(parentId, coworkerId) {
          const result = await window.electronAPI.agent.dismissCoworker(parentId, coworkerId, true);
          if (result.ok) return;
          const coworker = get().conversations[coworkerId];
          // 只兑底「worker/Main 侧本就没有实体」的死 tab（重启后未恢复）；
          // 活会话的 dismiss 失败不能静默吞 tab，否则 worker 侧会泄漏孤儿会话。
          if (!coworker || coworker.started || coworker.spawning) return;
          set((state) => {
            const parent = state.conversations[parentId];
            if (!parent) return state;
            const conversations = { ...state.conversations };
            delete conversations[coworkerId];
            conversations[parentId] = {
              ...parent,
              coworkerIds: (parent.coworkerIds ?? []).filter((id) => id !== coworkerId),
              activeTabId: parent.activeTabId === coworkerId ? undefined : parent.activeTabId,
            };
            forgetUnknownSessionClocks(conversations);
            return { conversations };
          });
        },

        removeQueuedMessage(conversationId, messageId) {
          set((state) =>
            patch(state, conversationId, {
              queuedMessages: (state.conversations[conversationId]?.queuedMessages ?? []).filter(
                (message) => message.id !== messageId
              ),
            })
          );
        },

        enqueueMessage(conversationId, text, images) {
          const conversation = get().conversations[conversationId];
          if (!conversation) return;
          if (!text && !images?.length) return;
          set((state) =>
            patch(state, conversationId, {
              queuedMessages: [
                ...(state.conversations[conversationId].queuedMessages ?? []),
                { id: crypto.randomUUID(), text, ...(images?.length ? { images } : {}) },
              ],
            })
          );
        },

        updateQueuedMessage(conversationId, messageId, text) {
          set((state) =>
            patch(state, conversationId, {
              queuedMessages: (state.conversations[conversationId]?.queuedMessages ?? []).map(
                (message) => (message.id === messageId ? { ...message, text } : message)
              ),
            })
          );
        },

        compact(conversationId, instructions) {
          const conversation = get().conversations[conversationId];
          if (!conversation?.started || conversation.workspaceMigrating || conversation.compaction)
            return;
          void window.electronAPI.agent.compact(conversationId, instructions);
        },

        clearCompactionError(conversationId) {
          if (!get().conversations[conversationId]?.compactionError) return;
          set((state) => patch(state, conversationId, { compactionError: undefined }));
        },

        rewind(conversationId, userIndexFromEnd, restoreFiles) {
          const conversation = get().conversations[conversationId];
          if (
            !conversation ||
            conversation.historyOnly ||
            conversation.workspaceMigrating ||
            conversation.status === 'running'
          ) {
            return;
          }
          if (rewindInFlight.has(conversationId)) return;
          if (shouldSendRewindCommand(conversation)) {
            void window.electronAPI.agent.rewind(conversationId, userIndexFromEnd, restoreFiles);
            return;
          }
          if (!conversation.started && !canWakeConversationForRewind(conversation)) return;
          rewindInFlight.add(conversationId);
          const sessionFile = conversation.sessionFile;
          void (async () => {
            try {
              if (!get().conversations[conversationId]?.started) {
                await get().resumeConversation(conversationId);
              }
              const phase = await new Promise<'ready' | 'failed'>((resolve) => {
                let settled = false;
                const finish = (next: 'ready' | 'failed') => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  unsubscribe();
                  resolve(next);
                };
                const check = () => {
                  const next = rewindWorkerPhase(get().conversations[conversationId], sessionFile);
                  if (next !== 'wait') finish(next);
                };
                const unsubscribe = useSessionsStore.subscribe(check);
                const timer = setTimeout(() => finish('failed'), 30_000);
                check();
              });
              const after = get().conversations[conversationId];
              if (
                phase === 'ready' &&
                after &&
                shouldSendRewindCommand(after) &&
                after.sessionFile === sessionFile
              ) {
                void window.electronAPI.agent.rewind(
                  conversationId,
                  userIndexFromEnd,
                  restoreFiles
                );
                return;
              }
              if (after && !after.error && !after.worktreeMissing && phase === 'failed') {
                set((state) =>
                  patch(state, conversationId, {
                    error: 'Unable to restore this conversation for rewind.',
                  })
                );
              }
            } catch {
              return;
            } finally {
              rewindInFlight.delete(conversationId);
            }
          })();
        },

        async forkFromMessage(conversationId, userIndexFromEnd) {
          return forkConversation(get, set, conversationId, { userIndexFromEnd });
        },

        async forkFromEntry(conversationId, entryId) {
          return forkConversation(get, set, conversationId, { entryId });
        },

        retry(conversationId) {
          const conversation = get().conversations[conversationId];
          if (
            !conversation?.started ||
            conversation.spawning ||
            conversation.workspaceMigrating ||
            conversation.status === 'running'
          ) {
            return;
          }
          void window.electronAPI.agent.retry(conversationId);
        },

        clearDraft(conversationId) {
          if (get().conversations[conversationId]?.draftText === undefined) return;
          set((state) => patch(state, conversationId, { draftText: undefined }));
        },

        sendQueuedNow(conversationId, messageId) {
          const conversation = get().conversations[conversationId];
          const item = conversation?.queuedMessages?.find((message) => message.id === messageId);
          if (!conversation || conversation.workspaceMigrating || !item) return;
          if (conversation.compaction) return;
          const running = conversation.status === 'running';
          // 出队并乐观回显。optimistic 标记使其浮在权威消息之后：running 时 steer
          // 要到下一个循环边界才送达，期间当前轮的 assistant upsert 若按裸 index
          // 覆盖会把回显顶掉（消息凭空消失，轮次结束后又出现）。
          const deliveryId = crypto.randomUUID();
          set((state) =>
            patch(state, conversationId, {
              queuedMessages: (state.conversations[conversationId]?.queuedMessages ?? []).filter(
                (message) => message.id !== messageId
              ),
              messages: [
                ...state.conversations[conversationId].messages,
                optimisticUserMessage(item.text, item.images, deliveryId),
              ],
            })
          );
          // running 时 steer 插入当前轮
          void deliver(conversationId, item.text, item.images, running ? 'steer' : 'prompt', {
            deliveryId,
            restore: { kind: 'queue', item },
          });
        },

        async interruptAndSendQueued(conversationId, messageId) {
          const conversation = get().conversations[conversationId];
          const item = conversation?.queuedMessages?.find((message) => message.id === messageId);
          if (!conversation?.started || conversation.workspaceMigrating || !item) return;
          if (conversation.status !== 'running') {
            get().sendQueuedNow(conversationId, messageId);
            return;
          }
          // 用户接管：中断本轮不自动续跑，活动目标一并暂停（与 abort 一致）
          const goal = conversation.goal;
          set((state) =>
            patch(state, conversationId, {
              abortRequested: true,
              ...(goal?.status === 'active'
                ? { goal: { ...goal, status: 'paused' as const, note: 'stopped by user' } }
                : {}),
            })
          );
          await window.electronAPI.agent.abort(conversationId);
          // 中断的轮次走 abortRequested 收口，不触发 flushQueue，需自行等到收束再投递
          await new Promise<void>((resolve) => {
            if (get().conversations[conversationId]?.status !== 'running') return resolve();
            const done = () => {
              clearTimeout(timer);
              unsubscribe();
              resolve();
            };
            const unsubscribe = useSessionsStore.subscribe((state) => {
              if (state.conversations[conversationId]?.status !== 'running') done();
            });
            const timer = setTimeout(done, 10_000);
          });
          if (
            !get().conversations[conversationId]?.started ||
            get().conversations[conversationId]?.workspaceMigrating
          )
            return;
          const deliveryId = crypto.randomUUID();
          set((state) =>
            patch(state, conversationId, {
              queuedMessages: (state.conversations[conversationId]?.queuedMessages ?? []).filter(
                (message) => message.id !== messageId
              ),
              messages: [
                ...state.conversations[conversationId].messages,
                optimisticUserMessage(item.text, item.images, deliveryId),
              ],
            })
          );
          void deliver(conversationId, item.text, item.images, 'prompt', {
            deliveryId,
            restore: { kind: 'queue', item },
          });
        },

        async hireCoworker(parentId, name, agentType) {
          const parent = get().conversations[parentId];
          if (!parent?.started) return 'conversation not started';
          const trimmed = name.trim();
          if (!trimmed) return 'invalid name';
          // 走 Main dispatch（与 Enso team.hire 同款守卫）；tab 建立与选中由
          // child-reserved 事件回流驱动，本地不预先造会话对象。
          const result = await window.electronAPI.agent.hireCoworker(parentId, trimmed, agentType);
          return result.ok ? null : (result.error ?? 'hire failed');
        },
      };
    },
    {
      name: 'enso-conversations',
      version: SESSIONS_VERSION,
      migrate: (persisted, version) => migrateSessions(persisted, version) as SessionsState,
      // 存 settings.json（localStorage 按 origin 隔离，dev 与打包版会分家）
      storage: createElectronPersistStorage(),
      // 只存元数据：messages 由 worker snapshot 补回（刷新场景）；app 重启后拿不回则标结束
      partialize: (state) => cachedPartializeSessions(state),
      onRehydrateStorage: () => (_state, error) => {
        if (!error) openPersistWriteGate('enso-conversations');
        // 刷新时 worker 仍活着：只补当前正在看的会话正文。其它会话点开再 snapshot。
        const state = useSessionsStore.getState();
        const viewed = viewedFromState(state);
        if (viewed) {
          void hydrateParentHistoryTail(viewed);
          void window.electronAPI.agent.requestSnapshot(viewed);
        }
        void syncConversationProjectIds()
          .then(() => useSessionsStore.getState().refreshWorktreeStatuses())
          .catch(() => {});
      },
    }
  )
);

async function syncConversationProjectIds(): Promise<void> {
  const authority = await window.electronAPI.sourceAuthority.read();
  const conversations = useSessionsStore.getState().conversations;
  const next = remapConversationProjectIds(conversations, authority.conversations);
  if (next !== conversations) useSessionsStore.setState({ conversations: next });
}

void syncConversationProjectIds();
window.electronAPI.sourceAuthority.onChanged((projection) => {
  const conversations = useSessionsStore.getState().conversations;
  const next = remapConversationProjectIds(conversations, projection.conversations);
  if (next !== conversations) useSessionsStore.setState({ conversations: next });
});

// 标题总结开关关闭：在飞与失败残留一起清掉，否则转圈/红叹号会在关闭后继续挂在侧栏
useSettingsStore.subscribe((state, previous) => {
  if (state.titleSummaryEnabled || !previous.titleSummaryEnabled) return;
  useSessionsStore.getState().clearTitleSummaryState();
});

// 上报「当前正在查看的会话」给 main：窗口聚焦时,只有正被查看的会话才抑制系统通知。
// tab 生效时以 tab（coworker/子会话）为准,与 sendActive 等处的解析口径一致。
let lastReportedViewedId: string | null = null;

async function hydrateParentHistoryTail(conversationId: string): Promise<void> {
  if (parentTailInFlight.has(conversationId)) return;
  const current = useSessionsStore.getState().conversations[conversationId];
  if (!current || current.parentId || hasAuthoritativeMessages(current.messages)) return;
  const read = window.electronAPI.agent.readParentHistoryTail;
  if (!read) return;
  parentTailInFlight.add(conversationId);
  try {
    const result = await read(conversationId);
    if (!result.ok || result.messages.length === 0) {
      markParentHistoryAttempted(conversationId);
      return;
    }
    const latest = useSessionsStore.getState().conversations[conversationId];
    if (!latest || latest.parentId || hasAuthoritativeMessages(latest.messages)) return;
    const optimistic = latest.messages.filter((message) => message.optimistic);
    useSessionsStore.setState({
      conversations: {
        ...useSessionsStore.getState().conversations,
        [conversationId]: {
          ...latest,
          messages: optimistic.length > 0 ? [...result.messages, ...optimistic] : result.messages,
          historyBaseIndex: result.baseIndex > 0 ? result.baseIndex : undefined,
        },
      },
    });
  } catch {
    // 尾巴失败不挡 resume；worker 快照仍能补回正文
    markParentHistoryAttempted(conversationId);
  } finally {
    parentTailInFlight.delete(conversationId);
  }
}

/** 尾窗读不到就收口：否则 failed 会话会卡在 Preparing 永久转圈 */
function markParentHistoryAttempted(conversationId: string): void {
  useSessionsStore.setState((state) => {
    const conversation = state.conversations[conversationId];
    if (!conversation || conversation.historyLoadAttempted) return state;
    return patch(state, conversationId, { historyLoadAttempted: true });
  });
}

useSessionsStore.subscribe((state) => {
  const viewed = viewedFromState(state);
  if (viewed === lastReportedViewedId) return;
  const previousViewedId = lastReportedViewedId;
  lastReportedViewedId = viewed;
  window.electronAPI.agent.setViewedSession?.(viewed);
  stampViewDeparture(lastViewedAt, previousViewedId, viewed, Date.now());
  const conversation = viewed ? state.conversations[viewed] : undefined;
  if (viewed && conversation) {
    // 历史补水不受 failed 门控：红字与历史同屏，而不是只剩红字
    if (needsHistoryHydration(conversation)) void hydrateParentHistoryTail(viewed);
    // worker 若还持有，快照比尾窗完整（审批 / 进行中轮次）；回空则由 sessionId 路由收回 started
    if (needsWorkerSnapshot(conversation)) void window.electronAPI.agent.requestSnapshot(viewed);
  }
  if (evictTimer) clearTimeout(evictTimer);
  evictTimer = setTimeout(() => {
    const current = useSessionsStore.getState();
    const next = evictColdMessages(
      current.conversations,
      viewedFromState(current),
      lastViewedAt,
      Date.now()
    );
    if (next !== current.conversations) useSessionsStore.setState({ conversations: next });
  }, MESSAGE_CACHE_TTL_MS);
  evictTimer.unref?.();
});

async function forkConversation(
  get: () => {
    conversations: Record<string, Conversation>;
    newConversation: (
      projectId: string,
      options?: { forkedFrom?: { conversationId: string; entryId: string } }
    ) => Promise<string | null>;
    removeConversation: (id: string) => void;
  },
  _set: unknown,
  sourceId: string,
  anchor: { entryId: string } | { userIndexFromEnd: number }
): Promise<string | null> {
  const source = get().conversations[sourceId];
  if (!source?.started || source.status !== 'idle' || source.parentId || source.historyOnly) {
    return null;
  }
  const targetId = await get().newConversation(source.projectId, {
    forkedFrom: {
      conversationId: source.id,
      entryId: 'entryId' in anchor ? anchor.entryId : `user:${anchor.userIndexFromEnd}`,
    },
  });
  if (!targetId) return null;
  const result = await window.electronAPI.agent.fork(sourceId, targetId, anchor);
  if (!result.ok) {
    get().removeConversation(targetId);
    return null;
  }
  return targetId;
}
