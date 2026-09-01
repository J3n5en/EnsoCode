import type { SerializedDockview } from 'dockview-react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ChangesMode = 'all' | 'git';

interface SidePanelState {
  open: boolean;
  /** conversationId -> dockview 序列化布局(分屏结构 + tab 集合) */
  layouts: Record<string, SerializedDockview | undefined>;
  changesModeByConversation: Record<string, ChangesMode>;
  snapshotsByConversation: Record<string, Record<string, string>>;
  toggleOpen: () => void;
  saveLayout: (conversationId: string, layout: SerializedDockview) => void;
  setChangesMode: (conversationId: string, mode: ChangesMode) => void;
  saveSnapshots: (conversationId: string, snapshots: Record<string, string>) => void;
}

/** 只持久化布局;pty/xterm 关 tab 时由 dockview onDidRemovePanel 回收,切会话不杀 */
export const useSidePanelStore = create<SidePanelState>()(
  persist(
    (set, get) => ({
      open: false,
      layouts: {},
      changesModeByConversation: {},
      snapshotsByConversation: {},

      toggleOpen: () => set({ open: !get().open }),

      saveLayout: (conversationId, layout) => {
        set({ layouts: { ...get().layouts, [conversationId]: layout } });
      },

      setChangesMode: (conversationId, mode) => {
        set({
          changesModeByConversation: { ...get().changesModeByConversation, [conversationId]: mode },
        });
      },

      saveSnapshots: (conversationId, snapshots) => {
        set({
          snapshotsByConversation: {
            ...get().snapshotsByConversation,
            [conversationId]: snapshots,
          },
        });
      },
    }),
    {
      name: 'enso-side-panel',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        open: state.open,
        layouts: state.layouts,
        changesModeByConversation: state.changesModeByConversation,
        snapshotsByConversation: state.snapshotsByConversation,
      }),
      migrate: (persisted, version) => {
        const old = persisted as Partial<SidePanelState> | undefined;
        if (version < 2) return { open: Boolean(old?.open), layouts: {} };
        return old as SidePanelState;
      },
    }
  )
);
