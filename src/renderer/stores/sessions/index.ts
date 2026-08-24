import { create } from 'zustand';
import { applyAgentEvent, emptyProjection, type SessionProjection } from './reducer';

interface SessionsState extends SessionProjection {
  /** M1 单会话：当前活动会话 id，null 表示尚未开始 */
  sessionId: string | null;
  spawning: boolean;

  start(providerId: string, modelId: string, cwd: string): Promise<string | null>;
  send(text: string): Promise<string | null>;
  abort(): Promise<void>;
}

export const useSessionsStore = create<SessionsState>()((set, get) => {
  window.electronAPI.agent.onEvent((event) => {
    const { sessionId } = get();
    if (!sessionId) return;
    set(applyAgentEvent(get(), sessionId, event));
  });

  return {
    ...emptyProjection,
    sessionId: null,
    spawning: false,

    async start(providerId, modelId, cwd) {
      const sessionId = crypto.randomUUID();
      set({ ...emptyProjection, sessionId, spawning: true });
      const result = await window.electronAPI.agent.spawn({ sessionId, providerId, modelId, cwd });
      set({ spawning: false });
      if (!result.ok) {
        set({ status: 'failed', error: result.error, sessionId: null });
        return result.error ?? 'spawn failed';
      }
      return null;
    },

    async send(text) {
      const { sessionId, status } = get();
      if (!sessionId) return 'no session';
      const result =
        status === 'running'
          ? await window.electronAPI.agent.steer(sessionId, text)
          : await window.electronAPI.agent.prompt(sessionId, text);
      return result.ok ? null : (result.error ?? 'send failed');
    },

    async abort() {
      const { sessionId } = get();
      if (sessionId) await window.electronAPI.agent.abort(sessionId);
    },
  };
});
