import type { ExtensionPluginSummary } from '@shared/extensionPlugins/types';
import {
  isWorkflowAvailable,
  projectDisabledBuiltinTools,
  resolveDisabledBuiltinTools,
} from '@shared/types/builtinTools';
import type { DockviewApi } from 'dockview-react';
import { isMobileViewport } from '@/hooks/useViewport';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import type { SettingsState } from '@/stores/settings/types';
import { useSidePanelStore } from '@/stores/sidePanel';
import {
  createSyncGuard,
  globalPanelIds,
  liveGlobalTabs,
  planGlobalTabSync,
  pluginPanelId,
  selectSidePanelShown,
  withGlobalTab,
} from '@/stores/sidePanel/globalTabs';
import { getPluginViews, pluginViewsReady, subscribePluginViews } from '../plugins/viewBridge';
import { isRemoteClient } from './remoteClient';
import { resolveSidePanelDockConversationId } from './sidePanelDockId';
import { releaseTerminal } from './terminalInstances';

const docks = new Map<string, DockviewApi>();
const dockRemoveDisposers = new Map<string, { dispose: () => void }>();
const filesTabClosers = new Map<string, () => boolean>();
type FileTarget = [rel: string, line?: number, viewer?: 'text' | 'markdown'];
const filesOpeners = new Map<string, (...target: FileTarget) => void>();
/** Files 视图未挂载时挂起的待开文件，视图注册 opener 时补开 */
const pendingFileOpens = new Map<string, FileTarget>();
/** dock 未挂载时挂起的 Files 面板，dock 绑定后补建 */
const pendingFilesReveal = new Set<string>();
const pendingBrowserReveal: { conversationId: string; tabId?: string; ownerId?: string }[] = [];
const pendingWorkflowReveal: {
  conversationId: string;
  ownerId: string;
  title: string;
  runId: string;
}[] = [];
const pendingPluginViewReveal: {
  conversationId: string;
  ownerId: string;
  pluginId: string;
  viewId: string;
  title: string;
}[] = [];
const revealedWorkflowRuns = new Set<string>();

/** 工作流 tab 跟随该项目生效的内置工具开关（项目覆盖优先于全局） */
export function selectWorkflowAvailable(
  state: Pick<SettingsState, 'disabledBuiltinTools' | 'projects'>,
  projectId: string | undefined
): boolean {
  return isWorkflowAvailable(
    resolveDisabledBuiltinTools(state.disabledBuiltinTools, {
      disabledBuiltinTools: projectDisabledBuiltinTools(state.projects, projectId),
    })
  );
}

export function registerFilesTabCloser(conversationId: string, close: () => boolean): () => void {
  filesTabClosers.set(conversationId, close);
  return () => {
    if (filesTabClosers.get(conversationId) === close) filesTabClosers.delete(conversationId);
  };
}

/**
 * 注册按会话归属的 Files 打开入口；冷挂载时保留行号与查看器意图并只消费一次。
 */
export function registerFilesOpener(
  conversationId: string,
  open: (...target: FileTarget) => void
): () => void {
  filesOpeners.set(conversationId, open);
  const pending = pendingFileOpens.get(conversationId);
  if (pending !== undefined) {
    pendingFileOpens.delete(conversationId);
    open(...pending);
  }
  return () => {
    if (filesOpeners.get(conversationId) === open) filesOpeners.delete(conversationId);
  };
}

/** 关掉最后一个 tab 时收起侧栏；须在 fromJSON 恢复布局之后挂，否则恢复时清空 dock 会误收起 */
export function watchSidePanelAutoCollapse(conversationId: string, api: DockviewApi): void {
  dockRemoveDisposers.get(conversationId)?.dispose();
  dockRemoveDisposers.set(
    conversationId,
    api.onDidRemovePanel(() => {
      if (api.panels.length !== 0) return;
      if (useSidePanelStore.getState().uiByConversation[conversationId]?.open !== true) return;
      useSidePanelStore.setState((state) => {
        const ui = state.uiByConversation[conversationId];
        return ui?.open
          ? {
              uiByConversation: {
                ...state.uiByConversation,
                [conversationId]: { ...ui, open: false },
              },
            }
          : {};
      });
    })
  );
}

