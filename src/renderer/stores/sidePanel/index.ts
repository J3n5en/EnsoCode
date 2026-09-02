import type { SerializedDockview } from 'dockview-react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { useSessionsStore } from '@/stores/sessions';

export type ChangesMode = 'all' | 'git';

export const SIDE_PANEL_DEFAULT_WIDTH = 360;
export const SIDE_PANEL_MIN_WIDTH = 280;
export const SIDE_PANEL_MAX_WIDTH = 800;

export type SidePanelUi = { open: boolean; width: number };

interface SidePanelState {
  /** 铺满中间工作区;不 persist,关面板 / 切到关着的会话时清掉 */
  fullscreen: boolean;
  uiByConversation: Record<string, SidePanelUi>;
  /** 可见的浏览器 guest 数（运行态，不持久化）：>0 时壁纸让出右栏给垫底的原生 view 透出 */
  browserGuests: number;
  /** conversationId -> dockview 序列化布局(分屏结构 + tab 集合) */
  layouts: Record<string, SerializedDockview | undefined>;
  changesModeByConversation: Record<string, ChangesMode>;
  snapshotsByConversation: Record<string, Record<string, string>>;
  toggleOpen: () => void;
  ensureOpen: (conversationId?: string) => void;
  nudgeWidth: (delta: number) => void;
  toggleFullscreen: () => void;
  setFullscreen: (fullscreen: boolean) => void;
  saveLayout: (conversationId: string, layout: SerializedDockview) => void;
  setChangesMode: (conversationId: string, mode: ChangesMode) => void;
  saveSnapshots: (conversationId: string, snapshots: Record<string, string>) => void;
  addBrowserGuest: () => void;
  removeBrowserGuest: () => void;
}

function clampWidth(width: number): number {
  return Math.min(SIDE_PANEL_MAX_WIDTH, Math.max(SIDE_PANEL_MIN_WIDTH, width));
}

function activeConversationId(): string | undefined {
  return useSessionsStore.getState().activeId ?? undefined;
}

function uiFor(state: SidePanelState, id: string): SidePanelUi {
  return state.uiByConversation[id] ?? { open: false, width: SIDE_PANEL_DEFAULT_WIDTH };
}

function patchUi(
  state: SidePanelState,
  id: string,
  patch: Partial<SidePanelUi>
): Record<string, SidePanelUi> {
  return { ...state.uiByConversation, [id]: { ...uiFor(state, id), ...patch } };
}

/** 只持久化布局与各会话开关/宽度;pty/xterm 关 tab 时由 dockview onDidRemovePanel 回收,切会话不杀 */
export const useSidePanelStore = create<SidePanelState>()(
  persist(
    (set, get) => ({
      fullscreen: false,
      uiByConversation: {},
      browserGuests: 0,
      layouts: {},
      changesModeByConversation: {},
      snapshotsByConversation: {},

      toggleOpen: () => {
        const id = activeConversationId();
        if (!id) return;
        const open = !uiFor(get(), id).open;
        set({
          uiByConversation: patchUi(get(), id, { open }),
          fullscreen: open ? get().fullscreen : false,
        });
      },

      ensureOpen: (conversationId) => {
        const id = conversationId ?? activeConversationId();
        if (!id || uiFor(get(), id).open) return;
        set({ uiByConversation: patchUi(get(), id, { open: true }) });
      },

      nudgeWidth: (delta) => {
        const id = activeConversationId();
        if (!id) return;
        const width = clampWidth(uiFor(get(), id).width + delta);
        set({ uiByConversation: patchUi(get(), id, { width }) });
      },

      toggleFullscreen: () => {
        const id = activeConversationId();
        if (!id) return;
        const { fullscreen } = get();
        if (!uiFor(get(), id).open) {
          set({ uiByConversation: patchUi(get(), id, { open: true }), fullscreen: true });
          return;
        }
        set({ fullscreen: !fullscreen });
      },

      setFullscreen: (fullscreen) => {
        const id = activeConversationId();
        if (fullscreen && id) {
          set({ fullscreen: true, uiByConversation: patchUi(get(), id, { open: true }) });
          return;
        }
        set({ fullscreen });
      },

      addBrowserGuest: () => set({ browserGuests: get().browserGuests + 1 }),
      removeBrowserGuest: () => set({ browserGuests: Math.max(0, get().browserGuests - 1) }),

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
      version: 3,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        uiByConversation: state.uiByConversation,
        layouts: state.layouts,
        changesModeByConversation: state.changesModeByConversation,
        snapshotsByConversation: state.snapshotsByConversation,
      }),
      migrate: (persisted, version) => {
        const old = persisted as Partial<SidePanelState> & { open?: boolean };
        if (version < 2) return { uiByConversation: {}, layouts: {} };
        if (version < 3) {
          return {
            uiByConversation: {},
            layouts: old?.layouts ?? {},
            changesModeByConversation: old?.changesModeByConversation ?? {},
            snapshotsByConversation: old?.snapshotsByConversation ?? {},
          };
        }
        return old as SidePanelState;
      },
    }
  )
);
