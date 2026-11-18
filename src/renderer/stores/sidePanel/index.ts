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
export type PinnableSidePanelTab =
  | 'terminal'
  | 'changes'
  | 'files'
  | 'browser'
  | 'btw'
  | 'workflow'
  | `plugin:${string}:${string}`;

export type SidePanelUi = { open: boolean; width: number };

interface SidePanelState {
  /** 铺满中间工作区;不 persist,关面板 / 切到关着的会话时清掉 */
  fullscreen: boolean;
  /** 各会话自己的全屏记忆；全局 fullscreen 只反映当前会话，避免秘书的全屏盖住别的会话 */
  fullscreenByConversation: Record<string, boolean>;
  /**
   * 最近一次手动调整的宽度，仅作为尚无面板设置的会话的初始值，随会话偏好一起保存。
   */
  lastWidth: number;
  uiByConversation: Record<string, SidePanelUi>;
  /** 可见的原生 guest 矩形（运行态，不持久化）：壁纸按这些矩形挖孔给垫底的 view 透出 */
  browserHoles: Record<string, ScreenRect>;
  /** conversationId -> dockview 序列化布局(分屏结构 + tab 集合) */
  layouts: Record<string, SerializedDockview | undefined>;
  /** 新会话打开侧栏时自动创建的面板类型 */
  pinnedTabs: PinnableSidePanelTab[];
  changesModeByConversation: Record<string, ChangesMode>;
  /**
   * Changes「Session」模式的编辑前全文，按会话惰性从主进程回读（运行态，不 persist）。
   * 会话键不存在 = 尚未加载；已加载但无快照为 `{}`。
   */
  snapshotsByConversation: Record<string, SessionChangeSnapshots>;
  toggleOpen: () => void;
  ensureOpen: (conversationId?: string) => void;
  /**
   * 当前会话换了之后调用：把全局 fullscreen 换成这个会话自己记住的，
   * 免得秘书会话的全屏层继续盖住别的会话、点「打开侧栏」没有可见变化。
   */
  reconcileForActiveConversation: () => void;
  nudgeWidth: (delta: number, workspaceWidth: number, handleWidth: number) => void;
  toggleFullscreen: () => void;
  setFullscreen: (fullscreen: boolean) => void;
  togglePinnedTab: (tab: PinnableSidePanelTab) => void;
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

function rememberFullscreen(
  state: SidePanelState,
  id: string,
  fullscreen: boolean
): Record<string, boolean> {
  return { ...state.fullscreenByConversation, [id]: fullscreen };
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
      fullscreenByConversation: {},
      lastWidth: SIDE_PANEL_DEFAULT_WIDTH,
      uiByConversation: {},
      browserHoles: {},
      layouts: {},
      pinnedTabs: [],
      changesModeByConversation: {},
      snapshotsByConversation: {},

      toggleOpen: () => {
        const id = activeConversationId();
        if (!id) return;
        const open = !uiFor(get(), id).open;
        set({
          uiByConversation: patchUi(get(), id, { open }),
          fullscreen: open ? get().fullscreen : false,
          fullscreenByConversation: rememberFullscreen(get(), id, open ? get().fullscreen : false),
        });
      },

      reconcileForActiveConversation: () => {
        const id = activeConversationId();
        const fullscreen = id ? (get().fullscreenByConversation[id] ?? false) : false;
        if (fullscreen !== get().fullscreen) set({ fullscreen });
      },

      ensureOpen: (conversationId) => {
        const id = conversationId ?? activeConversationId();
        if (!id || uiFor(get(), id).open) return;
        set({ uiByConversation: patchUi(get(), id, { open: true }) });
      },

      nudgeWidth: (delta, workspaceWidth, handleWidth) => {
        const id = activeConversationId();
        if (!id) return;
        const width = resizeSidePanelWidth(
          uiFor(get(), id).width,
          delta,
          workspaceWidth,
          handleWidth
        );
        set({ uiByConversation: patchUi(get(), id, { width }), lastWidth: width });
      },

      toggleFullscreen: () => {
        const id = activeConversationId();
        if (!id) return;
        const { fullscreen } = get();
        if (!uiFor(get(), id).open) {
          set({
            uiByConversation: patchUi(get(), id, { open: true }),
            fullscreen: true,
            fullscreenByConversation: rememberFullscreen(get(), id, true),
          });
          return;
        }
        set({
          fullscreen: !fullscreen,
          fullscreenByConversation: rememberFullscreen(get(), id, !fullscreen),
        });
      },

      setFullscreen: (fullscreen) => {
        const id = activeConversationId();
        if (fullscreen && id) {
          set({
            fullscreen: true,
            uiByConversation: patchUi(get(), id, { open: true }),
            fullscreenByConversation: rememberFullscreen(get(), id, true),
          });
          return;
        }
        set({
          fullscreen,
          ...(id ? { fullscreenByConversation: rememberFullscreen(get(), id, fullscreen) } : {}),
        });
      },

      togglePinnedTab: (tab) => {
        const current = get().pinnedTabs;
        const pinnedTabs = Array.isArray(current) ? current : [];
        set({
          pinnedTabs: pinnedTabs.includes(tab)
            ? pinnedTabs.filter((item) => item !== tab)
            : [...pinnedTabs, tab],
        });
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
        const { [conversationId]: _fullscreen, ...fullscreenByConversation } =
          get().fullscreenByConversation;
        const { [conversationId]: _mode, ...changesModeByConversation } =
          get().changesModeByConversation;
        const { [conversationId]: _snap, ...snapshotsByConversation } =
          get().snapshotsByConversation;
        set({
          layouts,
          uiByConversation,
          fullscreenByConversation,
          changesModeByConversation,
          snapshotsByConversation,
        });
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
        fullscreenByConversation: state.fullscreenByConversation,
        layouts: state.layouts,
        pinnedTabs: state.pinnedTabs,
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

/**
 * 全屏记忆会持久化，全局 fullscreen 不会。启动时当前会话不会再发一次切换，
 * 所以要在挂载、读回本地状态、以及之后的切换时把记忆补到全局 fullscreen 上。
 */
export function bindSidePanelFullscreen(): () => void {
  const reconcile = () => useSidePanelStore.getState().reconcileForActiveConversation();
  reconcile();
  const unsubHydrate = useSidePanelStore.persist?.onFinishHydration(reconcile);
  const unsubSessions = useSessionsStore.subscribe((state, prev) => {
    if (state.activeId !== prev.activeId) reconcile();
  });
  return () => {
    unsubHydrate?.();
    unsubSessions();
  };
}
