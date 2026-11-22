/**
 * 侧栏全局标签：作用域为 global 的插件面板所有会话共用一个常驻实例，开关在所有会话同步。
 * 实际作用域 = 用户覆盖 ?? 清单声明 ?? session。
 */
export type PanelScope = 'global' | 'session';

export interface ScopedPluginView {
  pluginId: string;
  id: string;
  scope?: PanelScope;
}

export interface SidePanelShownInput {
  uiByConversation: Record<string, { open?: boolean; width?: number } | undefined>;
  liveGlobalTabs: readonly string[];
}

const isPluginId = (id: unknown): id is string => {
  if (typeof id !== 'string' || !id.startsWith('plugin:')) return false;
  const separator = id.indexOf(':', 'plugin:'.length);
  return separator > 'plugin:'.length && separator < id.length - 1;
};

export const pluginPanelId = (view: { pluginId: string; id: string }): string =>
  `plugin:${view.pluginId}:${view.id}`;

/** 只有已启用的插件页面能是全局；内置面板与没加载的插件一律按会话 */
export function resolvePanelScope(
  panelId: string,
  overrides: Readonly<Record<string, PanelScope>>,
  views: readonly ScopedPluginView[]
): PanelScope {
  const view = views.find((entry) => pluginPanelId(entry) === panelId);
  if (!view) return 'session';
  return overrides[panelId] ?? view.scope ?? 'session';
}

export function globalPanelIds(
  views: readonly ScopedPluginView[],
  overrides: Readonly<Record<string, PanelScope>>
): Set<string> {
  const ids = new Set<string>();
  for (const view of views) {
    const id = pluginPanelId(view);
    if ((overrides[id] ?? view.scope) === 'global') ids.add(id);
  }
  return ids;
}

/** 真正要常驻的全局标签；插件列表到达前先信持久化值，免得启动时闪一下收起 */
export function liveGlobalTabs(
  globalTabs: readonly string[],
  views: readonly ScopedPluginView[],
  overrides: Readonly<Record<string, PanelScope>>,
  viewsReady: boolean
): string[] {
  if (!viewsReady) return [...globalTabs];
  const ids = globalPanelIds(views, overrides);
  return globalTabs.filter((id) => ids.has(id));
}

/**
 * 侧栏三态：明确开/关按用户的；没开关过的会话有全局标签时自动显示。
 * 手机上侧栏一开就全屏盖住聊天，全局标签不触发自动打开。
 */
export function selectSidePanelShown(
  state: SidePanelShownInput,
  conversationId: string | null | undefined,
  isMobile: boolean
): boolean {
  if (!conversationId) return false;
  const open = state.uiByConversation[conversationId]?.open;
  if (open !== undefined) return open;
  return !isMobile && state.liveGlobalTabs.length > 0;
}

export function withGlobalTab(globalTabs: string[], id: string): string[] {
  return globalTabs.includes(id) ? globalTabs : [...globalTabs, id];
}

/**
 * 一个 dock 和 globalTabs 的归并。adopt：侧栏开着时把布局里还不在列表的全局面板收进来（迁移）；
 * pruneExtras：挂载时删掉已在别处关掉的全局面板。运行中的关闭由调用方逐个 dock 同步，不靠这里删。
 */
export function planGlobalTabSync(input: {
  globalTabs: readonly string[];
  globalIds: ReadonlySet<string>;
  dockPanelIds: readonly string[];
  adopt: boolean;
  pruneExtras: boolean;
}): { adopt: string[]; add: string[]; remove: string[] } {
  const inDock = new Set(input.dockPanelIds);
  const listed = new Set(input.globalTabs);
  const strays = input.dockPanelIds.filter((id) => input.globalIds.has(id) && !listed.has(id));
  const adopt = input.adopt ? strays : [];
  return {
    adopt,
    add: input.globalTabs.filter((id) => input.globalIds.has(id) && !inDock.has(id)),
    remove: input.adopt || !input.pruneExtras ? [] : strays,
  };
}

/** 同步多个 dock 时打的标记：dock 的 onDidRemovePanel 看到它就不再回头触发全局关闭 */
export function createSyncGuard(): { run<T>(fn: () => T): T; active(): boolean } {
  let depth = 0;
  return {
    run(fn) {
      depth += 1;
      try {
        return fn();
      } finally {
        depth -= 1;
      }
    },
    active: () => depth > 0,
  };
}

export function normalizeGlobalState(state: Record<string, unknown>): {
  globalTabs: string[];
  globalScopeOverrides: Record<string, PanelScope>;
} {
  const tabs = Array.isArray(state.globalTabs) ? state.globalTabs.filter(isPluginId) : [];
  const raw = state.globalScopeOverrides;
  const overrides: Record<string, PanelScope> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, scope] of Object.entries(raw)) {
      if (isPluginId(id) && (scope === 'global' || scope === 'session')) overrides[id] = scope;
    }
  }
  return { globalTabs: [...new Set(tabs)], globalScopeOverrides: overrides };
}
