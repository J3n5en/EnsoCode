import { IPC_CHANNELS } from '@shared/types';
import type { UpdaterState } from '@shared/types/updater';
import { app, ipcMain } from 'electron';
import { takeInterruptedSessions } from '../services/updater/interruptedSessions';

/** Linux deb/rpm 上不加载 electron-updater(某些系统会触发 GTK 崩溃);AppImage 正常 */
function isUpdaterEnabled(): boolean {
  return !(process.platform === 'linux' && !process.env.APPIMAGE);
}

export function registerUpdaterHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.UPDATER_GET_STATE,
    (): UpdaterState => ({ host: 'desktop', status: null })
  );

  ipcMain.handle(IPC_CHANNELS.UPDATER_TAKE_INTERRUPTED_SESSIONS, (): string[] =>
    takeInterruptedSessions(app.getPath('userData'))
  );

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

  ipcMain.handle(IPC_CHANNELS.UPDATER_QUIT_AND_INSTALL, async (_event, options: unknown) => {
    if (!isUpdaterEnabled()) return;
    const now =
      typeof options === 'object' &&
      options !== null &&
      (options as { now?: unknown }).now === true;
    const { autoUpdaterService } = await import('../services/updater/AutoUpdater');
    autoUpdaterService.requestRestart(now);
  });

  ipcMain.handle(IPC_CHANNELS.UPDATER_CANCEL_RESTART, async () => {
    if (!isUpdaterEnabled()) return;
    const { autoUpdaterService } = await import('../services/updater/AutoUpdater');
    autoUpdaterService.cancelRestart();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATER_SET_AUTO_UPDATE_ENABLED, async (_event, enabled: unknown) => {
    if (!isUpdaterEnabled() || typeof enabled !== 'boolean') return;
    const { autoUpdaterService } = await import('../services/updater/AutoUpdater');
    autoUpdaterService.setAutoUpdateEnabled(enabled);
  });

  ipcMain.handle(
    IPC_CHANNELS.UPDATER_SET_AUTO_RESTART_WHEN_IDLE,
    async (_event, enabled: unknown) => {
      if (!isUpdaterEnabled() || typeof enabled !== 'boolean') return;
      const { autoUpdaterService } = await import('../services/updater/AutoUpdater');
      autoUpdaterService.setAutoRestartWhenIdle(enabled);
    }
  );
}
