import path from 'node:path';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow } from 'electron';

import { registerIpcHandlers } from './ipc';
import { startAgentWorker } from './services/agentHost';
import { createMainWindow, getMainWindow } from './windows/MainWindow';

// 仅开发环境开放 CDP 端口，便于调试；打包后不开，避免暴露远程调试
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

// 打包版 productName=EnsoCode 会把 userData 指到新目录，与 dev（enso-code）分家；
// 统一到 enso-code，保证打包版接上既有会话与设置
app.setPath('userData', path.join(app.getPath('appData'), 'enso-code'));

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
    startAgentWorker();
    createMainWindow();

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
