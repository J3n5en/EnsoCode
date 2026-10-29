import path from 'node:path';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { app, type BrowserWindow } from 'electron';
import {
  registerLocalImageProtocolHandler,
  registerLocalImageSchemePrivileges,
} from './desktop/localImageScheme';
import { installDesktopLocalUi } from './desktop/localUi';
import { openBotPdfWindow, openDesktopPdfWindow } from './desktop/pdfWindow';
import { confirmRevealExternal } from './desktop/revealExternalConfirm';
import { registerIpcHandlers } from './ipc';
import { registerDesktopIpcHandlers } from './ipc/desktop';
import { consumeTrayReenterAfterUpdate, readSettings } from './ipc/settings';
import { agentWorkerAlive, startAgentWorker, stopAgentWorkerForQuit } from './services/agentHost';
import { installAppMenu } from './services/appMenu';
import { attachAppQuitDrain } from './services/appQuitDrain';
import {
  ensureTray,
  enterServerMode,
  isServerMode,
  leaveServerMode,
  restoreFromSecondInstance,
  scheduleReenterServerMode,
  shouldQuitOnWindowAllClosed,
} from './services/appServerMode';
import { browserHost } from './services/browserHost';
import { computerHost } from './services/computerHost';
import { installDesktopHooks } from './services/desktopHooks';
import { releaseLocalChatSlot } from './services/llama/chat';
import { disposeLlamaRuntime, llamaRuntimeActive } from './services/llama/runtime';
import {
  awaitMemoryEmbeddingClose,
  closeMemoryDb,
  syncMemoryDistillFromSettings,
  syncMemoryEmbeddingFromSettings,
  syncMemoryKgFromSettings,
} from './services/memoryHost';
import {
  maybeNotify,
  maybeNotifyBot,
  notifyBotChat,
  setViewedSession,
} from './services/notifications';
import { startPairGuest, stopPairGuest } from './services/pairGuest';
import { startPairHost, stopPairHost } from './services/pairHost';
import { getProxyConfig } from './services/proxyConfig';
import { setupRemoteRenderer } from './services/remoteRenderer';
import { hydrateShellPath, seedProcessPath } from './services/shellPath';
import { syncSpeechFromSettings } from './services/speech/service';
import { disposeAllTerminals, hasPendingPtys, waitPtyQuitIdle } from './services/terminalService';
import {
  setTrayToggleHandler,
  stopTrayToggleShortcut,
  syncTrayToggleShortcut,
} from './services/trayToggleShortcut';
import { createMainWindow, getMainWindow } from './windows/MainWindow';
import { applyWindowsChromiumSwitches } from './windows/win32Restore';
import { resolveWindowsAppUserModelId } from './windows/windowIcon';

