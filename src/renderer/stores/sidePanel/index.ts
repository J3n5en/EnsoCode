import type { SidePanelTab, SidePanelTabKind } from '@shared/types/sidePanel';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { releaseTerminal } from '@/lib/terminalRegistry';
import type { SidePanelLayout } from './reducer';
import * as reducer from './reducer';

interface SidePanelState extends SidePanelLayout {
  open: boolean;
  addTab: (conversationId: string, kind: SidePanelTabKind, title: string) => void;
  closeTab: (conversationId: string, tabId: string) => void;
  selectTab: (conversationId: string, tabId: string) => void;
  moveTab: (conversationId: string, activeId: string, overId: string) => void;
  toggleOpen: () => void;
}

/** tab 布局持久化(kind/title/顺序);pty 与 xterm buffer 不持久化,重启后终端 tab 重开 shell */
export const useSidePanelStore = create<SidePanelState>()(
  persist(
    (set, get) => ({
      ...reducer.emptyLayout(),
      open: false,

      addTab: (conversationId, kind, title) => {
        const tab: SidePanelTab = { id: crypto.randomUUID(), kind, title };
        set(reducer.addTab(get(), conversationId, tab));
      },

      closeTab: (conversationId, tabId) => {
        const tab = get().tabs[conversationId]?.find((t) => t.id === tabId);
        if (tab?.kind === 'terminal') {
          releaseTerminal(tabId);
          void window.electronAPI.terminal.dispose(tabId);
        }
        set(reducer.closeTab(get(), conversationId, tabId));
      },

      selectTab: (conversationId, tabId) => {
        set(reducer.selectTab(get(), conversationId, tabId));
      },

      moveTab: (conversationId, activeId, overId) => {
        set(reducer.moveTab(get(), conversationId, activeId, overId));
      },

      toggleOpen: () => set({ open: !get().open }),
    }),
    {
      name: 'enso-side-panel',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ tabs: state.tabs, active: state.active, open: state.open }),
    }
  )
);
