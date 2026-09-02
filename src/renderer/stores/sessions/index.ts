import type { AgentTypeKey } from '@shared/builtinAgents';
import type { CapabilityAskRequest } from '@shared/capabilities/types';
import { type DefaultModelRef, resolveChatModel } from '@shared/defaultModel';
import type {
  ApprovalMode,
  AttachedImage,
  ChildConversationMetadata,
  ConversationAuthorityProjection,
  DispatchMainEvent,
  ProjectAuthorityProjection,
  ThinkingLevel,
} from '@shared/types/agent';
import type { AgentDispatchResult, AgentDispatchTask } from '@shared/types/mentions';
import type { PairCreatedSession } from '@shared/types/pair';
import type { SessionWorktree, WorktreeStatus } from '@shared/types/worktree';
// 纯逻辑模块(仅类型级依赖),store 引用不破坏 node 环境测试
import { mentionDisplayText } from '@/components/chat/mentionComposer';

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
import { createJSONStorage, persist } from 'zustand/middleware';
import { oauthCredentialContext, useOauthCredentialStore } from '@/stores/oauthCredentials';
import { useSettingsStore } from '@/stores/settings';
import { electronStorage } from '@/stores/settings/storage';
import {
  evictColdMessages,
  isBulkyAgentEvent,
  isMessageCacheHot,
  MESSAGE_CACHE_TTL_MS,
  viewedConversationId,
} from './messageCache';
import { migrateSessions, SESSIONS_VERSION } from './migrate';
import {
  applyAgentEvent,
  applyDispatchEvent,
  emptyProjection,
  type SessionProjection,
} from './reducer';
import { isPairViewed, nextUnread } from './unread';
import { workspaceFallbackNote, workspaceMigratedNote } from './worktree';

const lastViewedAt: Record<string, number> = {};
let evictTimer: ReturnType<typeof setTimeout> | null = null;

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
  /** 无 project 时保留的一次性 summon；下一条普通 draft 消费。 */
  pendingAgentPrefill?: AgentTypeKey;

  newConversation(projectId: string): Promise<string | null>;
  /** 会话切到隔离 worktree（composer 选择器/右键菜单入口）。
   *  fresh（未开聊）直接绑定；已有内容走完整迁移（主树干净检查 + release + 迁移提醒）。返回错误或 null */
  moveConversationToWorktree(id: string): Promise<string | null>;
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
  /** 切换会话归档(归档时同时清置顶) */
  toggleArchiveConversation(id: string): void;
  dispatchAgent(
    typeKey: AgentTypeKey,
    task: AgentDispatchTask,
    selectedModel: DefaultModelRef | null
  ): Promise<AgentDispatchResult>;
  prefillAgent(typeKey: AgentTypeKey): void;
  clearAgentPrefill(conversationId: string): void;
  respondCapabilityAsk(
    conversationId: string,
    requestId: string,
    decision: 'allow' | 'deny'
  ): Promise<void>;
  send(text: string, target: SendTarget, images?: AttachedImage[]): Promise<string | null>;
  /** app 重启后从 jsonl 恢复会话并回放历史（未 started 且有 sessionFile 时有效） */
  resumeConversation(id: string): Promise<void>;
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
  /** 回退到倒数第 N+1 条 user 消息(0 = 最后一条);截断与预填由 worker 事件回流。
   *  restoreFiles 同时还原工作树文件 */
  rewind(conversationId: string, userIndexFromEnd: number, restoreFiles?: boolean): void;
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

