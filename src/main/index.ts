import path from 'node:path';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow } from 'electron';

import { registerIpcHandlers } from './ipc';
import { readSettings } from './ipc/settings';
import { startAgentWorker } from './services/agentHost';
import {
  registerLocalImageProtocolHandler,
  registerLocalImageSchemePrivileges,
} from './services/localImageProtocol';
import { startPairHost, stopPairHost } from './services/pairHost';
import { createMainWindow, getMainWindow } from './windows/MainWindow';

// 仅开发环境开放 CDP 端口，便于调试；打包后不开，避免暴露远程调试
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

// 打包版 productName=EnsoCode 会把 userData 指到新目录，与 dev（enso-code）分家；
// 统一到 enso-code，保证打包版接上既有会话与设置
app.setPath('userData', path.join(app.getPath('appData'), 'enso-code'));

// 背景图媒体协议：特权 scheme 必须在 app ready 前登记
registerLocalImageSchemePrivileges();

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
    registerLocalImageProtocolHandler();
    startAgentWorker();
    // 手机第二屏：恢复已配对设备的中继连接（与 agent worker 并列，不依赖窗口）
    startPairHost();
    const mainWindow = createMainWindow();
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

  // Electron 退出即断开中继，手机侧收到 host-offline
  app.on('before-quit', () => {
    stopPairHost();
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