export function bindSidePanelDock(conversationId: string, api: DockviewApi): void {
  docks.set(conversationId, api);
  if (pendingFilesReveal.delete(conversationId)) {
    // 等 onReady 里的布局恢复完再建，免得被 fromJSON 覆盖
    queueMicrotask(() => {
      const projectId = useSessionsStore.getState().conversations[conversationId]?.projectId;
      if (projectId && docks.get(conversationId) === api) {
        revealFilesPanel(api, conversationId, projectId);
      }
    });
  }
  const due = pendingBrowserReveal.filter((item) => item.conversationId === conversationId);
  pendingBrowserReveal.splice(
    0,
    pendingBrowserReveal.length,
    ...pendingBrowserReveal.filter((item) => item.conversationId !== conversationId)
  );
  for (const item of due) {
    addSidePanelBrowser({
      conversationId: item.ownerId ?? item.conversationId,
      tabId: item.tabId,
    });
  }
  const workflowDue = pendingWorkflowReveal.filter(
    (item) => item.conversationId === conversationId
  );
  pendingWorkflowReveal.splice(
    0,
    pendingWorkflowReveal.length,
    ...pendingWorkflowReveal.filter((item) => item.conversationId !== conversationId)
  );
  for (const item of workflowDue) {
    addSidePanelWorkflow({
      conversationId: item.ownerId,
      runId: item.runId,
      title: item.title,
    });
  }
  const pluginViewDue = pendingPluginViewReveal.filter(
    (item) => item.conversationId === conversationId
  );
  pendingPluginViewReveal.splice(
    0,
    pendingPluginViewReveal.length,
    ...pendingPluginViewReveal.filter((item) => item.conversationId !== conversationId)
  );
  for (const item of pluginViewDue) {
    openSidePanelPluginView({
      conversationId: item.ownerId,
      pluginId: item.pluginId,
      viewId: item.viewId,
      title: item.title,
    });
  }
}

/** dock 卸载（Bot 模式、删会话）时先解绑：之后 dockview 自己清空面板不能当成用户关闭 */
export function unbindSidePanelDock(conversationId: string, api: DockviewApi): void {
  if (docks.get(conversationId) === api) docks.delete(conversationId);
}

// ---- 全局标签 ----

const globalSync = createSyncGuard();
/** 插件 ui.view.open 为全局页面临时打开了侧栏：记下原来的开关，close 时还原 */
const pluginOpenedGlobal = new Map<string, { dockId: string; open: boolean | undefined }>();

function currentGlobalIds(): Set<string> {
  return globalPanelIds(getPluginViews(), useSidePanelStore.getState().globalScopeOverrides);
}

function addGlobalPanel(
  api: DockviewApi,
  conversationId: string,
  panelId: string,
  focus: boolean
): void {
  const existing = api.getPanel(panelId);
  if (existing) {
    if (focus) existing.focus();
    return;
  }
  const view = getPluginViews().find((entry) => pluginPanelId(entry) === panelId);
  if (!view) return;
  const group = api.groups[0];
  api.addPanel({
    id: panelId,
    component: 'plugin',
    title: view.title,
    params: {
      conversationId,
      projectId: useSessionsStore.getState().conversations[conversationId]?.projectId,
      pluginId: view.pluginId,
      viewId: view.id,
    },
    renderer: 'always',
    // 补进别的会话不抢焦点（秘书面板仍是选中的那个），新补的放在第一个分组末尾。
    // 空 dock 不能 inactive：分组不激活，之后再加的面板（如秘书面板）会另开一个分屏
    inactive: !focus && api.panels.length > 0,
    ...(group ? { position: { referenceGroup: group } } : {}),
  });
}

/** 打开一个全局标签：加进 globalTabs，补进所有已挂载的 dock；没挂载的在 onReady 补 */
export function openGlobalTab(panelId: string, originConversationId?: string): void {
  const store = useSidePanelStore.getState();
  store.setGlobalTabs(withGlobalTab(store.globalTabs, panelId));
  for (const [conversationId, api] of docks) {
    addGlobalPanel(api, conversationId, panelId, conversationId === originConversationId);
  }
}

/**
 * 关掉一个全局标签：从 globalTabs 移除，所有已挂载 dock 一起关，没挂载会话的已存布局也摘掉。
 * keepConversationId：改回会话作用域时只留在这个会话。
 */
