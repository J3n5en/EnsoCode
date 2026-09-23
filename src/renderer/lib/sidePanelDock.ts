import type { DockviewApi } from 'dockview-react';
import { releaseTerminal } from '@/lib/terminalRegistry';
import { useSessionsStore } from '@/stores/sessions';
import { useSidePanelStore } from '@/stores/sidePanel';
import { resolveSidePanelDockConversationId } from './sidePanelDockId';

const docks = new Map<string, DockviewApi>();
const filesTabClosers = new Map<string, () => boolean>();
const pendingBrowserReveal: { conversationId: string; tabId?: string; ownerId?: string }[] = [];
const pendingWorkflowReveal: {
  conversationId: string;
  ownerId: string;
  title: string;
  runId: string;
}[] = [];
const revealedWorkflowRuns = new Set<string>();

export function registerFilesTabCloser(conversationId: string, close: () => boolean): () => void {
  filesTabClosers.set(conversationId, close);
  return () => {
    if (filesTabClosers.get(conversationId) === close) filesTabClosers.delete(conversationId);
  };
}

export function bindSidePanelDock(conversationId: string, api: DockviewApi): void {
  docks.set(conversationId, api);
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
  const existing = active.api.getPanel('files');
  if (existing) {
    existing.focus();
    return;
  }
  active.api.addPanel({
    id: 'files',
    component: 'files',
    title: opts?.title ?? 'Files',
    params: { conversationId: active.conversationId, projectId: active.projectId },
  });
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
