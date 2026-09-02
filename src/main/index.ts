import path from 'node:path';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow } from 'electron';

import { registerIpcHandlers } from './ipc';
import { readSettings } from './ipc/settings';
import { startAgentWorker } from './services/agentHost';
import { browserHost } from './services/browserHost';
import {
  registerLocalImageProtocolHandler,
  registerLocalImageSchemePrivileges,
} from './services/localImageProtocol';
import { startPairGuest, stopPairGuest } from './services/pairGuest';
import { startPairHost, stopPairHost } from './services/pairHost';
import { hydrateShellPath, seedProcessPath } from './services/shellPath';
import { createMainWindow, getMainWindow } from './windows/MainWindow';

// 仅开发环境开放 CDP 端口，便于调试；打包后不开，避免暴露远程调试。
// 同机跑两以上实例（如验证节点互连）时可用 ENSO_CDP_PORT 错开。
if (!app.isPackaged) {
  const cdpPort = process.env.ENSO_CDP_PORT?.trim();
  app.commandLine.appendSwitch('remote-debugging-port', /^\d+$/.test(cdpPort ?? '') ? cdpPort! : '9222');
}

// 自动化可在开发环境显式指定 userData；打包版永不接受环境覆盖。
// dev 缺省隔离到 appData/enso-code-dev：与打包版彻底分离，避免单实例锁 /
// Chromium profile 锁冲突（对齐 EnsoAI 的 dev profile 方案）。
const developmentUserData = !app.isPackaged ? process.env.ENSO_USER_DATA_DIR?.trim() : undefined;
app.setPath(
  'userData',
  developmentUserData
    ? path.resolve(developmentUserData)
    : path.join(app.getPath('appData'), app.isPackaged ? 'enso-code' : 'enso-code-dev')
);

// 背景图媒体协议：特权 scheme 必须在 app ready 前登记
registerLocalImageSchemePrivileges();

// GUI 启动（Dock/Finder）继承 launchd 极简 PATH，pi 的 bash / MCP 子进程会
// 找不到 node/git。打包版立即前插保底目录；dev 从终端启动，环境本就完整。
if (app.isPackaged && process.platform !== 'win32') {
  seedProcessPath();
}

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
    // 协议处理器要赶在窗口加载内容之前注册（local-image:// 资源依赖它）。
    registerLocalImageProtocolHandler();
    // UI shell 必须先创建并发起加载；Agent worker 初始化变重时不得阻塞 renderer spawn。
    const mainWindow = createMainWindow();
    // 内嵌浏览器 guest view 挂主窗口（无头也要 viewport）；窗口重建后 getMainWindow 自动指向新窗
    browserHost.setHostWindow(getMainWindow);
    // 两个后台服务都不依赖窗口，同样延后，避免堵住首帧。
    setImmediate(() => {
      // worker 的 env 是 fork 时的快照：打包版先等登录 shell 探测出真实 PATH
      //（内置 10s 超时，典型远快于此；失败静默用 seed），再起 worker。
      if (app.isPackaged && process.platform !== 'win32') {
        void hydrateShellPath().finally(() => startAgentWorker());
      } else {
        startAgentWorker();
      }
      // 手机第二屏：恢复已配对设备的中继连接
      startPairHost();
      // 连接到节点：恢复到别的桌面的 guest 连接
      startPairGuest();
    });
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
    stopPairGuest();
    // 内嵌浏览器 Cookie / storage 落盘后再关 guest 页
    void browserHost.dispose();
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