export function closeGlobalTab(panelId: string, keepConversationId?: string): void {
  globalSync.run(() => {
    for (const [conversationId, api] of docks) {
      if (conversationId !== keepConversationId) api.getPanel(panelId)?.api.close();
    }
  });
  const store = useSidePanelStore.getState();
  store.setGlobalTabs(store.globalTabs.filter((id) => id !== panelId));
  const keep = new Set(docks.keys());
  if (keepConversationId) keep.add(keepConversationId);
  store.dropPanelFromLayouts(panelId, keep);
}

/**
 * 用户在某个 dock 加了全局页面（新建菜单、固定标签、插件 open）= 打开全局标签；
 * 关掉全局标签 = 全局关闭。须在 fromJSON 恢复布局之后挂，恢复出来的由 syncDockGlobalTabs 处理。
 */
export function watchGlobalTabs(conversationId: string, api: DockviewApi): { dispose(): void } {
  const owned = () => !globalSync.active() && docks.get(conversationId) === api;
  const added = api.onDidAddPanel((panel) => {
    if (!owned() || useSidePanelStore.getState().globalTabs.includes(panel.id)) return;
    if (currentGlobalIds().has(panel.id)) openGlobalTab(panel.id, conversationId);
  });
  const removed = api.onDidRemovePanel((panel) => {
    if (!owned() || !useSidePanelStore.getState().globalTabs.includes(panel.id)) return;
    pluginOpenedGlobal.delete(panel.id);
    closeGlobalTab(panel.id);
  });
  return {
    dispose: () => {
      added.dispose();
      removed.dispose();
    },
  };
}

/**
 * 一个 dock 与 globalTabs 归并。full（挂载后第一次、插件列表已到）时删掉在别处已关的；
 * 侧栏明确开着时把旧布局里的全局插件面板收进 globalTabs（v5 迁移、清单改成 global）。
 */
export function syncDockGlobalTabs(conversationId: string, api: DockviewApi, full: boolean): void {
  if (docks.get(conversationId) !== api || !pluginViewsReady()) return;
  const store = useSidePanelStore.getState();
  const plan = planGlobalTabSync({
    globalTabs: store.globalTabs,
    globalIds: currentGlobalIds(),
    dockPanelIds: api.panels.map((panel) => panel.id),
    adopt: store.uiByConversation[conversationId]?.open === true,
    pruneExtras: full,
  });
  if (plan.adopt.length > 0) {
    store.setGlobalTabs(plan.adopt.reduce(withGlobalTab, store.globalTabs));
    for (const [id, other] of docks) {
      if (other === api) continue;
      for (const panelId of plan.adopt) addGlobalPanel(other, id, panelId, false);
    }
  }
  globalSync.run(() => {
    for (const panelId of plan.remove) api.getPanel(panelId)?.api.close();
  });
  for (const panelId of plan.add) addGlobalPanel(api, conversationId, panelId, false);
}

/** liveGlobalTabs 跟着 globalTabs、作用域覆盖与插件列表走 */
export function bindLiveGlobalTabs(): () => void {
  const update = () => {
    const { globalTabs, globalScopeOverrides, setLiveGlobalTabs } = useSidePanelStore.getState();
    setLiveGlobalTabs(
      liveGlobalTabs(globalTabs, getPluginViews(), globalScopeOverrides, pluginViewsReady())
    );
  };
  update();
  const stopViews = subscribePluginViews(update);
  const stopStore = useSidePanelStore.subscribe((state, prev) => {
    if (
      state.globalTabs !== prev.globalTabs ||
      state.globalScopeOverrides !== prev.globalScopeOverrides
    )
      update();
  });
  return () => {
    stopViews();
    stopStore();
  };
}

/** 右键菜单「在所有会话中显示」切换插件面板的作用域 */
export function setPluginPanelScope(
  panelId: string,
  conversationId: string,
  scope: 'global' | 'session'
): void {
  const view = getPluginViews().find((entry) => pluginPanelId(entry) === panelId);
  if (!view) return;
  const store = useSidePanelStore.getState();
  store.setGlobalScopeOverride(panelId, (view.scope ?? 'session') === scope ? undefined : scope);
  if (scope === 'global') openGlobalTab(panelId, conversationId);
  else {
    pluginOpenedGlobal.delete(panelId);
    closeGlobalTab(panelId, conversationId);
  }
}