// 仅开发环境开放 CDP 端口，便于调试；打包后不开，避免暴露远程调试。
// 同机跑两以上实例（如验证节点互连）时可用 ENSO_CDP_PORT 错开。
if (!app.isPackaged) {
  const cdpPort = process.env.ENSO_CDP_PORT?.trim();
  app.commandLine.appendSwitch(
    'remote-debugging-port',
    /^\d+$/.test(cdpPort ?? '') ? cdpPort! : '9222'
  );
}
applyWindowsChromiumSwitches(app.commandLine);

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
    restoreFromSecondInstance();
  });
  app.on('child-process-gone', (_event, details) => {
    console.error(
      `[process] child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode} serviceName=${details.serviceName ?? ''} name=${details.name ?? ''}`
    );
  });

  app.whenReady().then(() => {
    electronApp.setAppUserModelId(
      resolveWindowsAppUserModelId({
        execPath: process.execPath,
        isPackaged: app.isPackaged,
      })
    );

    // dev 下 dock 显示 Electron 默认图标；手动设为 app 图标（打包由 electron-builder 处理）
    if (!app.isPackaged && process.platform === 'darwin') {
      app.dock?.setIcon(path.join(app.getAppPath(), 'build', 'icon.png'));
    }
    installAppMenu();

    // Default open/close DevTools by F12 in development
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    // 先装 ipcMain 镜像表：远程浏览器 renderer 复用同一批 handler
    setupRemoteRenderer();
    installDesktopLocalUi();
    installDesktopHooks({
      session: {
        closeBrowser: (sessionId, options) => void browserHost.closeForSession(sessionId, options),
        releaseBrowserActor: (sessionId) => browserHost.releaseActor(sessionId),
        forgetBrowserActor: (sessionId) => browserHost.forgetActor(sessionId),
        closeComputer: (sessionId) => computerHost.close(sessionId),
        closeAllComputers: () => computerHost.closeAll(),
        invokeBrowser: (...args) => browserHost.invoke(...args),
        invokeComputer: (...args) => computerHost.invoke(...args),
      },
      bot: {
        closeBrowser: (key) => browserHost.closeSession(key),
        notifyChat: (chatId, build) => notifyBotChat(chatId, build),
      },
      notify: { maybeNotify, maybeNotifyBot, setViewedSession },
      file: {
        openPdf: openBotPdfWindow,
        openWorkspacePdf: openDesktopPdfWindow,
        confirmRevealExternal,
      },
      app: {
        updaterAvailable: () => !(process.platform === 'linux' && !process.env.APPIMAGE),
        checkForUpdates: async () => {
          const { autoUpdaterService } = await import('./services/updater/AutoUpdater');
          await autoUpdaterService.checkForUpdates();
        },
        downloadUpdate: async () => {
          const { autoUpdaterService } = await import('./services/updater/AutoUpdater');
          await autoUpdaterService.downloadUpdate();
        },
        syncTrayToggleShortcut,
      },
    });
    registerIpcHandlers();
    registerDesktopIpcHandlers();
    setTrayToggleHandler(() => {
      if (isServerMode()) leaveServerMode();
      else void enterServerMode();
    });
    // 协议处理器要赶在窗口加载内容之前注册（local-image:// 资源依赖它）。
    registerLocalImageProtocolHandler();
    const persisted = readSettings()?.['enso-settings'] as
      | { state?: { proxyMode?: unknown; customProxyUrl?: unknown; autoUpdate?: boolean } }
      | undefined;
    getProxyConfig().initFromConfig(persisted?.state?.proxyMode, persisted?.state?.customProxyUrl);
    const persistedState = (
      persisted?.state && typeof persisted.state === 'object' ? persisted.state : {}
    ) as Record<string, unknown>;
    syncTrayToggleShortcut(persistedState.keybindings);
    syncMemoryEmbeddingFromSettings(persistedState);
    syncMemoryDistillFromSettings(persistedState);
    syncMemoryKgFromSettings(persistedState);
    syncSpeechFromSettings(persistedState);
    // UI shell 必须先创建并发起加载；Agent worker 初始化变重时不得阻塞 renderer spawn。
    const mainWindow = createMainWindow();
    ensureTray();
    // 内嵌浏览器 guest view 挂主窗口（无头也要 viewport）；窗口重建后 getMainWindow 自动指向新窗
    browserHost.setHostWindow(getMainWindow);
    // 两个后台服务都不依赖窗口，同样延后，避免堵住首帧。
    setImmediate(() => {
      // worker 的 env 是 fork 时的快照：等系统代理解析后再 fork，
      // 打包版再等登录 shell 探测出真实 PATH。
      const ready = getProxyConfig().whenReady();
      if (app.isPackaged && process.platform !== 'win32') {
        void ready.finally(() => hydrateShellPath().finally(() => startAgentWorker()));
      } else {
        void ready.finally(() => startAgentWorker());
      }
      // 手机第二屏：恢复已配对设备的中继连接
      startPairHost();
      // 连接到节点：恢复到别的桌面的 guest 连接
      startPairGuest();
    });
    void initAutoUpdater(mainWindow);
    if (consumeTrayReenterAfterUpdate()) scheduleReenterServerMode();

    app.on('activate', () => {
      leaveServerMode();
    });
  });

  app.on('window-all-closed', () => {
    if (shouldQuitOnWindowAllClosed(process.platform)) app.quit();
  });

  // Electron 退出即断开中继，手机侧收到 host-offline
  app.on('before-quit', () => {
    stopTrayToggleShortcut();
    stopPairHost();
    stopPairGuest();
    // 内嵌浏览器 Cookie / storage 落盘后再关 guest 页
    void browserHost.dispose();
    computerHost.closeAll();
    closeMemoryDb();
  });
  // node-pty TSFN / llama AsyncWorker 在 FreeEnvironment 期间回调会 SIGABRT；
  // 两步必须共用一次 preventDefault，谁先 app.quit 都会拆掉另一边的环境。
  attachAppQuitDrain(app, [
    {
      begin: disposeAllTerminals,
      shouldWait: hasPendingPtys,
      wait: waitPtyQuitIdle,
    },
    {
      shouldWait: llamaRuntimeActive,
      wait: async () => {
        await awaitMemoryEmbeddingClose();
        await releaseLocalChatSlot();
        await disposeLlamaRuntime();
      },
    },
    {
      shouldWait: agentWorkerAlive,
      wait: () => stopAgentWorkerForQuit(3_000),
    },
  ]);
}

/** 打包环境下启动自动更新(dev 无 app-update.yml,electron-updater 会报错;Linux deb 由 IPC 层守卫) */
async function initAutoUpdater(window: BrowserWindow): Promise<void> {
  if (!app.isPackaged) return;
  if (process.platform === 'linux' && !process.env.APPIMAGE) return;
  // 读持久化设置里的 autoUpdate(zustand persist 形状:{ state: {...} });缺省 true
  const persisted = readSettings()?.['enso-settings'] as
    | { state?: { autoUpdate?: boolean; autoRestartWhenIdle?: boolean } }
    | undefined;
  const autoUpdate = persisted?.state?.autoUpdate ?? true;
  const { autoUpdaterService } = await import('./services/updater/AutoUpdater');
  autoUpdaterService.init(window, autoUpdate, persisted?.state?.autoRestartWhenIdle === true);
}
