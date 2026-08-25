import { getTranslation, type Locale, normalizeLocale } from '@shared/i18n';
import { IPC_CHANNELS } from '@shared/types';
import type { RendererAgentEvent } from '@shared/types/agent';
import { BrowserWindow, Notification } from 'electron';
import { readSettings } from '../ipc/settings';

const locale = (): Locale => {
  const state = (readSettings()?.['enso-settings'] as { state?: { language?: string } } | undefined)
    ?.state;
  return normalizeLocale(state?.language ?? 'zh');
};

const mainWindowFocused = (): boolean =>
  BrowserWindow.getAllWindows().some((win) => win.isFocused());

/** 点击通知：聚焦主窗口并让 renderer 切到对应会话 */
function focusSession(sessionId: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send(IPC_CHANNELS.NOTIFICATION_FOCUS_SESSION, sessionId);
}

function notify(sessionId: string, title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: false });
  notification.on('click', () => focusSession(sessionId));
  notification.show();
}

/**
 * 后台通知：仅主窗口未聚焦时,对待审批/轮完成/会话失败弹系统通知。
 * 挂在 main 的 agent 事件广播流上,与 renderer 转发互不影响。
 */
export function maybeNotify(event: RendererAgentEvent): void {
  if (mainWindowFocused()) return;
  const l = locale();
  switch (event.type) {
    case 'approval-request':
      notify(
        event.sessionId,
        getTranslation(l, 'Approval required'),
        `${event.request.tool} · ${event.request.summary.slice(0, 80)}`
      );
      return;
    case 'turn-completed':
      notify(
        event.sessionId,
        getTranslation(l, 'Turn completed'),
        getTranslation(l, 'The agent finished and is waiting for you.')
      );
      return;
    case 'status':
      if (event.status === 'failed' && event.error) {
        notify(event.sessionId, getTranslation(l, 'Session failed'), event.error.slice(0, 100));
      }
      return;
    default:
      return;
  }
}
