import type { DockviewApi } from 'dockview-react';
import { useSessionsStore } from '@/stores/sessions';
import { useSidePanelStore } from '@/stores/sidePanel';

const docks = new Map<string, DockviewApi>();

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

export function closeActiveSidePanelTab(): void {
  activeDock()?.api.activePanel?.api.close();
}
