import type { SessionChangeSnapshots } from '@shared/types/fileChanges';
import type { SerializedDockview } from 'dockview-react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ScreenRect } from '@/lib/guestViewOcclusion';
import { useSessionsStore } from '@/stores/sessions';
import { SIDE_PANEL_VERSION, splitLegacySnapshots } from './migrate';
import { resizeSidePanelWidth, SIDE_PANEL_DEFAULT_WIDTH } from './width';

export { SIDE_PANEL_DEFAULT_WIDTH, SIDE_PANEL_MIN_WIDTH } from './width';

export type ChangesMode = 'all' | 'git';

export type SidePanelUi = { open: boolean; width: number };

interface SidePanelState {
  /** 铺满中间工作区;不 persist,关面板 / 切到关着的会话时清掉 */
  fullscreen: boolean;
  /**
   * 最近一次手动调整的宽度，仅作为尚无面板设置的会话的初始值，随会话偏好一起保存。
   *
   * Persist the last manually resized width as the initial value for conversations without panel settings.
   */
  lastWidth: number;
  uiByConversation: Record<string, SidePanelUi>;
  /** 可见的原生 guest 矩形（运行态，不持久化）：壁纸按这些矩形挖孔给垫底的 view 透出 */
  browserHoles: Record<string, ScreenRect>;
  /** conversationId -> dockview 序列化布局(分屏结构 + tab 集合) */
  layouts: Record<string, SerializedDockview | undefined>;
  changesModeByConversation: Record<string, ChangesMode>;
  /**
   * Changes「Session」模式的编辑前全文，按会话惰性从主进程回读（运行态，不 persist）。
   * 会话键不存在 = 尚未加载；已加载但无快照为 `{}`。
   */
  snapshotsByConversation: Record<string, SessionChangeSnapshots>;
  toggleOpen: () => void;
  ensureOpen: (conversationId?: string) => void;
  nudgeWidth: (delta: number, workspaceWidth: number) => void;
  toggleFullscreen: () => void;
  setFullscreen: (fullscreen: boolean) => void;
  saveLayout: (conversationId: string, layout: SerializedDockview) => void;
  forgetConversation: (conversationId: string) => void;
  setChangesMode: (conversationId: string, mode: ChangesMode) => void;
  saveSnapshots: (conversationId: string, snapshots: SessionChangeSnapshots) => void;
  loadSnapshots: (conversationId: string) => void;
  setBrowserHole: (key: string, rect: ScreenRect | null) => void;
}

function activeConversationId(): string | undefined {
  return useSessionsStore.getState().activeId ?? undefined;
}

function uiFor(state: SidePanelState, id: string): SidePanelUi {
  return state.uiByConversation[id] ?? { open: false, width: state.lastWidth };
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
      lastWidth: SIDE_PANEL_DEFAULT_WIDTH,
      uiByConversation: {},
      browserHoles: {},
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

      nudgeWidth: (delta, workspaceWidth) => {
        const id = activeConversationId();
        if (!id) return;
        const width = resizeSidePanelWidth(uiFor(get(), id).width, delta, workspaceWidth);
        set({ uiByConversation: patchUi(get(), id, { width }), lastWidth: width });
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

      setBrowserHole: (key, rect) => {
        const { [key]: prev, ...rest } = get().browserHoles;
        if (!rect && !prev) return;
        set({ browserHoles: rect ? { ...rest, [key]: rect } : rest });
      },

      saveLayout: (conversationId, layout) => {
        if (!useSessionsStore.getState().conversations[conversationId]) return;
        set({ layouts: { ...get().layouts, [conversationId]: layout } });
      },

      forgetConversation: (conversationId) => {
        const { [conversationId]: _layout, ...layouts } = get().layouts;
        const { [conversationId]: _ui, ...uiByConversation } = get().uiByConversation;
        const { [conversationId]: _mode, ...changesModeByConversation } =
          get().changesModeByConversation;
        const { [conversationId]: _snap, ...snapshotsByConversation } =
          get().snapshotsByConversation;
        set({ layouts, uiByConversation, changesModeByConversation, snapshotsByConversation });
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
        void window.electronAPI.changes.writeSnapshots({ conversationId, snapshots });
      },

      loadSnapshots: (conversationId) => {
        if (conversationId in get().snapshotsByConversation) return;
        // 读失败也要标记已加载（空），否则 ChangesView 永不聚合；回包前已有 save 则不覆盖
        const apply = (snapshots: SessionChangeSnapshots) => {
          if (conversationId in get().snapshotsByConversation) return;
          set({
            snapshotsByConversation: {
              ...get().snapshotsByConversation,
              [conversationId]: snapshots,
            },
          });
        };
        void window.electronAPI.changes
          .readSnapshots({ conversationId })
          .then(apply, () => apply({}));
      },
    }),
    {
      name: 'enso-side-panel',
      version: SIDE_PANEL_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        lastWidth: state.lastWidth,
        uiByConversation: state.uiByConversation,
        layouts: state.layouts,
        changesModeByConversation: state.changesModeByConversation,
      }),
      migrate: (persisted, version) => {
        const { state, snapshots } = splitLegacySnapshots(persisted, version);
        // 旧版快照一次性迁到磁盘；失败只是丢 old，Session 模式退回 reconstruct
        const changes = window.electronAPI?.changes;
        if (changes) {
          for (const [conversationId, files] of Object.entries(snapshots)) {
            void changes.writeSnapshots({ conversationId, snapshots: files });
          }
        }
        return state as unknown as SidePanelState;
      },
    }
  )
);
