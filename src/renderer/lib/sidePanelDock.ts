import {
  isWorkflowAvailable,
  projectDisabledBuiltinTools,
  resolveDisabledBuiltinTools,
} from '@shared/types/builtinTools';
import type { DockviewApi } from 'dockview-react';
import { releaseTerminal } from '@/lib/terminalRegistry';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import type { SettingsState } from '@/stores/settings/types';
import { useSidePanelStore } from '@/stores/sidePanel';
import { resolveSidePanelDockConversationId } from './sidePanelDockId';

const docks = new Map<string, DockviewApi>();
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
 *
 * Register the conversation-owned Files opener; retain line and viewer intent across cold mounts and consume it once.
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
  useSidePanelStore.getState().ensureOpen();
  revealFilesPanel(active.api, active.conversationId, active.projectId, opts?.title);
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
 *
 * Open files in their conversation-owned dock, preserving the existing btw parent route; Markdown requests preview and line references use source.
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
  if (!projectId) return;
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
  for (const runId of [...revealedWorkflowRuns]) {
    if (runId.startsWith(`${conversationId}:`)) revealedWorkflowRuns.delete(runId);
  }
  if (api) {
    for (const panel of [...api.panels]) {
      if (panel.id === 'changes' || panel.id === 'files') continue;
      if (panel.id === 'browser' || panel.id.startsWith('browser:')) continue;
      releaseTerminal(panel.id);
      void window.electronAPI?.terminal?.dispose(panel.id);
    }
  }
  void window.electronAPI?.browser?.closeSession?.(conversationId);
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
