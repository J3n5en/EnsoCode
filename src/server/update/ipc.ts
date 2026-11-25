import { app, ipcMain } from '@platform';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { isUpdateChannel } from '@shared/updater/channel';
import { isAutoRestartMode, resolveAutoRestartMode } from '@shared/updater/idleRestart';
import { agentSessionIndex } from '../../main/ipc/sessionIndex';
import { patchSettingsState, readSettings } from '../../main/ipc/settings';
import { allowRemoteHostControl } from '../../main/services/remoteRenderer';
import { broadcastToRenderers } from '../../main/services/renderers';
import { globalNpmInstaller } from './npm';
import { clearPendingUpdate, writePendingUpdate } from './pendingUpdate';
import { spawnReexec } from './reexec';
import { ServerUpdater } from './serverUpdater';
import { NPM_PACKAGE } from './version';

/** 服务端用同一组 updater:* 通道实现自更新与重启，并开放给已配对的浏览器 */
export function registerServerUpdater(): ServerUpdater {
  const dataDir = app.getPath('userData');
  const updater = new ServerUpdater({
    version: app.getVersion(),
    packageName: NPM_PACKAGE,
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    npm: globalNpmInstaller(app.getAppPath()),
    broadcast: (status) => broadcastToRenderers(IPC_CHANNELS.UPDATER_STATUS, status),
    quit: () => app.quit(),
    busyCount: () => agentSessionIndex.busyWorkspaceCount(),
    spawnReexec: () => spawnReexec(dataDir),
    writePending: (update) => writePendingUpdate(dataDir, { ...update, at: Date.now() }),
    clearPending: () => clearPendingUpdate(dataDir),
  });
  ipcMain.handle(IPC_CHANNELS.UPDATER_GET_STATE, () => updater.state());
  ipcMain.handle(IPC_CHANNELS.UPDATER_CHECK, () => updater.checkForUpdates());
  ipcMain.handle(IPC_CHANNELS.UPDATER_DOWNLOAD_UPDATE, () => updater.downloadUpdate());
  ipcMain.handle(IPC_CHANNELS.UPDATER_QUIT_AND_INSTALL, () => updater.quitAndInstall());
  ipcMain.handle(IPC_CHANNELS.UPDATER_RESTART, (_event, force: unknown) =>
    updater.restart(force === true)
  );
  ipcMain.handle(IPC_CHANNELS.UPDATER_SET_AUTO_UPDATE_ENABLED, (_event, enabled: unknown) => {
    if (typeof enabled === 'boolean') updater.setAutoUpdateEnabled(enabled);
  });
  ipcMain.handle(IPC_CHANNELS.UPDATER_SET_AUTO_RESTART_MODE, (_event, mode: unknown) => {
    if (isAutoRestartMode(mode)) updater.setAutoRestartMode(mode);
  });
  ipcMain.handle(IPC_CHANNELS.UPDATER_SET_CHANNEL, (_event, channel: unknown) => {
    if (!isUpdateChannel(channel)) return;
    updater.setChannel(channel);
    // 渠道是自己的设置项：在这里也落一份，即使渲染层落盘失败，重启后仍是所选渠道
    patchSettingsState('updateChannel', channel);
  });
  allowRemoteHostControl();

  const state = (
    readSettings()?.['enso-settings'] as { state?: Record<string, unknown> } | undefined
  )?.state;
  if (isUpdateChannel(state?.updateChannel)) updater.setChannel(state.updateChannel);
  updater.start(state?.autoUpdate !== false, resolveAutoRestartMode(state));
  app.on('before-quit', () => updater.stop());
  return updater;
}
