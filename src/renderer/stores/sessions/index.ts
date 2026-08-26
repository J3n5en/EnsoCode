import type { ApprovalMode, AttachedImage, ThinkingLevel } from '@shared/types/agent';

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

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { useSettingsStore } from '@/stores/settings';
import { electronStorage } from '@/stores/settings/storage';
import { applyAgentEvent, emptyProjection, type SessionProjection } from './reducer';

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
  /** 父会话专有：在编 coworker id 列表（驱动 tab 条） */
  coworkerIds?: string[];
  /** 父会话专有：当前 tab（undefined = 主会话） */
  activeTabId?: string;
  /** 排队待发消息(running 时用户消息先入队) */
  queuedMessages?: QueuedMessage[];
  /** 会话目标(设定后空闲自动续跑) */
  goal?: SessionGoal;
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

  newConversation(projectId: string): string;
  selectConversation(id: string): void;
  removeConversation(id: string): void;
  send(text: string, target: SendTarget, images?: AttachedImage[]): Promise<string | null>;
  /** app 重启后从 jsonl 恢复会话并回放历史（未 started 且有 sessionFile 时有效） */
  resumeConversation(id: string): Promise<void>;
  /** 登记一条从外部应用导入的对话（选中后自动 resume 回放） */
  addImportedConversation(
    projectId: string,
    imported: { sessionFile: string; title: string }
  ): string;
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
  /** 设定会话目标并立即开跑 */
  setGoal(conversationId: string, text: string): void;
  /** 暂停/继续/清除目标 */
  pauseGoal(conversationId: string): void;
  resumeGoal(conversationId: string): void;
  clearGoal(conversationId: string): void;
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
          // 刷新后的补投影：worker 还活着的会话恢复消息与状态；
          // 已 spawn 但 worker 不认识的（app 全量重启过）：有 jsonl 的转为可 resume，
          // 没有的（老数据）标为已结束。
          // partial=true 是 resume 的单会话回放，不能据此判定未涉及会话的死活。
          set((state) => {
            const alive = new Map(event.sessions.map((s) => [s.sessionId, s]));
            const partial = event.partial === true;
            const conversations = { ...state.conversations };
            // persist 丢失时按 worker 快照重建 coworker 并挂回父(worker 是父子关系的权威)
            for (const [sid, snapshot] of alive) {
              const parentId = snapshot.parentSessionId;
              if (conversations[sid] || !parentId || !conversations[parentId]) continue;
              const parent = conversations[parentId];
              conversations[sid] = {
                ...emptyProjection,
                id: sid,
                projectId: parent.projectId,
                parentId,
                coworkerName: snapshot.coworkerName,
                title: snapshot.coworkerName ?? 'coworker',
                started: true,
                spawning: false,
                createdAt: Date.now(),
              };
              conversations[parentId] = {
                ...parent,
                coworkerIds: [...(parent.coworkerIds ?? []), sid],
              };
            }
            for (const id of Object.keys(conversations)) {
              const conversation = conversations[id];
              const snapshot = alive.get(id);
              if (snapshot) {
                // worker 确认存活（含 resume 回放）：无条件采纳消息并标 started，避免与
                // spawn 的 IPC 返回竞态时因 started 尚未置位而丢弃回放
                conversations[id] = {
                  ...conversation,
                  started: true,
                  spawning: false,
                  status: snapshot.status,
                  messages: snapshot.messages,
                  commands: snapshot.commands,
                  pendingApprovals: snapshot.pendingApprovals ?? [],
                  lastSeq: 0,
                  error: undefined,
                };
                continue;
              }
              // 增量快照不涉及的会话保持原样
              if (partial || !conversation.started) continue;
              conversations[id] = conversation.sessionFile
                ? { ...conversation, started: false, status: 'idle', error: undefined }
                : {
                    ...conversation,
                    status: 'failed',
                    error: 'Session ended — history not restored',
                  };
            }
            return { conversations };
          });
          return;
        }
        if (event.type === 'goal-signal') {
          set((state) => {
            const conversation = state.conversations[event.sessionId];
            if (!conversation?.goal) return state;
            const status =
              event.kind === 'complete'
                ? ('completed' as const)
                : event.kind === 'blocked'
                  ? ('blocked' as const)
                  : ('waiting' as const);
            return patch(state, event.sessionId, {
              goal: { ...conversation.goal, status, note: event.note },
            });
          });
          return;
        }
        if (event.type === 'coworker-update') {
          set((state) => {
            const parent = state.conversations[event.sessionId];
            if (!parent) return state;
            const cw = event.coworker;
            const conversations = { ...state.conversations };
            if (cw.status === 'dismissed') {
              delete conversations[cw.id];
              conversations[event.sessionId] = {
                ...parent,
                coworkerIds: (parent.coworkerIds ?? []).filter((x) => x !== cw.id),
                activeTabId: parent.activeTabId === cw.id ? undefined : parent.activeTabId,
              };
              return { conversations };
            }
            const existing = conversations[cw.id];
            conversations[cw.id] = existing
              ? {
                  ...existing,
                  started: true,
                  spawning: false,
                  sessionFile: cw.sessionFile ?? existing.sessionFile,
                  ...(cw.agentType ? { agentType: cw.agentType } : {}),
                }
              : {
                  ...emptyProjection,
                  id: cw.id,
                  projectId: parent.projectId,
                  parentId: event.sessionId,
                  coworkerName: cw.name,
                  ...(cw.agentType ? { agentType: cw.agentType } : {}),
                  title: cw.name,
                  started: true,
                  spawning: false,
                  createdAt: cw.createdAt,
                  ...(cw.sessionFile ? { sessionFile: cw.sessionFile } : {}),
                  ...(cw.modelId ? { lastModelId: cw.modelId } : {}),
                };
            if (!(parent.coworkerIds ?? []).includes(cw.id)) {
              conversations[event.sessionId] = {
                ...parent,
                coworkerIds: [...(parent.coworkerIds ?? []), cw.id],
              };
            }
            return { conversations };
          });
          return;
        }
        if (event.type === 'session-meta') {
          set((state) =>
            state.conversations[event.sessionId]
              ? patch(state, event.sessionId, { sessionFile: event.sessionFile })
              : state
          );
          return;
        }
        if (!('sessionId' in event)) return;
        const id = event.sessionId;
        set((state) => {
          const conversation = state.conversations[id];
          if (!conversation) return state;
          const next = applyAgentEvent(conversation, id, event);
          if (next === conversation && !conversation.spawning) return state;
          // 该会话的首个 worker 事件即 spawn 完成信号，清掉 spawning（resume 的 loading 依赖它）
          return patch(state, id, { ...next, spawning: false });
        });
        // 轮次收束后投递排队消息(审批/提问挂起时不投,等其解除后的下一次收束)。
        // 只挂 turn-completed 单一触发点:worker 在它之前必先发 status idle,
        // 两者都触发会在 running 事件回来前把下一条也投出去(双触发竞态)
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
        if (!goal || goal.status !== 'active') return;
        if ((conversation.queuedMessages ?? []).length > 0) return;
        if (
          (conversation.pendingApprovals ?? []).length > 0 ||
          (conversation.pendingAsks ?? []).length > 0
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
          (conversation.pendingAsks ?? []).length > 0
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

        newConversation(projectId) {
          // 复用同项目下已存在的空白草稿，避免连点堆一排空行。
          // 注意排除「待 resume 的旧对话」——app 重启后它们 started 也是 false，
          // 但有 sessionFile/标题，不是草稿
          const existing = get().order.find((id) => {
            const conversation = get().conversations[id];
            return (
              conversation.projectId === projectId &&
              !conversation.started &&
              !conversation.sessionFile &&
              conversation.messages.length === 0 &&
              !conversation.title
            );
          });
          if (existing) {
            set({ activeId: existing });
            return existing;
          }
          const id = crypto.randomUUID();
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
          };
          set((state) => ({
            conversations: { ...state.conversations, [id]: conversation },
            order: [id, ...state.order],
            activeId: id,
          }));
          return id;
        },

        selectConversation(id) {
          if (get().conversations[id]) set({ activeId: id });
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

        async send(text, target, images) {
          const activeId = get().activeId;
          if (!activeId) return 'no conversation';
          const activeTab = get().conversations[activeId]?.activeTabId;
          const id = activeTab && get().conversations[activeTab] ? activeTab : activeId;
          const conversation = get().conversations[id];
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
                title: conversation.title || (text || '[image]').slice(0, 40),
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
          // 导入的对话没有历史模型记录，退化到第一个可用 provider/model
          const fallbackProvider = settings.providers.find(
            (p) => p.enabled && p.apiKey && p.models.some((m) => m.enabled !== false)
          );
          // 上次用的 provider 可能已被删除/禁用，校验有效性，失效则回退默认（不报错）
          const lastProvider = settings.providers.find(
            (p) => p.id === conversation.lastProviderId && p.enabled && p.apiKey
          );
          const provider = lastProvider ?? fallbackProvider;
          const providerId = provider?.id;
          const lastModelValid = lastProvider?.models.some(
            (m) => m.id === conversation.lastModelId
          );
          const modelId = lastModelValid
            ? conversation.lastModelId
            : provider?.models.find((m) => m.enabled !== false)?.id;
          if (!providerId || !modelId) return;
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

        addImportedConversation(projectId, imported) {
          const id = crypto.randomUUID();
          const conversation: Conversation = {
            ...emptyProjection,
            id,
            projectId,
            title: imported.title || '[imported]',
            started: false,
            spawning: false,
            createdAt: Date.now(),
            sessionFile: imported.sessionFile,
            reasoningEnabled: true,
            thinkingLevel: 'medium',
          };
          set((state) => ({
            conversations: { ...state.conversations, [id]: conversation },
            order: [id, ...state.order],
            activeId: id,
          }));
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
          set((state) => patch(state, id, { lastProviderId: providerId, lastModelId: modelId }));
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
            const kickoff =
              `<goal-continuation>\nSession goal: ${text.trim()}\n` +
              'Work toward this goal autonomously. When done call goal_complete with evidence; ' +
              'if blocked call goal_blocked; if waiting on something external call goal_wait.\n</goal-continuation>';
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

        sendQueuedNow(conversationId, messageId) {
          const conversation = get().conversations[conversationId];
          const item = conversation?.queuedMessages?.find((message) => message.id === messageId);
          if (!conversation || !item) return;
          set((state) =>
            patch(state, conversationId, {
              queuedMessages: (state.conversations[conversationId]?.queuedMessages ?? []).filter(
                (message) => message.id !== messageId
              ),
            })
          );
          if (conversation.status === 'running') {
            // steer 插入当前轮;消息回显由 worker 的 reconcile 补齐
            void window.electronAPI.agent.steer(conversationId, item.text, item.images);
          } else {
            set((state) =>
              patch(state, conversationId, {
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
              lastSeq: 0,
              spawning: false,
              error: undefined,
              runStartedAt: undefined,
              // 运行态字段不持久化：重启后由 worker snapshot 重建，避免 rehydrate 先摆出陈旧状态
              pendingApprovals: [],
              pendingAsks: [],
              backgroundTasks: [],
              subagents: [],
              activeTabId: undefined,
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
