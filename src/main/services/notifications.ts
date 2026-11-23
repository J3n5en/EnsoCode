import { join } from 'node:path';
import { shouldMuteCoworkerCompletionNotification } from '@shared/coworkerNotification';
import { shouldSilenceTurn } from '@shared/secretary/silence';
import type { RendererAgentEvent } from '@shared/types/agent';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { app, BrowserWindow, type Notification } from 'electron';
import { showSystemNotification } from '../desktop/systemNotification';
import { readSettings } from '../ipc/settings';
import { getWindowWebContents, sendToWindow } from '../windows/createAppWindow';
import { ApprovalNotificationGate } from './approvalNotificationGate';
import { sendToRemoteRenderers } from './remoteRenderer/senders';
import { isSessionMuted } from './sessionMuteGate';

const approvalNotifications = new ApprovalNotificationGate();

/** 持有已弹出的通知：对象被 GC 后 macOS 点击只会激活 app，不再触发 click */
const liveNotifications = new Set<Notification>();
const MAX_LIVE_NOTIFICATIONS = 100;

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

/** 通知标题带上会话名，多会话时能分辨是哪条对话 */
function conversationLabel(sessionId: string): string {
  const store = readSettings()?.['enso-conversations'] as
    | { state?: { conversations?: Record<string, { title?: unknown }> } }
    | undefined;
  const conversations = store?.state?.conversations;
  const own = conversations?.[sessionId]?.title;
  if (typeof own === 'string' && own.trim()) return own.trim();
  const parentId = sessionId.split('::')[0];
  if (parentId === sessionId) return '';
  const parent = conversations?.[parentId]?.title;
  return typeof parent === 'string' ? parent.trim() : '';
}

function eventTitle(sessionId: string, kind: string): string {
  const name = conversationLabel(sessionId);
  return name ? `${name} · ${kind}` : kind;
}

import { readNotifyMainAgentOnly } from './notifyPolicy';

export { readNotifyMainAgentOnly };

const mainWindowFocused = (): boolean =>
  BrowserWindow.getAllWindows().some((win) => win.isFocused());

/** renderer 上报的「当前正在查看的会话」（tab 生效时为 tab 的 session id） */
let viewedSessionId: string | null = null;
/** 主窗口盖着远程节点界面时，本机正在看的会话并不在眼前，不据此抑制 */
let localLayerVisible = true;

export function setViewedSession(sessionId: string | null): void {
  viewedSessionId = sessionId;
}

export function setLocalLayerVisible(visible: boolean): void {
  localLayerVisible = visible;
}

/** 用户正看着本机界面：主窗口聚焦且没被远程节点界面盖住 */
async function localUiInFront(): Promise<boolean> {
  const { getMainWindow } = await import('../windows/MainWindow');
  return localLayerVisible && getMainWindow()?.isFocused() === true;
}

/** 点击通知：聚焦（托盘模式下重建）主窗口，renderer 加载完再切到对应会话 */
async function focusSession(sessionId: string): Promise<void> {
  const { focusMainWindow } = await import('../windows/MainWindow');
  const win = focusMainWindow();
  const send = () => sendToWindow(win, IPC_CHANNELS.NOTIFICATION_FOCUS_SESSION, sessionId);
  const contents = getWindowWebContents(win);
  if (contents.isLoading()) contents.once('did-finish-load', send);
  else send();
}

function notify(
  sessionId: string,
  title: string,
  body: string,
  onClick: () => void = () => void focusSession(sessionId),
  icon?: string
): void {
  // 未打包的 mac 走 osascript：无点击跳转，但至少可见（Electron 的 'failed' 事件只在 Windows 上有）
  const notification = showSystemNotification({ title, body, icon, osascriptWhenUnsigned: true });
  if (!notification) return;
  const release = () => liveNotifications.delete(notification);
  notification.on('click', () => {
    release();
    onClick();
  });
  notification.on('close', release);
  liveNotifications.add(notification);
  if (liveNotifications.size > MAX_LIVE_NOTIFICATIONS) {
    liveNotifications.delete(liveNotifications.values().next().value as Notification);
  }
}

interface NotificationContent {
  sessionId: string;
  title: string;
  body: string;
}

/** 远程节点（对方桌面）转来的通知：标题带节点名，点击由调用方切到该节点 */
export function notifyFromNode(
  nodeLabel: string,
  content: NotificationContent,
  onClick: () => void
): void {
  const title = nodeLabel ? `${nodeLabel} · ${content.title}` : content.title;
  notify(content.sessionId, title, content.body, onClick);
}

