import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';

/** Linux deb/rpm 上不加载 electron-updater(某些系统会触发 GTK 崩溃);AppImage 正常 */
function isUpdaterEnabled(): boolean {
  return !(process.platform === 'linux' && !process.env.APPIMAGE);
}

export function registerUpdaterHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.UPDATER_CHECK, async () => {
    if (!isUpdaterEnabled()) return;
    const { autoUpdaterService } = await import('../services/updater/AutoUpdater');
    await autoUpdaterService.checkForUpdates();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATER_DOWNLOAD_UPDATE, async () => {
    if (!isUpdaterEnabled()) return;
    const { autoUpdaterService } = await import('../services/updater/AutoUpdater');
    await autoUpdaterService.downloadUpdate();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATER_QUIT_AND_INSTALL, async () => {
    if (!isUpdaterEnabled()) return;
    const { autoUpdaterService } = await import('../services/updater/AutoUpdater');
    autoUpdaterService.quitAndInstall();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATER_SET_AUTO_UPDATE_ENABLED, async (_event, enabled: unknown) => {
    if (!isUpdaterEnabled() || typeof enabled !== 'boolean') return;
    const { autoUpdaterService } = await import('../services/updater/AutoUpdater');
    autoUpdaterService.setAutoUpdateEnabled(enabled);
  });
}
