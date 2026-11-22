import type { SessionChangeSnapshots } from '@shared/types/fileChanges';
import type { SerializedDockview } from 'dockview-react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { isMobileViewport, useIsMobile } from '@/hooks/useViewport';
import type { ScreenRect } from '@/lib/guestViewOcclusion';
import { useSessionsStore } from '@/stores/sessions';
import { normalizeGlobalState, type PanelScope, selectSidePanelShown } from './globalTabs';
import { removeLayoutPanel } from './layoutSanitize';
import { migrateSidePanelState, SIDE_PANEL_VERSION } from './migrate';
import {
  FILES_TREE_DEFAULT_WIDTH,
  resizeFilesTreeWidth,
  resizeSidePanelWidth,
  SIDE_PANEL_DEFAULT_WIDTH,
} from './width';

export type { PanelScope } from './globalTabs';
export {
  clampFilesTreeWidth,
  resolveFilesTreeWidth,
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
} from './width';

export type ChangesMode = 'all' | 'git';
export type PinnableSidePanelTab =
  | 'terminal'
  | 'changes'
  | 'files'
  | 'browser'
  | 'btw'
  | 'workflow'
  | `plugin:${string}:${string}`;

/** open 缺省 = 用户没开关过：有全局标签时自动显示（见 selectSidePanelShown） */
export type SidePanelUi = { open?: boolean; width: number };

interface SidePanelState {
  /** 铺满中间工作区;不 persist,关面板 / 切到关着的会话时清掉 */
  fullscreen: boolean;
  /** 各会话自己的全屏记忆；全局 fullscreen 只反映当前会话，避免秘书的全屏盖住别的会话 */
  fullscreenByConversation: Record<string, boolean>;
  /**
   * 最近一次手动调整的宽度，仅作为尚无面板设置的会话的初始值，随会话偏好一起保存。
   */
  lastWidth: number;
  /** Files 面板文件树宽度，所有会话共用 */
  filesTreeWidth: number;
  uiByConversation: Record<string, SidePanelUi>;
  /** 可见的原生 guest 矩形（运行态，不持久化）：壁纸按这些矩形挖孔给垫底的 view 透出 */
  browserHoles: Record<string, ScreenRect>;
  /** conversationId -> dockview 序列化布局(分屏结构 + tab 集合) */
  layouts: Record<string, SerializedDockview | undefined>;
  /** 新会话打开侧栏时自动创建的面板类型 */
  pinnedTabs: PinnableSidePanelTab[];
  /** 全局标签（插件面板 id），按打开顺序；所有会话共享开关 */
  globalTabs: string[];
  /** 用户在右键菜单里改过的作用域，优先于清单声明 */
  globalScopeOverrides: Record<string, PanelScope>;
  /** 运行态：globalTabs 里当前真正启用的全局页面，决定没开关过的会话要不要自动显示 */
  liveGlobalTabs: string[];
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
  /** paneWidth 为 Files 面板当前宽度，0 表示未量到 */
  nudgeFilesTreeWidth: (delta: number, paneWidth?: number) => void;
  resetFilesTreeWidth: () => void;
  toggleFullscreen: () => void;
  setFullscreen: (fullscreen: boolean) => void;
  togglePinnedTab: (tab: PinnableSidePanelTab) => void;
  setGlobalTabs: (globalTabs: string[]) => void;
  setGlobalScopeOverride: (panelId: string, scope: PanelScope | undefined) => void;
  setLiveGlobalTabs: (tabs: string[]) => void;
  /** 从没挂载会话的已存布局里摘掉一个全局面板；摘空了且侧栏明确开着就收起，同关最后一个 tab */
  dropPanelFromLayouts: (panelId: string, keepConversationIds: ReadonlySet<string>) => void;
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
  return state.uiByConversation[id] ?? { width: state.lastWidth };
}

function shownFor(state: SidePanelState, id: string): boolean {
  return selectSidePanelShown(state, id, isMobileViewport());
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
      filesTreeWidth: FILES_TREE_DEFAULT_WIDTH,
      uiByConversation: {},
      browserHoles: {},
      layouts: {},
      pinnedTabs: [],
      globalTabs: [],
      globalScopeOverrides: {},
      liveGlobalTabs: [],
      changesModeByConversation: {},
      snapshotsByConversation: {},

      toggleOpen: () => {
        const id = activeConversationId();
        if (!id) return;
        const open = !shownFor(get(), id);
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

      nudgeFilesTreeWidth: (delta, paneWidth = 0) => {
        const filesTreeWidth = resizeFilesTreeWidth(get().filesTreeWidth, delta, paneWidth);
        if (filesTreeWidth !== get().filesTreeWidth) set({ filesTreeWidth });
      },

      resetFilesTreeWidth: () => set({ filesTreeWidth: FILES_TREE_DEFAULT_WIDTH }),

      toggleFullscreen: () => {
        const id = activeConversationId();
        if (!id) return;
        const { fullscreen } = get();
        if (!shownFor(get(), id)) {
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

      setGlobalTabs: (globalTabs) => set({ globalTabs }),

      setGlobalScopeOverride: (panelId, scope) => {
        const { [panelId]: _old, ...rest } = get().globalScopeOverrides;
        set({ globalScopeOverrides: scope ? { ...rest, [panelId]: scope } : rest });
      },

      setLiveGlobalTabs: (tabs) => {
        const prev = get().liveGlobalTabs;
        if (prev.length === tabs.length && prev.every((id, i) => id === tabs[i])) return;
        set({ liveGlobalTabs: tabs });
      },

      dropPanelFromLayouts: (panelId, keepConversationIds) => {
        const { layouts, uiByConversation } = get();
        const nextLayouts = { ...layouts };
        const nextUi = { ...uiByConversation };
        let changed = false;
        for (const [id, layout] of Object.entries(layouts)) {
          if (keepConversationIds.has(id)) continue;
          const next = removeLayoutPanel(layout, panelId);
          if (next === layout) continue;
          changed = true;
          nextLayouts[id] = next;
          const ui = uiByConversation[id];
          if (!next && ui?.open === true) nextUi[id] = { ...ui, open: false };
        }
        if (changed) set({ layouts: nextLayouts, uiByConversation: nextUi });
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
        filesTreeWidth: state.filesTreeWidth,
        uiByConversation: state.uiByConversation,
        fullscreenByConversation: state.fullscreenByConversation,
        layouts: state.layouts,
        pinnedTabs: state.pinnedTabs,
        globalTabs: state.globalTabs,
        globalScopeOverrides: state.globalScopeOverrides,
        changesModeByConversation: state.changesModeByConversation,
      }),
      merge: (persisted, current) => {
        const state = (persisted && typeof persisted === 'object' ? persisted : {}) as Record<
          string,
          unknown
        >;
        return { ...current, ...state, ...normalizeGlobalState(state) };
      },
      migrate: (persisted, version) => {
        const { state, snapshots } = migrateSidePanelState(persisted, version);
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

/** 某会话的侧栏此刻是否显示（三态：明确开/关，或没开关过且有全局标签、非手机） */
export function useSidePanelShown(conversationId: string | null | undefined): boolean {
  const isMobile = useIsMobile();
  return useSidePanelStore((state) => selectSidePanelShown(state, conversationId, isMobile));
}
