import { IPC_CHANNELS } from '@shared/types';
import type { RendererAgentEvent } from '@shared/types/agent';
import { BrowserWindow, Notification } from 'electron';
import { readSettings } from '../ipc/settings';

// 文案本地内联：main 段引入 @shared/i18n 会触发 rollup 多入口 chunk 异常
// （index.js 被打成 0 字节空产物），故不走共享 i18n
const TEXTS = {
  zh: {
    approval: '需要审批',
    turnDone: '回复完成',
    turnDoneBody: 'agent 已完成,等你查看。',
    failed: '会话失败',
  },
  en: {
    approval: 'Approval required',
    turnDone: 'Turn completed',
    turnDoneBody: 'The agent finished and is waiting for you.',
    failed: 'Session failed',
  },
} as const;

const texts = (): (typeof TEXTS)['zh'] => {
  const state = (readSettings()?.['enso-settings'] as { state?: { language?: string } } | undefined)
    ?.state;
  return (state?.language ?? 'zh').toLowerCase().startsWith('zh') ? TEXTS.zh : TEXTS.en;
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
  const t = texts();
  switch (event.type) {
    case 'approval-request':
      notify(
        event.sessionId,
        t.approval,
        `${event.request.tool} · ${event.request.summary.slice(0, 80)}`
      );
      return;
    case 'turn-completed':
      notify(event.sessionId, t.turnDone, t.turnDoneBody);
      return;
    case 'status':
      if (event.status === 'failed' && event.error) {
        notify(event.sessionId, t.failed, event.error.slice(0, 100));
      }
      return;
    default:
      return;
  }
}
