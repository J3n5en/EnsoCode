import type { SecretaryState } from '@shared/types/secretary';
import { create } from 'zustand';

/**
 * 秘书状态 store：Main 是唯一真相，聊天卡片与之后的工作台读同一份推送。
 * renderer 只额外记「哪些提案正在提交」，按钮据此禁用。
 */
export const EMPTY_SECRETARY_STATE: SecretaryState = {
  enabled: false,
  projectId: null,
  profile: null,
  persona: '',
  board: { needsYou: [], running: [], done: [], todos: [] },
  proposals: {},
};

interface SecretaryStoreState {
  secretary: SecretaryState;
  resolving: Record<string, true>;
  /** 未完成初次设置时主区域显示欢迎页（页面本身由设置流程提供） */
  welcomeOpen: boolean;
  bind: () => () => void;
  openWelcome: () => void;
  closeWelcome: () => void;
  resolveProposal: (proposalId: string, action: 'confirm' | 'reject') => Promise<void>;
}

export const useSecretaryStore = create<SecretaryStoreState>()((set, get) => ({
  secretary: EMPTY_SECRETARY_STATE,
  resolving: {},
  welcomeOpen: false,

  openWelcome: () => set({ welcomeOpen: true }),
  closeWelcome: () => set({ welcomeOpen: false }),

  bind: () => {
    let pushed = false;
    const off = window.electronAPI.secretary.onStateChanged((secretary) => {
      pushed = true;
      // 设置完成后欢迎页自动让位给会话
      set((state) => ({ secretary, welcomeOpen: secretary.profile ? false : state.welcomeOpen }));
    });
    void window.electronAPI.secretary
      .getState()
      // 推送比首帧快时以推送为准，否则旧快照会盖掉刚确认的提案
      .then((secretary) => {
        if (!pushed) set({ secretary });
      })
      .catch(() => undefined);
    return off;
  },

  resolveProposal: async (proposalId, action) => {
    set({ resolving: { ...get().resolving, [proposalId]: true } });
    try {
      // 结果不在这里落：Main 写完提案状态后推送，卡片跟着推送走
      await window.electronAPI.secretary.resolveProposal(proposalId, action);
    } catch {
      // 抛错时 Main 没改状态，清掉在途标记让用户能重试
    } finally {
      const resolving = { ...get().resolving };
      delete resolving[proposalId];
      set({ resolving });
    }
  },
}));
