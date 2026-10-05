import { execFile } from 'node:child_process';
import { shouldMuteCoworkerCompletionNotification } from '@shared/coworkerNotification';
import { IPC_CHANNELS } from '@shared/types';
import type { RendererAgentEvent } from '@shared/types/agent';
import { app, BrowserWindow, Notification } from 'electron';
import { readSettings } from '../ipc/settings';
import { sendToWindow } from '../windows/createAppWindow';

// 文案本地内联：main 段引入 @shared/i18n 会触发 rollup 多入口 chunk 异常
// （index.js 被打成 0 字节空产物），故不走共享 i18n
const TEXTS = {
  zh: {
    ask: '等你回答',
    approval: '需要审批',
    turnDone: '回复完成',
    turnDoneBody: 'agent 已完成,等你查看。',
    failed: '会话失败',
  },
  en: {
    ask: 'Question for you',
    approval: 'Approval required',
    turnDone: 'Turn completed',
    turnDoneBody: 'The agent finished and is waiting for you.',
    failed: 'Session failed',
  },
} as const;

const settingsState = (): { language?: string; notifyMainAgentOnly?: boolean } => {
  const state = (
    readSettings()?.['enso-settings'] as
      | { state?: { language?: string; notifyMainAgentOnly?: boolean } }
      | undefined
  )?.state;
  return state ?? {};
};

const texts = (): Record<keyof (typeof TEXTS)['zh'], string> =>
  (settingsState().language ?? 'zh').toLowerCase().startsWith('zh') ? TEXTS.zh : TEXTS.en;

/** 缺省 true：只为主 agent 弹完成/失败通知 */
export function readNotifyMainAgentOnly(): boolean {
  return settingsState().notifyMainAgentOnly !== false;
}

const mainWindowFocused = (): boolean =>
  BrowserWindow.getAllWindows().some((win) => win.isFocused());

/** renderer 上报的「当前正在查看的会话」（tab 生效时为 tab 的 session id） */
let viewedSessionId: string | null = null;

export function setViewedSession(sessionId: string | null): void {
  viewedSessionId = sessionId;
}

/** 点击通知：聚焦主窗口并让 renderer 切到对应会话 */
function focusSession(sessionId: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  sendToWindow(win, IPC_CHANNELS.NOTIFICATION_FOCUS_SESSION, sessionId);
}

function notify(
  sessionId: string,
  title: string,
  body: string,
  onClick = () => focusSession(sessionId)
): void {
  // macOS 未打包（未签名）app 的原生通知会被 UNUserNotificationCenter 静默丢弃，
  // 且 Electron 的 'failed' 事件是 Windows-only 兜不住——直接走 osascript
  // （无点击跳转，但至少可见；打包签名后走原生路径）
  if (process.platform === 'darwin' && !app.isPackaged) {
    const safeBody = body.replace(/[\\"]/g, ' ');
    const safeTitle = title.replace(/[\\"]/g, ' ');
    execFile('osascript', ['-e', `display notification "${safeBody}" with title "${safeTitle}"`]);
    return;
  }
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: false });
  notification.on('click', onClick);
  notification.show();
}

export async function maybeNotifyBot(
  event: RendererAgentEvent,
  bot: { enabled: boolean; chatId: string | null; name: string; conversationId: string }
): Promise<void> {
  if (!bot.enabled) return;
  if (event.type !== 'approval-request' && event.type !== 'ask-request') return;
  const { focusMainWindow, getMainWindow } = await import('../windows/MainWindow');
  if (getMainWindow()?.isFocused()) return;
  const title = `${bot.name} · ${event.type === 'ask-request' ? texts().ask : texts().approval}`;
  const body =
    event.type === 'ask-request'
      ? event.ask.question
      : `${event.request.tool} · ${event.request.summary}`;
  notify(event.identity.sessionId, title, body.slice(0, 100), () => {
    const win = focusMainWindow();
    sendToWindow(win, IPC_CHANNELS.BOT_EVENT, {
      kind: 'open',
      ...(bot.chatId ? { chatId: bot.chatId } : {}),
      conversationId: bot.conversationId,
    });
  });
}

/** Bot 聊天的回合 / 接力批次 / 稍后提醒通知：主窗口聚焦时不弹，点击切到 Bot 模式打开该聊天 */
export async function notifyBotChat(
  chatId: string,
  build: (lang: 'zh' | 'en') => { title: string; body: string }
): Promise<void> {
  const { focusMainWindow, getMainWindow } = await import('../windows/MainWindow');
  if (getMainWindow()?.isFocused()) return;
  const { title, body } = build(texts() === TEXTS.zh ? 'zh' : 'en');
  notify(`bot-chat:${chatId}`, title, body, () => {
    sendToWindow(focusMainWindow(), IPC_CHANNELS.BOT_EVENT, { kind: 'open', chatId });
  });
}

/**
 * 后台通知：对待审批/轮完成/会话失败弹系统通知。
 * 仅当「主窗口聚焦且用户正看着事件所属会话」时抑制——看别的会话/设置页照弹。
 * 挂在 main 的 agent 事件广播流上,与 renderer 转发互不影响。
 */
export function maybeNotify(event: RendererAgentEvent): void {
  const sessionId = (event as { identity?: { sessionId?: string } }).identity?.sessionId;
  if (mainWindowFocused() && sessionId !== undefined && sessionId === viewedSessionId) return;
  if (shouldMuteCoworkerCompletionNotification(event, readNotifyMainAgentOnly())) return;
  const t = texts();
  switch (event.type) {
    case 'ask-request':
      // agent 在等答复才能继续,不提醒会静默卡住整个会话
      notify(event.identity.sessionId, t.ask, event.ask.question.slice(0, 100));
      return;
    case 'approval-request':
      notify(
        event.identity.sessionId,
        t.approval,
        `${event.request.tool} · ${event.request.summary.slice(0, 80)}`
      );
      return;
    case 'turn-completed':
      notify(event.identity.sessionId, t.turnDone, t.turnDoneBody);
      return;
    case 'status':
      if (event.status === 'failed' && event.error) {
        notify(event.identity.sessionId, t.failed, event.error.slice(0, 100));
      }
      return;
    default:
      return;
  }
}