/**
 * 插件升级后清单里没了的视图：从 globalTabs、已挂载 dock 和没挂载会话的已存布局里摘掉。
 * 只认列表里 enabled 的插件；禁用、崩溃、清单读不出或已卸载的状态未知，一律不动。
 */
export function pruneUndeclaredPluginTabs(
  plugins: readonly Pick<ExtensionPluginSummary, 'id' | 'state' | 'views'>[]
): void {
  const declared = new Map(
    plugins
      .filter((plugin) => plugin.state === 'enabled')
      .map((plugin) => [`plugin:${plugin.id}:`, new Set(plugin.views.map((view) => view.id))])
  );
  const stale = (panelId: string) => {
    const end = panelId.lastIndexOf(':');
    const views = declared.get(panelId.slice(0, end + 1));
    return views !== undefined && !views.has(panelId.slice(end + 1));
  };
  const store = useSidePanelStore.getState();
  const ids = new Set([
    ...store.globalTabs,
    ...[...docks.values()].flatMap((api) => api.panels.map((panel) => panel.id)),
    ...Object.values(store.layouts).flatMap((layout) => Object.keys(layout?.panels ?? {})),
  ]);
  const doomed = [...ids].filter(stale);
  if (doomed.length === 0) return;
  globalSync.run(() => {
    for (const api of docks.values()) {
      for (const panelId of doomed) {
        const panel = api.getPanel(panelId);
        if (!panel) continue;
        if (api.activePanel?.id === panelId) {
          const siblings = panel.group.panels;
          const at = siblings.indexOf(panel);
          [...siblings.slice(0, at).reverse(), ...siblings.slice(at + 1)]
            .find((other) => !doomed.includes(other.id))
            ?.api.setActive();
        }
        panel.api.close();
      }
    }
  });
  store.setGlobalTabs(store.globalTabs.filter((id) => !doomed.includes(id)));
  const keep = new Set(docks.keys());
  for (const panelId of doomed) store.dropPanelFromLayouts(panelId, keep);
}

function activeDock(): { api: DockviewApi; conversationId: string; projectId: string } | null {
  const sessions = useSessionsStore.getState();
  const conversationId = sessions.activeId;
  if (!conversationId) return null;
  const conversation = sessions.conversations[conversationId];
  const api = docks.get(conversationId);
  if (!conversation || !api) return null;
  return { api, conversationId, projectId: conversation.projectId };
}

export function addSidePanelTerminal(): void {
  const active = activeDock();
  if (!active) return;
  if (isSecretaryProject(active.projectId)) return;
  useSidePanelStore.getState().ensureOpen();
  const count = active.api.panels.length;
  active.api.addPanel({
    id: crypto.randomUUID(),
    component: 'terminal',
    title: count === 0 ? 'Terminal' : `Terminal ${count + 1}`,
    params: { conversationId: active.conversationId, projectId: active.projectId },
  });
}

export function addSidePanelChanges(opts?: { title?: string }): void {
  const active = activeDock();
  if (!active) return;
  // 秘书会话没有代码可看：终端、文件、改动都不给入口
  if (isSecretaryProject(active.projectId)) return;
  useSidePanelStore.getState().ensureOpen();
  const existing = active.api.getPanel('changes');
  if (existing) {
    existing.focus();
    return;
  }
  active.api.addPanel({
    id: 'changes',
    component: 'changes',
    title: opts?.title ?? 'Changes',
    params: { conversationId: active.conversationId, projectId: active.projectId },
  });
}

export function addSidePanelFiles(opts?: { title?: string }): void {
  const active = activeDock();
  if (!active) return;
  if (isSecretaryProject(active.projectId)) return;
  useSidePanelStore.getState().ensureOpen();
  revealFilesPanel(active.api, active.conversationId, active.projectId, opts?.title);
}

/** 秘书会话只留浏览器、工作台与记忆三种面板 */
export function selectIsSecretaryProject(
  projects: readonly { id: string; kind?: string }[],
  projectId: string | undefined
): boolean {
  if (!projectId) return false;
  return projects.some((project) => project.id === projectId && project.kind === 'secretary');
}

export function isSecretaryProject(projectId: string | undefined): boolean {
  return selectIsSecretaryProject(useSettingsStore.getState().projects, projectId);
}

