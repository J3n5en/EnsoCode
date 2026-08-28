import path from 'node:path';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow } from 'electron';

import { registerIpcHandlers } from './ipc';
import { readSettings } from './ipc/settings';
import { startAgentWorker } from './services/agentHost';
import { createMainWindow, getMainWindow } from './windows/MainWindow';

// 仅开发环境开放 CDP 端口，便于调试；打包后不开，避免暴露远程调试
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

// 自动化可在开发环境显式隔离 userData；打包版永不接受环境覆盖。
// 普通 dev/生产继续统一到 appData/enso-code，保证既有会话与设置不迁移。
const developmentUserData = !app.isPackaged ? process.env.ENSO_USER_DATA_DIR?.trim() : undefined;
app.setPath(
  'userData',
  developmentUserData
    ? path.resolve(developmentUserData)
    : path.join(app.getPath('appData'), 'enso-code')
);

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.j3n5en.enso-code');

    // dev 下 dock 显示 Electron 默认图标；手动设为 app 图标（打包由 electron-builder 处理）
    if (!app.isPackaged && process.platform === 'darwin') {
      app.dock?.setIcon(path.join(app.getAppPath(), 'build', 'icon.png'));
    }

    // Default open/close DevTools by F12 in development
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    registerIpcHandlers();
    // UI shell 必须先创建并发起加载；Agent worker 初始化变重时不得阻塞 renderer spawn。
    const mainWindow = createMainWindow();
    setImmediate(() => startAgentWorker());
    void initAutoUpdater(mainWindow);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

/** 打包环境下启动自动更新(dev 无 app-update.yml,electron-updater 会报错;Linux deb 由 IPC 层守卫) */
async function initAutoUpdater(window: BrowserWindow): Promise<void> {
  if (!app.isPackaged) return;
  if (process.platform === 'linux' && !process.env.APPIMAGE) return;
  // 读持久化设置里的 autoUpdate(zustand persist 形状:{ state: {...} });缺省 true
  const persisted = readSettings()?.['enso-settings'] as
    | { state?: { autoUpdate?: boolean } }
    | undefined;
  const autoUpdate = persisted?.state?.autoUpdate ?? true;
  const { autoUpdaterService } = await import('./services/updater/AutoUpdater');
  autoUpdaterService.init(window, autoUpdate);
}