/** 首条用户消息的文本，用作手机端建会话的标题（桌面建的在 spawn 时已有标题） */
function firstUserText(projection: SessionProjection): string {
  const message = projection.messages.find((m) => m.role === 'user');
  if (!message) return '';
  const text = message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .trim();
  // 只取首行，且 chat 引用块折叠成 @标题：引用块原文不得污染标题，
  // 否则带换行的标题会反过来破坏 chat 引用行的单行格式
  const firstLine = mentionDisplayText(text).split('\n')[0].trim();
  return (firstLine || '[image]').slice(0, 40);
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
        if (!projectResult.accepted) return null;
        const conversationResult = await window.electronAPI.sourceAuthority.selectConversation({
          requestId: crypto.randomUUID(),
          conversationId: conversation.conversationId,
          version: conversation.version,
        });
        return conversationResult.accepted
          ? { project: projectResult.value, conversation: conversationResult.value }
          : null;
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
                const keepBody =
                  event.partial === true || isMessageCacheHot(id, viewed, lastViewedAt, now);
                const next = applyAgentEvent(conversation, id, event);
                conversations[id] = {
                  ...conversation,
                  ...next,
                  ...(keepBody ? {} : { messages: [], customEntries: [] }),
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
              if (partial || !conversation.started) continue;
              conversations[id] = conversation.sessionFile
                ? {
                    ...conversation,
                    started: false,
                    status: 'idle',
                    error: undefined,
                    pendingCapabilityAsks: [],
                    activeOauthAsk: undefined,
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

        const identity = event.type === 'capability-invoke' ? event.child : event.identity;
        const id = identity.sessionId;

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
              sessionFile: event.sessionFile,
              ...(event.contextWindow !== undefined ? { contextWindow: event.contextWindow } : {}),
            });
          });
          return;
        }

        set((state) => {
          const conversation = state.conversations[id];
          if (!conversation) return state;
          if (
            isBulkyAgentEvent(event.type) &&
            !isMessageCacheHot(id, viewedFromState(state), lastViewedAt, Date.now())
          ) {
            return state;
          }
          const next = applyAgentEvent(conversation, id, event);
          // dev：首个 worker 事件即 spawn 完成信号，即使投影未变也要清 spawning（resume loading 依赖它）
          if (next === conversation && !conversation.spawning) return state;
          // 桌面建的会话在 spawn 时就有标题；空标题只会出现在手机建的会话上，
          // 用它的首条用户消息补一个，否则侧边栏永远显示「新对话」
          const title = conversation.title || firstUserText(next) || '';
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
          flushQueue(id);
          continueGoal(id);
        }
      });

      /** goal 续跑:轮次收束且空闲、无排队消息/挂起项时,自动注入一条继续指令(带安全限制) */
      function continueGoal(id: string): void {
        const conversation = get().conversations[id];
        const goal = conversation?.goal;
        if (!conversation?.started || conversation.status !== 'idle') return;
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
        set((state) =>
          patch(state, id, {
            messages: [
              ...state.conversations[id].messages,
              {
                role: 'user',
                content: [{ type: 'text' as const, text }],
                timestamp: Date.now(),
                optimistic: true,
              },
            ],
          })
        );
        void window.electronAPI.agent.prompt(id, text, undefined);
      }
      /** 逐条投递排队消息:每次轮次收束只发队首一条(每条获得完整一轮),下轮结束再发下一条 */
      function flushQueue(id: string): void {
        const conversation = get().conversations[id];
        if (!conversation?.started || conversation.status !== 'idle') return;
        const [next, ...rest] = conversation.queuedMessages ?? [];
        if (!next) return;
        if (
          (conversation.pendingApprovals ?? []).length > 0 ||
          (conversation.pendingAsks ?? []).length > 0 ||
          (conversation.pendingCapabilityAsks ?? []).length > 0
        ) {
          return;
        }
        set((state) =>
          patch(state, id, {
            queuedMessages: rest,
            messages: [
              ...state.conversations[id].messages,
              {
                role: 'user',
                content: [
                  ...(next.text ? [{ type: 'text' as const, text: next.text }] : []),
                  ...(next.images ?? []).map((image) => ({ type: 'image' as const, ...image })),
                ],
                timestamp: Date.now(),
                optimistic: true,
              },
            ],
          })
        );
        void window.electronAPI.agent.prompt(id, next.text, next.images);
      }

      return {
        conversations: {},
        order: [],
        activeId: null,
        pendingAgentPrefill: undefined,
        worktreeStatuses: {},

        async moveConversationToWorktree(id) {
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
            if (!fresh) {
              const clean = await window.electronAPI.worktree.repoClean(conversation.projectId);
              if (!clean.ok) return clean.error;
              if (!clean.value) {
                return 'main working tree has uncommitted changes — commit or stash them first';
              }
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
          set((state) =>
            patch(state, id, {
              worktree: rebuilt.value,
              worktreeMissing: undefined,
              // 重建可能落在新路径，同样需要告知 agent
              pendingWorkspaceNote: workspaceMigratedNote(rebuilt.value.path),
            })
          );
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
          const targets = Object.values(get().conversations).filter(
            (conversation) => conversation.worktree
          );
          const entries = await Promise.all(
            targets.map(async (conversation) => {
              const status = await window.electronAPI.worktree.status(conversation.id);
              return status.ok ? ([conversation.id, status.value] as const) : null;
            })
          );
          set({
            worktreeStatuses: Object.fromEntries(
              entries.filter((entry): entry is [string, WorktreeStatus] => entry !== null)
            ),
          });
        },

        async newConversation(projectId) {
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
          const existing = get().order.find((id) => {
            const conversation = get().conversations[id];
            return (
              activeConversationIds.has(id) &&
              conversation.projectId === projectId &&
              !conversation.started &&
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
          });
          if (!created.accepted) return null;
          const id = created.value.conversationId;
          const pendingAgentPrefill = get().pendingAgentPrefill;
          // 新会话应用默认预设；'default'（内置全局）或预设已删除时不写，spawn 时自然回落全局
          const { defaultPresetId, presets, defaultReasoningEnabled, defaultThinkingLevel } =
            useSettingsStore.getState();
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
            reasoningEnabled: defaultReasoningEnabled ?? true,
            thinkingLevel: defaultThinkingLevel ?? 'medium',
            ...defaultPreset,
            ...(pendingAgentPrefill ? { prefillAgentTypeKey: pendingAgentPrefill } : {}),
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
          set((state) => {
            const conversation = state.conversations[id];
            if (!conversation || conversation.title === next) return state;
            return patch(state, id, { title: next });
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

        removeConversation(id) {
          const conversation = get().conversations[id];
          if (!conversation) return;
          // 隔离会话连带清理 worktree（拦截确认在 UI 层；分支保留）
          if (conversation.worktree) {
            void window.electronAPI.worktree.remove(id);
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
            void window.electronAPI.sourceAuthority.read().then(async (projection) => {
              const authority = projection.conversations.find(
                (candidate) => candidate.conversationId === id && candidate.lifecycle !== 'ended'
              );
              if (!authority) return;
              const ended = await window.electronAPI.sourceAuthority.endConversation({
                requestId: crypto.randomUUID(),
                conversationId: id,
                version: authority.version,
              });
              if (!ended.accepted) return;
              await window.electronAPI.sourceAuthority.removeConversation({
                requestId: crypto.randomUUID(),
                conversationId: id,
                version: ended.value.version,
              });
            });
          }
          set((state) => {
            const conversations = { ...state.conversations };
            for (const coworkerId of conversation.coworkerIds ?? []) {
              delete conversations[coworkerId];
            }
            delete conversations[id];
            const order = state.order.filter((entry) => entry !== id);
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
          if (!parentId || !parent || parent.parentId) {
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

        prefillAgent(typeKey) {
          const parentId = get().activeId;
          if (parentId && get().conversations[parentId]) {
            set((state) => ({
              pendingAgentPrefill: undefined,
              conversations: patch(state, parentId, {
                activeTabId: undefined,
                prefillAgentTypeKey: typeKey,
              }).conversations,
            }));
            return;
          }
          set({ pendingAgentPrefill: typeKey });
          const project = useSettingsStore.getState().projects[0];
          if (project) void get().newConversation(project.id);
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
          const activeId = get().activeId;
          if (!activeId) return 'no conversation';
          const activeTab = get().conversations[activeId]?.activeTabId;
          const id = activeTab && get().conversations[activeTab] ? activeTab : activeId;
          const conversation = get().conversations[id];
          // 只读回放的已结束实例：必须在乐观回显之前拦，否则会往只读历史里插一条
          // 根本没发出去的用户消息。
          if (conversation?.historyOnly) {
            return 'this Agent instance has ended — its history is read-only';
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
          const workspaceNote = conversation.pendingWorkspaceNote;
          if (workspaceNote && !(conversation.started && conversation.status === 'running')) {
            text = `${workspaceNote}\n\n${text}`;
            set((state) => patch(state, id, { pendingWorkspaceNote: undefined }));
          }
          // agent 干活时消息进队列(不打断);轮次结束自动投递,队列区可编辑/删除/立即发送
          if (conversation.started && conversation.status === 'running') {
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
          set((state) =>
            patch(state, id, {
              // 用户主动发新消息：上一次停止的抑制标记到此失效
              abortRequested: false,
              messages: [
                ...state.conversations[id].messages,
                {
                  role: 'user',
                  content: [
                    ...(text ? [{ type: 'text' as const, text }] : []),
                    ...(images ?? []).map((image) => ({ type: 'image' as const, ...image })),
                  ],
                  timestamp: Date.now(),
                  optimistic: true,
                },
              ],
            })
          );
          if (!conversation.started) {
            // coworker 由 worker 侧创建/恢复,永不走 spawn 分支
            if (conversation.parentId) {
              return 'coworker not restored yet — resume the conversation first';
            }
            set((state) =>
              patch(state, id, {
                spawning: true,
                title:
                  conversation.title ||
                  spawnTitle ||
                  // chat 引用块折叠成 @标题，与 firstUserText 同规则
                  (mentionDisplayText(text).split('\n')[0].trim() || '[image]').slice(0, 40),
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
              set((state) =>
                patch(state, id, { spawning: false, status: 'failed', error: result.error })
              );
              return result.error ?? 'spawn failed';
            }
            set((state) =>
              patch(state, id, {
                spawning: false,
                started: true,
                lastProviderId: target.providerId,
                lastModelId: target.modelId,
              })
            );
          }
          const action =
            get().conversations[id]?.status === 'running'
              ? window.electronAPI.agent.steer(id, text, images)
              : window.electronAPI.agent.prompt(id, text, images);
          const result = await action;
          return result.ok ? null : (result.error ?? 'send failed');
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
                  lastProviderId: providerId,
                  lastModelId: modelId,
                })
              : patch(state, id, { spawning: false, status: 'failed', error: result.error })
          );
          // child 的级联恢复在 Main 侧：parent-ready 后 Main 按自己读的持久化恢复
          // 未 ended 的 child（渲染层不传路径、不指定身份），tab 由事件回流重建。
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
          set((state) => patch(state, id, { approvalMode: mode }));
          const conversation = get().conversations[id];
          if (conversation?.started) {
            void window.electronAPI.agent.setApprovalMode(id, mode);
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
          if (!conversation || !text.trim()) return;
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
            set((state) =>
              patch(state, conversationId, {
                messages: [
                  ...state.conversations[conversationId].messages,
                  {
                    role: 'user',
                    content: [{ type: 'text' as const, text: kickoff }],
                    timestamp: Date.now(),
                    optimistic: true,
                  },
                ],
              })
            );
            void window.electronAPI.agent.prompt(conversationId, kickoff, undefined);
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
            set((state) =>
              patch(state, conversationId, {
                messages: [
                  ...state.conversations[conversationId].messages,
                  {
                    role: 'user',
                    content: [{ type: 'text' as const, text }],
                    timestamp: Date.now(),
                  },
                ],
              })
            );
            void window.electronAPI.agent.prompt(conversationId, text, undefined);
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

        rewind(conversationId, userIndexFromEnd, restoreFiles) {
          const conversation = get().conversations[conversationId];
          if (!conversation?.started || conversation.status !== 'idle') return;
          void window.electronAPI.agent.rewind(conversationId, userIndexFromEnd, restoreFiles);
        },

        retry(conversationId) {
          const conversation = get().conversations[conversationId];
          if (
            !conversation?.started ||
            conversation.spawning ||
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
          if (!conversation || !item) return;
          const running = conversation.status === 'running';
          // 出队并乐观回显。optimistic 标记使其浮在权威消息之后：running 时 steer
          // 要到下一个循环边界才送达，期间当前轮的 assistant upsert 若按裸 index
          // 覆盖会把回显顶掉（消息凭空消失，轮次结束后又出现）。
          set((state) =>
            patch(state, conversationId, {
              queuedMessages: (state.conversations[conversationId]?.queuedMessages ?? []).filter(
                (message) => message.id !== messageId
              ),
              messages: [
                ...state.conversations[conversationId].messages,
                {
                  role: 'user',
                  content: [
                    ...(item.text ? [{ type: 'text' as const, text: item.text }] : []),
                    ...(item.images ?? []).map((image) => ({ type: 'image' as const, ...image })),
                  ],
                  timestamp: Date.now(),
                  optimistic: true,
                },
              ],
            })
          );
          if (running) {
            // steer 插入当前轮
            void window.electronAPI.agent.steer(conversationId, item.text, item.images);
          } else {
            void window.electronAPI.agent.prompt(conversationId, item.text, item.images);
          }
        },

        async interruptAndSendQueued(conversationId, messageId) {
          const conversation = get().conversations[conversationId];
          const item = conversation?.queuedMessages?.find((message) => message.id === messageId);
          if (!conversation?.started || !item) return;
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
          if (!get().conversations[conversationId]?.started) return;
          set((state) =>
            patch(state, conversationId, {
              queuedMessages: (state.conversations[conversationId]?.queuedMessages ?? []).filter(
                (message) => message.id !== messageId
              ),
              messages: [
                ...state.conversations[conversationId].messages,
                {
                  role: 'user',
                  content: [
                    ...(item.text ? [{ type: 'text' as const, text: item.text }] : []),
                    ...(item.images ?? []).map((image) => ({ type: 'image' as const, ...image })),
                  ],
                  timestamp: Date.now(),
                  optimistic: true,
                },
              ],
            })
          );
          void window.electronAPI.agent.prompt(conversationId, item.text, item.images);
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
      storage: createJSONStorage(() => electronStorage),
      // 只存元数据：messages 由 worker snapshot 补回（刷新场景）；app 重启后拿不回则标结束
      partialize: (state) => ({
        conversations: Object.fromEntries(
          Object.entries(state.conversations).map(([id, conversation]) => [
            id,
            {
              ...conversation,
              // 剥离 messages 前留下活跃时刻标量，重启后侧栏排序用（pinned.ts lastActiveAt）
              lastActiveAt:
                conversation.messages.at(-1)?.timestamp ??
                conversation.lastActiveAt ??
                conversation.createdAt,
              messages: [],
              customEntries: [],
              dispatchMainEvents: {},
              generation: undefined,
              lastSeq: 0,
              spawning: false,
              error: undefined,
              // started 是「worker 里这个会话还活着」的运行态。worker 随 app 一起重启，
              // 持久化它会让重启后 ChatView 的 `!started` 自动恢复门永假：会话点开空白、
              // 无 loading 无报错，且再也不会重试（打包版 worker 延后启动时必现）。
              // status 同理：把 running 写盘会让重启后的会话锁 composer 装忙；
              // 有 sessionFile 的降为 idle 等回放，无 sessionFile 的无从回放，直接落终态。
              ...(conversation.started && !conversation.sessionFile
                ? { status: 'failed' as const, error: 'Session ended — history not restored' }
                : { status: 'idle' as const }),
              started: false,
              runStartedAt: undefined,
              lastOutputAt: undefined,
              // 运行态字段不持久化：重启后由 worker snapshot 重建，避免 rehydrate 先摆出陈旧状态
              pendingApprovals: [],
              pendingAsks: [],
              pendingCapabilityAsks: [],
              activeOauthAsk: undefined,
              historyOnly: undefined,
              historyLoadAttempted: undefined,
              backgroundTasks: [],
              subagents: [],
              activeTabId: undefined,
              draftText: undefined,
              prefillAgentTypeKey: undefined,
              // resume 时重新校验，不持久化陈旧的丢失/迁移标记
              worktreeMissing: undefined,
              workspaceMigrating: undefined,
              abortRequested: undefined,
            },
          ])
        ),
        order: state.order,
        activeId: state.activeId,
      }),
      onRehydrateStorage: () => () => {
        // 刷新时 worker 仍活着：只补当前正在看的会话正文。其它会话点开再 snapshot。
        const state = useSessionsStore.getState();
        const viewed = viewedFromState(state);
        if (viewed) void window.electronAPI.agent.requestSnapshot(viewed);
      },
    }
  )
);

// 上报「当前正在查看的会话」给 main：窗口聚焦时,只有正被查看的会话才抑制系统通知。
// tab 生效时以 tab（coworker/子会话）为准,与 sendActive 等处的解析口径一致。
let lastReportedViewedId: string | null = null;
useSessionsStore.subscribe((state) => {
  const viewed = viewedFromState(state);
  if (viewed === lastReportedViewedId) return;
  lastReportedViewedId = viewed;
  window.electronAPI.agent.setViewedSession?.(viewed);
  if (viewed) lastViewedAt[viewed] = Date.now();
  const conversation = viewed ? state.conversations[viewed] : undefined;
  if (
    viewed &&
    conversation &&
    (conversation.started || conversation.sessionFile) &&
    conversation.messages.length === 0 &&
    !conversation.spawning
  ) {
    void window.electronAPI.agent.requestSnapshot(viewed);
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