function revealFilesPanel(
  api: DockviewApi,
  conversationId: string,
  projectId: string,
  title?: string
): void {
  const existing = api.getPanel('files');
  if (existing) {
    existing.focus();
    return;
  }
  api.addPanel({
    id: 'files',
    component: 'files',
    title: title ?? 'Files',
    params: { conversationId, projectId },
  });
}

/**
 * 在会话所属 dock 打开文件，btw 沿既有父路由；Markdown 查看器选择预览，行号入口使用源码。
 */
export function openSidePanelFile(
  conversationId: string,
  rel: string,
  line?: number,
  viewer?: 'text' | 'markdown'
): void {
  const sessions = useSessionsStore.getState();
  const dockId = resolveSidePanelDockConversationId(sessions.conversations, conversationId);
  const projectId = sessions.conversations[dockId]?.projectId;
  if (!projectId || isSecretaryProject(projectId)) return;
  useSidePanelStore.getState().ensureOpen(dockId);
  const target: FileTarget = viewer ? [rel, line, viewer] : line ? [rel, line] : [rel];
  const open = filesOpeners.get(dockId);
  if (open) open(...target);
  else pendingFileOpens.set(dockId, target);
  const api = docks.get(dockId);
  if (api) revealFilesPanel(api, dockId, projectId);
  else pendingFilesReveal.add(dockId);
}

export function addSidePanelBrowser(opts?: {
  title?: string;
  conversationId?: string;
  tabId?: string;
}): void {
  const sessions = useSessionsStore.getState();
  const ownerId = opts?.conversationId ?? sessions.activeId;
  if (!ownerId) return;
  const conversation = sessions.conversations[ownerId];
  if (!conversation) return;
  const dockId = resolveSidePanelDockConversationId(sessions.conversations, ownerId);
  const api = docks.get(dockId);
  useSidePanelStore.getState().ensureOpen(dockId);
  const tabId = opts?.tabId ?? `browser:${crypto.randomUUID()}`;
  if (!api) {
    pendingBrowserReveal.push({ conversationId: dockId, tabId, ownerId });
    return;
  }
  const existing = api.getPanel(tabId);
  if (existing) {
    existing.focus();
    return;
  }
  api.addPanel({
    id: tabId,
    component: 'browser',
    title: opts?.title ?? 'Browser',
    params: { conversationId: ownerId, projectId: conversation.projectId },
  });
}

/** 聊天网页链接：在会话所属 dock 新开内置浏览器 tab；会话不存在返回 null，由调用方回落系统浏览器 */
export function openSidePanelBrowserUrl(
  conversationId: string,
  url: string
): Promise<{ ok: boolean; error?: string }> | null {
  if (!useSessionsStore.getState().conversations[conversationId]) return null;
  const tabId = `browser:${crypto.randomUUID()}`;
  addSidePanelBrowser({ conversationId, tabId, title: new URL(url).host });
  return window.electronAPI.browser.navigate(tabId, conversationId, url);
}

export function addSidePanelBtw(opts?: { title?: string }): void {
  const active = activeDock();
  if (!active) return;
  useSidePanelStore.getState().ensureOpen();
  const count = active.api.panels.filter((panel) => panel.id.startsWith('btw:')).length;
  active.api.addPanel({
    id: `btw:${crypto.randomUUID()}`,
    component: 'btw',
    title: opts?.title ?? (count === 0 ? 'Btw' : `Btw ${count + 1}`),
    params: { conversationId: active.conversationId, projectId: active.projectId },
  });
}

/** 复盘旁路：在会话所属 dock 开一个 learn 模式的 btw tab，从主会话分叉消息序列复盘 */
export function addSidePanelLearn(conversationId: string, opts?: { title?: string }): void {
  const sessions = useSessionsStore.getState();
  const conversation = sessions.conversations[conversationId];
  if (!conversation) return;
  const dockId = resolveSidePanelDockConversationId(sessions.conversations, conversationId);
  const api = docks.get(dockId);
  useSidePanelStore.getState().ensureOpen(dockId);
  if (!api) return;
  api.addPanel({
    id: `btw:${crypto.randomUUID()}`,
    component: 'btw',
    title: opts?.title ?? 'Learn',
    params: { conversationId, projectId: conversation.projectId, learn: true },
  });
}

