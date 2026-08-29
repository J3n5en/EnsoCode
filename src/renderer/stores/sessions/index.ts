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
  applyAgentEvent,
  applyDispatchEvent,
  emptyProjection,
  type SessionProjection,
} from './reducer';

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
  /** 排队待发消息(running 时用户消息先入队) */
  queuedMessages?: QueuedMessage[];
  /** 会话目标(设定后空闲自动续跑) */
  goal?: SessionGoal;
  /** 回退后待预填输入框的文本(rewind-done 回流,ChatInput 消费一次) */
  draftText?: string;
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
  /** 无 project 时保留的一次性 summon；下一条普通 draft 消费。 */
  pendingAgentPrefill?: AgentTypeKey;

  newConversation(projectId: string): Promise<string | null>;
  selectConversation(id: string): void;
  removeConversation(id: string): void;
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
  /** 解雇 coworker（删除靠 coworker-update 回流,单一数据流） */
  dismissCoworkerFromUI(parentId: string, coworkerId: string): void;
  /** 手动雇佣 coworker（会话建立靠 coworker-update 回流;主 agent 经 worker 通知感知） */
  hireCoworker(parentId: string, name: string, agentType?: string): Promise<string | null>;
  removeQueuedMessage(conversationId: string, messageId: string): void;
  updateQueuedMessage(conversationId: string, messageId: string, text: string): void;
  /** 立即发送队列中某条(running 时 steer 插入,否则直接 prompt) */
  sendQueuedNow(conversationId: string, messageId: string): void;
  /** 回退到倒数第 N+1 条 user 消息(0 = 最后一条);截断与预填由 worker 事件回流。
   *  restoreFiles 同时还原工作树文件 */
  rewind(conversationId: string, userIndexFromEnd: number, restoreFiles?: boolean): void;
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
  return (text || '[image]').slice(0, 40);
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

            for (const id of Object.keys(conversations)) {
              const conversation = conversations[id];
              const snapshot = alive.get(id);
              if (snapshot) {
                conversations[id] = {
                  ...conversation,
                  ...applyAgentEvent(conversation, id, event),
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
          const next = applyAgentEvent(conversation, id, event);
          // dev：首个 worker 事件即 spawn 完成信号，即使投影未变也要清 spawning（resume loading 依赖它）
          if (next === conversation && !conversation.spawning) return state;
          // 桌面建的会话在 spawn 时就有标题；空标题只会出现在手机建的会话上，
          // 用它的首条用户消息补一个，否则侧边栏永远显示「新对话」
          const title = conversation.title || firstUserText(next) || '';
          return patch(state, id, {
            ...next,
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
          });
        });
        if (event.type === 'turn-completed') {
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
              { role: 'user', content: [{ type: 'text' as const, text }], timestamp: Date.now() },
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
              conversations: pendingAgentPrefill
                ? patch(state, existing, {
                    activeTabId: undefined,
                    prefillAgentTypeKey: pendingAgentPrefill,
                  }).conversations
                : state.conversations,
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
          const conversation: Conversation = {
            ...emptyProjection,
            id,
            projectId,
            title: '',
            started: false,
            spawning: false,
            createdAt: Date.now(),
            reasoningEnabled: true,
            thinkingLevel: 'medium',
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
        },

        selectConversation(id) {
          if (!get().conversations[id]) return;
          const pendingAgentPrefill = get().pendingAgentPrefill;
          set((state) => ({
            activeId: id,
            pendingAgentPrefill: undefined,
            conversations: pendingAgentPrefill
              ? patch(state, id, {
                  activeTabId: undefined,
                  prefillAgentTypeKey: pendingAgentPrefill,
                }).conversations
              : state.conversations,
          }));
          void activateConversationAuthority(id).then((authority) => {
            if (authority || !get().conversations[id]) return;
            set((state) =>
              patch(state, id, {
                error: 'This conversation is history-only and cannot be dispatched.',
              })
            );
          });
        },

        removeConversation(id) {
          const conversation = get().conversations[id];
          if (!conversation) return;
          // 级联解雇 coworker,防 worker 侧孤儿泄漏
          for (const coworkerId of conversation.coworkerIds ?? []) {
            if (conversation.started) {
              void window.electronAPI.agent.dismissCoworker(id, coworkerId);
            }
          }
          if (conversation.started && conversation.status === 'running') {
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
          // 乐观回显：立即上屏，不等 spawn/prompt 往返。worker 会为这条 user 消息
          // 发同 index 的 message-upsert（其 messages.length 与本地一致），自然覆盖对齐；
          // 万一错位由 agent_end 的全量 reconcile 兜底。
          set((state) =>
            patch(state, id, {
              messages: [
                ...state.conversations[id].messages,
                {
                  role: 'user',
                  content: [
                    ...(text ? [{ type: 'text' as const, text }] : []),
                    ...(images ?? []).map((image) => ({ type: 'image' as const, ...image })),
                  ],
                  timestamp: Date.now(),
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
                title: conversation.title || spawnTitle || (text || '[image]').slice(0, 40),
              })
            );
            const result = await window.electronAPI.agent.spawn({
              sessionId: id,
              providerId: target.providerId,
              modelId: target.modelId,
              cwd: target.cwd,
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
          if (!conversation || conversation.started || conversation.spawning) return;
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
          set((state) => patch(state, id, { spawning: true }));
          const result = await window.electronAPI.agent.spawn({
            sessionId: id,
            providerId,
            modelId,
            cwd: project.path,
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
          if (!result.ok) return;
          // 级联恢复 coworker：命令 sessionId 都是父 id,OperationGate 保证排在父 spawn 之后
          for (const coworkerId of conversation.coworkerIds ?? []) {
            const coworker = get().conversations[coworkerId];
            if (!coworker?.sessionFile || coworker.started || coworker.spawning) continue;
            set((state) => patch(state, coworkerId, { spawning: true }));
            void window.electronAPI.agent
              .spawnCoworker(
                id,
                coworkerId,
                coworker.coworkerName ?? coworker.title,
                coworker.agentType,
                coworker.sessionFile
              )
              .then((res) => {
                set((state) =>
                  res.ok
                    ? patch(state, coworkerId, { started: true })
                    : patch(state, coworkerId, {
                        spawning: false,
                        status: 'failed',
                        error: res.error,
                      })
                );
              });
          }
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
          if (get().conversations[id]?.started) {
            await window.electronAPI.agent.abort(id);
          }
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

        dismissCoworkerFromUI(parentId, coworkerId) {
          void window.electronAPI.agent.dismissCoworker(parentId, coworkerId, true);
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

        clearDraft(conversationId) {
          if (get().conversations[conversationId]?.draftText === undefined) return;
          set((state) => patch(state, conversationId, { draftText: undefined }));
        },

        sendQueuedNow(conversationId, messageId) {
          const conversation = get().conversations[conversationId];
          const item = conversation?.queuedMessages?.find((message) => message.id === messageId);
          if (!conversation || !item) return;
          const running = conversation.status === 'running';
          // 出队并乐观回显。与 sendMessage / flushQueue 同一套：worker 会为这条
          // user 消息发同 index 的 message-upsert 覆盖对齐。running 分支此前只出队
          // 不上屏（指望 reconcile 补），一旦没回流用户就看到消息凭空消失。
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

        async hireCoworker(parentId, name, agentType) {
          const parent = get().conversations[parentId];
          if (!parent?.started) return 'conversation not started';
          const slug = name
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 32);
          if (!slug) return 'invalid name';
          const coworkerId = `${parentId}::cw-${slug}`;
          const taken = (parent.coworkerIds ?? []).some(
            (id) => id === coworkerId || get().conversations[id]?.coworkerName === name
          );
          if (taken) return 'name already in use';
          const result = await window.electronAPI.agent.spawnCoworker(
            parentId,
            coworkerId,
            name,
            agentType
          );
          if (!result.ok) return result.error ?? 'hire failed';
          // 会话对象由 coworker-update 回流建立;先切过去,displayed 在此之前回落父会话
          set((state) => patch(state, parentId, { activeTabId: coworkerId }));
          return null;
        },
      };
    },
    {
      name: 'enso-conversations',
      // 存 settings.json（localStorage 按 origin 隔离，dev 与打包版会分家）
      storage: createJSONStorage(() => electronStorage),
      // 只存元数据：messages 由 worker snapshot 补回（刷新场景）；app 重启后拿不回则标结束
      partialize: (state) => ({
        conversations: Object.fromEntries(
          Object.entries(state.conversations).map(([id, conversation]) => [
            id,
            {
              ...conversation,
              messages: [],
              customEntries: [],
              dispatchMainEvents: {},
              generation: undefined,
              lastSeq: 0,
              spawning: false,
              error: undefined,
              runStartedAt: undefined,
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
            },
          ])
        ),
        order: state.order,
        activeId: state.activeId,
      }),
      onRehydrateStorage: () => () => {
        // 刷新时 worker 仍活着：要一份全量投影把消息接回来
        void window.electronAPI.agent.requestSnapshot();
      },
    }
  )
);
