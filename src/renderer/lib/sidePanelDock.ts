import type { DockviewApi } from 'dockview-react';
import { useSessionsStore } from '@/stores/sessions';
import { useSidePanelStore } from '@/stores/sidePanel';

const docks = new Map<string, DockviewApi>();
const filesTabClosers = new Map<string, () => boolean>();

export function registerFilesTabCloser(conversationId: string, close: () => boolean): () => void {
  filesTabClosers.set(conversationId, close);
  return () => {
    if (filesTabClosers.get(conversationId) === close) filesTabClosers.delete(conversationId);
  };
}

export function bindSidePanelDock(conversationId: string, api: DockviewApi): void {
  docks.set(conversationId, api);
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
  if (!useSidePanelStore.getState().open) useSidePanelStore.getState().toggleOpen();
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
  if (!useSidePanelStore.getState().open) useSidePanelStore.getState().toggleOpen();
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
  if (!useSidePanelStore.getState().open) useSidePanelStore.getState().toggleOpen();
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

export function addSidePanelBrowser(opts?: { title?: string }): void {
  const active = activeDock();
  if (!active) return;
  if (!useSidePanelStore.getState().open) useSidePanelStore.getState().toggleOpen();
  const existing = active.api.getPanel('browser');
  if (existing) {
    existing.focus();
    return;
  }
  active.api.addPanel({
    id: 'browser',
    component: 'browser',
    title: opts?.title ?? 'Browser',
    params: { conversationId: active.conversationId, projectId: active.projectId },
  });
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
