import { IPC_CHANNELS } from '@shared/types/ipc';
import type { UpdaterState } from '@shared/types/updater';
import { isUpdateChannel } from '@shared/updater/channel';
import { isAutoRestartMode } from '@shared/updater/idleRestart';
import { app, ipcMain } from 'electron';
import { discardLegacyInterruptedSessions } from '../services/updater/interruptedSessions';

/** Linux deb/rpm 上不加载 electron-updater(某些系统会触发 GTK 崩溃);AppImage 正常 */
function isUpdaterEnabled(): boolean {
  return !(process.platform === 'linux' && !process.env.APPIMAGE);
}

export function registerUpdaterHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.UPDATER_GET_STATE,
    (): UpdaterState => ({ host: 'desktop', status: null })
  );

  try {
    discardLegacyInterruptedSessions(app.getPath('userData'));
  } catch (error) {
    console.error('Failed to discard legacy interrupted-by-update record:', error);
  }

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
    return autoUpdaterService.requestRestart();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATER_SET_AUTO_UPDATE_ENABLED, async (_event, enabled: unknown) => {
    if (!isUpdaterEnabled() || typeof enabled !== 'boolean') return;
    const { autoUpdaterService } = await import('../services/updater/AutoUpdater');
    autoUpdaterService.setAutoUpdateEnabled(enabled);
  });

  ipcMain.handle(IPC_CHANNELS.UPDATER_SET_AUTO_RESTART_MODE, async (_event, mode: unknown) => {
    if (!isUpdaterEnabled() || !isAutoRestartMode(mode)) return;
    const { autoUpdaterService } = await import('../services/updater/AutoUpdater');
    autoUpdaterService.setAutoRestartMode(mode);
  });

  ipcMain.handle(IPC_CHANNELS.UPDATER_SET_CHANNEL, async (_event, channel: unknown) => {
    if (!isUpdaterEnabled() || !isUpdateChannel(channel)) return;
    const { autoUpdaterService } = await import('../services/updater/AutoUpdater');
    autoUpdaterService.setChannel(channel);
  });
}
