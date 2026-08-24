import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
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
  send(text: string, target: SendTarget): Promise<string | null>;
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
          // 已 spawn 但 worker 不认识的（app 全量重启过）标为已结束
          set((state) => {
            const alive = new Map(event.sessions.map((s) => [s.sessionId, s]));
            const conversations = { ...state.conversations };
            for (const id of Object.keys(conversations)) {
              const conversation = conversations[id];
              if (!conversation.started) continue;
              const snapshot = alive.get(id);
              conversations[id] = snapshot
                ? {
                    ...conversation,
                    status: snapshot.status,
                    messages: snapshot.messages,
                    commands: snapshot.commands,
                    lastSeq: 0,
                    error: undefined,
                  }
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
          // 复用同项目下已存在的空对话，避免连点堆一排空行
          const existing = get().order.find((id) => {
            const conversation = get().conversations[id];
            return conversation.projectId === projectId && !conversation.started;
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

        async send(text, target) {
          const id = get().activeId;
          if (!id) return 'no conversation';
          const conversation = get().conversations[id];
          if (!conversation.started) {
            set((state) => patch(state, id, { spawning: true, title: text.slice(0, 40) }));
            const result = await window.electronAPI.agent.spawn({
              sessionId: id,
              providerId: target.providerId,
              modelId: target.modelId,
              cwd: target.cwd,
            });
            if (!result.ok) {
              set((state) =>
                patch(state, id, { spawning: false, status: 'failed', error: result.error })
              );
              return result.error ?? 'spawn failed';
            }
            set((state) => patch(state, id, { spawning: false, started: true }));
          }
          const action =
            get().conversations[id]?.status === 'running'
              ? window.electronAPI.agent.steer(id, text)
              : window.electronAPI.agent.prompt(id, text);
          const result = await action;
          return result.ok ? null : (result.error ?? 'send failed');
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
            { ...conversation, messages: [], lastSeq: 0, spawning: false, error: undefined },
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