export function addSidePanelWorkflow(opts: {
  conversationId: string;
  runId: string;
  title?: string;
}): void {
  const revealKey = `${opts.conversationId}:${opts.runId}`;
  if (revealedWorkflowRuns.has(revealKey)) return;
  const sessions = useSessionsStore.getState();
  const conversation = sessions.conversations[opts.conversationId];
  if (!conversation) return;
  if (!selectWorkflowAvailable(useSettingsStore.getState(), conversation.projectId)) return;
  const dockId = resolveSidePanelDockConversationId(sessions.conversations, opts.conversationId);
  const api = docks.get(dockId);
  useSidePanelStore.getState().ensureOpen(dockId);
  if (!api) {
    pendingWorkflowReveal.push({
      conversationId: dockId,
      ownerId: opts.conversationId,
      title: opts.title ?? 'Workflow',
      runId: opts.runId,
    });
    return;
  }
  revealedWorkflowRuns.add(revealKey);
  if (api.getPanel('workflow')) return;
  api.addPanel({
    id: 'workflow',
    component: 'workflow',
    title: opts.title ?? 'Workflow',
    params: { conversationId: opts.conversationId, projectId: conversation.projectId },
  });
}

export function openSidePanelPluginView(opts: {
  conversationId: string;
  pluginId: string;
  viewId: string;
  title: string;
}): void {
  const sessions = useSessionsStore.getState();
  const conversation = sessions.conversations[opts.conversationId];
  if (!conversation) return;
  const dockId = resolveSidePanelDockConversationId(sessions.conversations, opts.conversationId);
  const api = docks.get(dockId);
  const id = `plugin:${opts.pluginId}:${opts.viewId}`;
  if (currentGlobalIds().has(id)) {
    openPluginGlobalView(dockId, id, Boolean(api));
    if (!api) {
      pendingPluginViewReveal.push({
        conversationId: dockId,
        ownerId: opts.conversationId,
        pluginId: opts.pluginId,
        viewId: opts.viewId,
        title: opts.title,
      });
    }
    return;
  }
  const panelWasOpen = useSidePanelStore.getState().uiByConversation[dockId]?.open === true;
  useSidePanelStore.getState().ensureOpen(dockId);
  // 用户已开着右侧栏时清掉旧记录，免得之后 close 收起用户自己开的栏
  if (panelWasOpen) pluginOpenedPanel.delete(`${dockId}\n${id}`);
  else if (!api?.getPanel(id)) pluginOpenedPanel.add(`${dockId}\n${id}`);
  if (!api) {
    pendingPluginViewReveal.push({
      conversationId: dockId,
      ownerId: opts.conversationId,
      pluginId: opts.pluginId,
      viewId: opts.viewId,
      title: opts.title,
    });
    return;
  }
  const existing = api.getPanel(id);
  if (existing) {
    existing.focus();
    return;
  }
  api.addPanel({
    id,
    component: 'plugin',
    title: opts.title,
    params: {
      conversationId: dockId,
      projectId: conversation.projectId,
      pluginId: opts.pluginId,
      viewId: opts.viewId,
    },
    renderer: 'always',
  });
}

/** 右侧栏是插件 open 时才打开的：关掉该页面且它仍是当前标签时一并收起 */
const pluginOpenedPanel = new Set<string>();

/** 全局页面：开的是全局列表；目标会话的侧栏没显示时打开它，并记下原开关供 close 还原 */
function openPluginGlobalView(dockId: string, panelId: string, mounted: boolean): void {
  const state = useSidePanelStore.getState();
  const shown = selectSidePanelShown(state, dockId, isMobileViewport());
  // dock 没挂载时会排队重放一次，那时侧栏已被这里打开，不能把记录当成用户自己开的清掉
  if (shown) {
    if (pluginOpenedGlobal.get(panelId)?.dockId !== dockId) pluginOpenedGlobal.delete(panelId);
  } else if (!state.globalTabs.includes(panelId)) {
    pluginOpenedGlobal.set(panelId, { dockId, open: state.uiByConversation[dockId]?.open });
  }
  openGlobalTab(panelId, mounted ? dockId : undefined);
  if (!selectSidePanelShown(useSidePanelStore.getState(), dockId, isMobileViewport())) {
    state.ensureOpen(dockId);
  }
}

