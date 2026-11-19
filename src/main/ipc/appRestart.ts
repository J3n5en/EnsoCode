import { ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import type { RestartOverlayState } from '@shared/types/ipc';
import { switchNode } from '../services/nodeRemote';
import { isMainRenderer, localMainContents } from '../services/renderers';
import { sendToWindow } from '../windows/createAppWindow';
import { getMainWindow } from '../windows/MainWindow';

let current: RestartOverlayState | null = null;

/**
 * 重启弹层只推给本机主窗口；主窗口还没加载好时记下，挂载时来取。
 * 开弹层时盖着远程节点就切回本机界面，弹层才看得见
 */
export function setRestartOverlay(next: RestartOverlayState | null): void {
  current = next;
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (next) switchNode('local');
  sendToWindow(win, IPC_CHANNELS.APP_RESTART_WAITING, next);
}

/** 只关自己那个阶段开的弹层：恢复结束 / 超时不能把随后点的重启弹层关掉 */
export function clearRestartOverlay(phase: RestartOverlayState['phase']): void {
  if (current?.phase === phase) setRestartOverlay(null);
}

/** 等待弹层的「强制退出」：只认主窗口；取弹层状态只回本机主窗口（节点页面 / 远程浏览器不显示） */
export function registerAppRestartHandlers(forceQuit: () => void): void {
  ipcMain.on(IPC_CHANNELS.APP_RESTART_FORCE, (event) => {
    if (isMainRenderer(event.sender.id)) forceQuit();
  });
  ipcMain.handle(IPC_CHANNELS.APP_RESTART_WAITING_GET, (event) =>
    localMainContents()?.id === event.sender.id ? current : null
  );
}
