import type { DockviewApi } from 'dockview-react';

/** 秘书会话的原生面板：工作台、记忆与定时都在这一块；已开就切过去，不重复建 */
export function addSecretaryPanel(
  api: Pick<DockviewApi, 'getPanel' | 'addPanel'>,
  conversationId: string | undefined,
  projectId: string | undefined,
  label: string
): void {
  const existing = api.getPanel('secretary');
  if (existing) {
    existing.focus();
    return;
  }
  api.addPanel({
    id: 'secretary',
    component: 'secretary',
    title: label,
    params: { conversationId, projectId },
  });
}

/** 秘书会话侧栏每次由收起变为打开时只放行一次，打开期间重渲染、切会话回来都不再抢焦点 */
export function createSecretaryConsoleReveal(): (input: {
  secretary: boolean;
  open: boolean;
  active: boolean;
  ready: boolean;
}) => boolean {
  let revealed = false;
  return ({ secretary, open, active, ready }) => {
    if (!open) {
      revealed = false;
      return false;
    }
    if (revealed || !secretary || !active || !ready) return false;
    revealed = true;
    return true;
  };
}