export async function maybeNotifyBot(
  event: RendererAgentEvent,
  bot: { enabled: boolean; chatId: string | null; name: string; conversationId: string }
): Promise<void> {
  const isCurrent = approvalNotifications.observe(event);
  if (!isCurrent) return;
  if (!bot.enabled) return;
  if (event.type !== 'approval-request' && event.type !== 'ask-request') return;
  if (event.type === 'ask-request' && event.ask.relay) return;
  if (isSessionMuted(event.identity.sessionId)) return;
  const { focusMainWindow } = await import('../windows/MainWindow');
  const inFront = await localUiInFront();
  if (!isCurrent()) return;
  if (inFront) return;
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
  const { focusMainWindow } = await import('../windows/MainWindow');
  if (await localUiInFront()) return;
  const { title, body } = build(texts() === TEXTS.zh ? 'zh' : 'en');
  notify(`bot-chat:${chatId}`, title, body, () => {
    sendToWindow(focusMainWindow(), IPC_CHANNELS.BOT_EVENT, { kind: 'open', chatId });
  });
}

/** 秘书的派出结果通知：主窗口聚焦时不弹，点击只把主窗口拉回前台 */
export async function notifySecretary(
  build: (lang: 'zh' | 'en') => { title: string; body: string },
  /** 发通知的秘书目录：图标用它的头像；缺省是迁移出的 default 秘书 */
  dir?: string
): Promise<void> {
  const { focusMainWindow } = await import('../windows/MainWindow');
  if (await localUiInFront()) return;
  const { title, body } = build(texts() === TEXTS.zh ? 'zh' : 'en');
  notify(
    'secretary',
    title,
    body,
    () => void focusMainWindow(),
    await secretaryNotificationIcon(dir)
  );
}

async function secretaryNotificationIcon(dir: string | undefined): Promise<string | undefined> {
  try {
    const { SecretaryStore } = await import('./secretary/store');
    return (
      new SecretaryStore(dir ?? join(app.getPath('userData'), 'secretary')).avatarPath() ??
      undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * 后台通知：对待审批/轮完成/会话失败弹系统通知。
 * 仅当「主窗口聚焦且用户正看着事件所属会话」时抑制——看别的会话/设置页照弹。
 * 同时转给以远程节点方式连来的桌面主界面，由它所在的电脑按自己的可见层决定是否弹。
 * 挂在 main 的 agent 事件广播流上,与 renderer 转发互不影响。
 */
export function maybeNotify(event: RendererAgentEvent): void {
  if (!approvalNotifications.observe(event)) return;
  const sessionId = (event as { identity?: { sessionId?: string } }).identity?.sessionId;
  if (sessionId && isSessionMuted(sessionId)) return;
  if (shouldMuteCoworkerCompletionNotification(event, readNotifyMainAgentOnly())) return;
  const content = notificationContent(event);
  if (!content) return;
  sendToRemoteRenderers(IPC_CHANNELS.NOTIFICATION_SHOW, [content], undefined, 'settings');
  if (localLayerVisible && mainWindowFocused() && content.sessionId === viewedSessionId) return;
  notify(content.sessionId, content.title, content.body);
}

function notificationContent(event: RendererAgentEvent): NotificationContent | null {
  const t = texts();
  switch (event.type) {
    case 'ask-request':
      // 转给秘书的提问不弹给用户：秘书会答，用户也可以在那个会话里自己答
      if (event.ask.relay) return null;
      // agent 在等答复才能继续,不提醒会静默卡住整个会话
      return {
        sessionId: event.identity.sessionId,
        title: eventTitle(event.identity.sessionId, t.ask),
        body: event.ask.question.slice(0, 100),
      };
    case 'approval-request':
      return {
        sessionId: event.identity.sessionId,
        title: eventTitle(event.identity.sessionId, t.approval),
        body: `${event.request.tool} · ${event.request.summary.slice(0, 80)}`,
      };
    case 'turn-completed':
      if (
        event.silent === true ||
        (event.digest && shouldSilenceTurn(event.digest.userText, event.digest.assistantText))
      ) {
        return null;
      }
      return {
        sessionId: event.identity.sessionId,
        title: eventTitle(event.identity.sessionId, t.turnDone),
        body: t.turnDoneBody,
      };
    case 'status':
      if (event.status !== 'failed' || !event.error) return null;
      return {
        sessionId: event.identity.sessionId,
        title: eventTitle(event.identity.sessionId, t.failed),
        body: event.error.slice(0, 100),
      };
    default:
      return null;
  }
}
