import { ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import type { RestartWaitReason } from '@shared/types/ipc';
import { isMainRenderer } from '../services/renderers';
import { sendToWindow } from '../windows/createAppWindow';
import { getMainWindow } from '../windows/MainWindow';

/** 菜单「重启」在等命令结束：主窗口开 / 关等待弹层，并说明在等哪种命令 */
export function notifyRestartWaiting(waiting: boolean, reason?: RestartWaitReason): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed())
    sendToWindow(
      win,
      IPC_CHANNELS.APP_RESTART_WAITING,
      waiting,
      waiting ? (reason ?? 'tool') : undefined
    );
}

/** 等待弹层的「强制退出」：只认主窗口 */
export function registerAppRestartHandlers(forceQuit: () => void): void {
  ipcMain.on(IPC_CHANNELS.APP_RESTART_FORCE, (event) => {
    if (isMainRenderer(event.sender.id)) forceQuit();
  });
}
