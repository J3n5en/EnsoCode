import { randomUUID } from 'node:crypto';
import { parseAppCloseResponse, shouldBypassCloseConfirm } from '@shared/appClose';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { app, ipcMain, type WebContents } from 'electron';
import { presentWindow } from '../windows/verifyLaunch';
import { autoUpdaterService } from './updater/AutoUpdater';

const CLOSE_RESPONSE_TIMEOUT_MS = 30_000;

export interface AppCloseConfirmHost {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  on(event: 'close', listener: (event: Electron.Event) => void): void;
  once(event: 'closed', listener: () => void): void;
  removeListener(event: 'closed', listener: () => void): void;
}

let allowQuit = false;
let bypassDestroy = false;
let beforeConfirmedQuit: (() => Promise<void>) | null = null;

export function allowAppQuit(): void {
  allowQuit = true;
}

/**
 * 关窗确认里选了「退出」、窗口还在时先跑：等 agent 到安全点（有命令在跑主窗口弹等待层）。
 * 放在这里而不是 will-quit：那时窗口已关，弹层没处显示。
 */
export function setBeforeConfirmedQuit(hook: (() => Promise<void>) | null): void {
  beforeConfirmedQuit = hook;
}

/**
 * 在 destroy 回调执行期间放行关窗确认，返回前复位。destroy() 不派发 close，提前置位或销毁后
 * 不复位的放行标志会留给之后的新主窗口，第一次关窗 / Cmd+Q 就不再确认直接退出。
 */
export function destroyWithoutCloseConfirm(destroy: () => void): void {
  bypassDestroy = true;
  try {
    destroy();
  } finally {
    bypassDestroy = false;
  }
}

export function attachAppCloseConfirm(
  win: AppCloseConfirmHost,
  send: (channel: string, ...args: unknown[]) => void,
  contentsOf: () => WebContents,
  options: {
    interceptBeforeQuit: boolean;
    onTray: () => void | Promise<void>;
  }
): void {
  let flowInProgress = false;

  const askRenderer = (): Promise<'cancel' | 'quit' | 'tray'> => {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      let settled = false;
      const finalize = (value: 'cancel' | 'quit' | 'tray') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ipcMain.removeListener(IPC_CHANNELS.APP_CLOSE_RESPONSE, onResponse);
        try {
          win.removeListener('closed', gone);
        } catch {
          /* 窗口已销毁 */
        }
        try {
          contentsOf().removeListener('destroyed', gone);
        } catch {
          /* contents 已销毁 */
        }
        resolve(value);
      };
      const gone = () => finalize('cancel');
      const onResponse = (event: Electron.IpcMainEvent, incomingId: unknown, payload: unknown) => {
        if (event.sender !== contentsOf()) return;
        const parsed = parseAppCloseResponse(requestId, incomingId, payload);
        if (!parsed) return;
        finalize(parsed.action);
      };
      const timer = setTimeout(() => finalize('cancel'), CLOSE_RESPONSE_TIMEOUT_MS);
      ipcMain.on(IPC_CHANNELS.APP_CLOSE_RESPONSE, onResponse);
      win.once('closed', gone);
      contentsOf().once('destroyed', gone);
      send(IPC_CHANNELS.APP_CLOSE_REQUEST, requestId);
    });
  };

  const beginConfirm = async () => {
    if (flowInProgress) return;
    flowInProgress = true;
    try {
      if (win.isDestroyed() || contentsOf().isDestroyed()) return;
      presentWindow(win);
      const action = await askRenderer();
      if (action === 'cancel') return;
      if (action === 'tray') {
        flowInProgress = false;
        await options.onTray();
        return;
      }
      // 等命令期间保持 flowInProgress：再按 Cmd+Q / 关窗不重复弹确认
      try {
        await beforeConfirmedQuit?.();
      } catch (error) {
        console.error('[app-close] 退出前等命令失败，照常退出:', error);
      }
      allowQuit = true;
      app.quit();
    } finally {
      flowInProgress = false;
    }
  };

  const shouldPass = () => {
    if (bypassDestroy) {
      bypassDestroy = false;
      return true;
    }
    return shouldBypassCloseConfirm({
      allowQuit,
      quittingForUpdate: autoUpdaterService.isQuittingForUpdate(),
    });
  };

  win.on('close', (event) => {
    if (shouldPass()) return;
    event.preventDefault();
    void beginConfirm();
  });

  const onBeforeQuit = (event: Electron.Event) => {
    if (shouldPass()) return;
    event.preventDefault();
    void beginConfirm();
  };
  const markQuitting = () => {
    allowQuit = true;
  };
  if (options.interceptBeforeQuit) app.on('before-quit', onBeforeQuit);
  else {
    // dev：不拦 before-quit（Ctrl+C），但要让随后的 window close 放行，否则确认框把进程卡住。
    app.on('before-quit', markQuitting);
  }
  win.once('closed', () => {
    if (options.interceptBeforeQuit) app.removeListener('before-quit', onBeforeQuit);
    else app.removeListener('before-quit', markQuitting);
  });
}
