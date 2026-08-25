import type { AttachedImage, ThinkingLevel } from '@shared/types/agent';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { useSettingsStore } from '@/stores/settings';
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
  abort(): Promise<void>;
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
            for (const id of Object.keys(conversations)) {
              const conversation = conversations[id];
              const snapshot = alive.get(id);
              if (snapshot) {
                // worker 确认存活（含 resume 回放）：无条件采纳消息并标 started，避免与
                // spawn 的 IPC 返回竞态时因 started 尚未置位而丢弃回放
                conversations[id] = {
                  ...conversation,
                  started: true,
                  status: snapshot.status,
                  messages: snapshot.messages,
                  commands: snapshot.commands,
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
          if (next === conversation) return state;
          return patch(state, id, next);
        });
      });

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
          if (conversation.started && conversation.status === 'running') {
            void window.electronAPI.agent.abort(id);
          }
          set((state) => {
            const conversations = { ...state.conversations };
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
          const id = get().activeId;
          if (!id) return 'no conversation';
          const conversation = get().conversations[id];
          if (!conversation.started) {
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
          const providerId = conversation.lastProviderId ?? fallbackProvider?.id;
          const modelId =
            conversation.lastModelId ??
            fallbackProvider?.models.find((m) => m.enabled !== false)?.id;
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
          });
          set((state) =>
            result.ok
              ? patch(state, id, {
                  spawning: false,
                  started: true,
                  lastProviderId: providerId,
                  lastModelId: modelId,
                })
              : patch(state, id, { spawning: false, status: 'failed', error: result.error })
          );
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

        async abort() {
          const id = get().activeId;
          if (id && get().conversations[id]?.started) {
            await window.electronAPI.agent.abort(id);
          }
        },
      };
    },
    {
      name: 'enso-conversations',
      storage: createJSONStorage(() => localStorage),
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
