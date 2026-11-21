import { app, ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import { isAutoRestartMode, resolveAutoRestartMode } from '@shared/updater/idleRestart';
import { readSettings } from '../../main/ipc/settings';
import { allowRemoteHostControl } from '../../main/services/remoteRenderer';
import { broadcastToRenderers } from '../../main/services/renderers';
import { currentIdleRestartObservation } from '../../main/services/updater/idleRestartSnapshot';
import { globalNpmInstaller } from './npm';
import { ServerUpdater } from './serverUpdater';
import { NPM_PACKAGE } from './version';

/** 服务端用同一组 updater:* 通道实现自更新与重启，并开放给已配对的浏览器 */
export function registerServerUpdater(): ServerUpdater {
  const updater = new ServerUpdater({
    version: app.getVersion(),
    packageName: NPM_PACKAGE,
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    npm: globalNpmInstaller(app.getAppPath()),
    broadcast: (status) => broadcastToRenderers(IPC_CHANNELS.UPDATER_STATUS, status),
    quit: () => app.quit(),
    idle: () => currentIdleRestartObservation(),
  });
  ipcMain.handle(IPC_CHANNELS.UPDATER_GET_STATE, () => updater.state());
  ipcMain.handle(IPC_CHANNELS.UPDATER_CHECK, () => updater.checkForUpdates());
  ipcMain.handle(IPC_CHANNELS.UPDATER_DOWNLOAD_UPDATE, () => updater.downloadUpdate());
  ipcMain.handle(IPC_CHANNELS.UPDATER_QUIT_AND_INSTALL, () => updater.quitAndInstall());
  ipcMain.handle(IPC_CHANNELS.UPDATER_RESTART, () => updater.restart());
  ipcMain.handle(IPC_CHANNELS.UPDATER_SET_AUTO_UPDATE_ENABLED, (_event, enabled: unknown) => {
    if (typeof enabled === 'boolean') updater.setAutoUpdateEnabled(enabled);
  });
  ipcMain.handle(IPC_CHANNELS.UPDATER_SET_AUTO_RESTART_MODE, (_event, mode: unknown) => {
    if (isAutoRestartMode(mode)) updater.setAutoRestartMode(mode);
  });
  allowRemoteHostControl();

  const state = (
    readSettings()?.['enso-settings'] as { state?: Record<string, unknown> } | undefined
  )?.state;
  updater.start(state?.autoUpdate !== false, resolveAutoRestartMode(state));
  app.on('before-quit', () => updater.stop());
  return updater;
}