function closePluginGlobalView(dockId: string, panelId: string): void {
  const opened = pluginOpenedGlobal.get(panelId);
  pluginOpenedGlobal.delete(panelId);
  const active = docks.get(dockId)?.activePanel?.id === panelId;
  closeGlobalTab(panelId);
  if (!opened || opened.dockId !== dockId || !active) return;
  useSidePanelStore.setState((state) => {
    const ui = state.uiByConversation[dockId];
    if (!ui || ui.open === opened.open) return {};
    const { open: _open, ...rest } = ui;
    const next = opened.open === undefined ? rest : { ...rest, open: opened.open };
    return { uiByConversation: { ...state.uiByConversation, [dockId]: next } };
  });
}

export function closeSidePanelPluginView(opts: {
  conversationId: string;
  pluginId: string;
  viewId: string;
}): void {
  const dockId = resolveSidePanelDockConversationId(
    useSessionsStore.getState().conversations,
    opts.conversationId
  );
  const id = `plugin:${opts.pluginId}:${opts.viewId}`;
  const key = `${dockId}\n${id}`;
  if (useSidePanelStore.getState().globalTabs.includes(id)) {
    pendingPluginViewReveal.splice(
      0,
      pendingPluginViewReveal.length,
      ...pendingPluginViewReveal.filter((item) => `plugin:${item.pluginId}:${item.viewId}` !== id)
    );
    closePluginGlobalView(dockId, id);
    return;
  }
  const restore = pluginOpenedPanel.delete(key);
  pendingPluginViewReveal.splice(
    0,
    pendingPluginViewReveal.length,
    ...pendingPluginViewReveal.filter(
      (item) => !(item.conversationId === dockId && `plugin:${item.pluginId}:${item.viewId}` === id)
    )
  );
  const api = docks.get(dockId);
  const panel = api?.getPanel(id);
  if (!api || !panel) return;
  const active = api.activePanel?.id === id;
  panel.api.close();
  if (!restore || !active) return;
  useSidePanelStore.setState((state) => {
    const ui = state.uiByConversation[dockId];
    return ui?.open
      ? { uiByConversation: { ...state.uiByConversation, [dockId]: { ...ui, open: false } } }
      : {};
  });
}

export function closeSidePanelBrowser(conversationId: string, tabId: string): void {
  const dockId = resolveSidePanelDockConversationId(
    useSessionsStore.getState().conversations,
    conversationId
  );
  docks.get(dockId)?.getPanel(tabId)?.api.close();
}

export function disposeConversationResources(conversationId: string): void {
  const api = docks.get(conversationId);
  docks.delete(conversationId);
  dockRemoveDisposers.get(conversationId)?.dispose();
  dockRemoveDisposers.delete(conversationId);
  filesTabClosers.delete(conversationId);
  filesOpeners.delete(conversationId);
  pendingFileOpens.delete(conversationId);
  pendingFilesReveal.delete(conversationId);
  pendingBrowserReveal.splice(
    0,
    pendingBrowserReveal.length,
    ...pendingBrowserReveal.filter((item) => item.conversationId !== conversationId)
  );
  pendingWorkflowReveal.splice(
    0,
    pendingWorkflowReveal.length,
    ...pendingWorkflowReveal.filter((item) => item.conversationId !== conversationId)
  );
  pendingPluginViewReveal.splice(
    0,
    pendingPluginViewReveal.length,
    ...pendingPluginViewReveal.filter((item) => item.conversationId !== conversationId)
  );
  for (const runId of [...revealedWorkflowRuns]) {
    if (runId.startsWith(`${conversationId}:`)) revealedWorkflowRuns.delete(runId);
  }
  if (api) {
    for (const panel of [...api.panels]) {
      if (panel.id === 'changes' || panel.id === 'files') continue;
      if (panel.id === 'secretary') continue;
      if (panel.id === 'browser' || panel.id.startsWith('browser:')) continue;
      releaseTerminal(panel.id);
      void window.electronAPI?.terminal?.dispose(panel.id);
    }
  }
  // browser:* 不对远端开放：远程没有宿主浏览器会话可回收
  if (!isRemoteClient()) void window.electronAPI?.browser?.closeSession?.(conversationId);
  useSidePanelStore.getState().forgetConversation(conversationId);
}

export function closeActiveSidePanelTab(): void {
  const active = activeDock();
  if (!active) return;
  if (active.api.activePanel?.id === 'files') {
    const closeFile = filesTabClosers.get(active.conversationId);
    if (closeFile?.()) return;
  }
  active.api.activePanel?.api.close();
}
