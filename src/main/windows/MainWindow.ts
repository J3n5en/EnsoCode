import { app, type BrowserWindow } from 'electron';
import { attachAppCloseConfirm } from '../services/appCloseConfirm';
import { switchNode } from '../services/nodeRemote';
import { isRemoteMainSender } from '../services/remoteRenderer/senders';
import { createAppWindow, getWindowWebContents, sendToWindow } from './createAppWindow';

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
  mainWindow = createAppWindow({
    entry: 'index',
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    stateFile: 'window-state.json',
    pinWorkbenchView: true,
  });

  // 关窗一律问退出还是进托盘。before-quit 只在打包版拦：dev 下 Ctrl+C 会变成
  // app.quit()，拦了会卡在确认框上变孤儿。
  attachAppCloseConfirm(
    mainWindow,
    (channel, ...args) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      // 确认框画在本机界面里：盖着远程节点时先切回本机
      switchNode('local');
      sendToWindow(mainWindow, channel, ...args);
    },
    () => getWindowWebContents(mainWindow as BrowserWindow),
    {
      interceptBeforeQuit: app.isPackaged,
      onTray: () => import('../services/appServerMode').then((mod) => mod.enterServerMode()),
    }
  );

  mainWindow.on('closed', () => {
    mainWindow = null;
    refreshRemoteLeadership();
  });
  refreshRemoteLeadership();

  return mainWindow;
}

function refreshRemoteLeadership(): void {
  void import('../services/remoteRenderer')
    .then((mod) => mod.refreshRemoteLeadership())
    .catch(() => {});
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function isMainWindowAlive(): boolean {
  return Boolean(mainWindow && !mainWindow.isDestroyed());
}

/** 远程浏览器里的主界面 renderer 与桌面主窗口同权 */
export function isMainWebContents(webContentsId: number): boolean {
  if (isRemoteMainSender(webContentsId)) return true;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const contents = getWindowWebContents(mainWindow);
  return !contents.isDestroyed() && contents.id === webContentsId;
}

/** 唤起主窗口的都是本机意图（本机通知、打开文件夹、秘书、投放架等），盖着远程节点时切回本机 */
export function focusMainWindow(): BrowserWindow {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  switchNode('local');
  return window;
}
