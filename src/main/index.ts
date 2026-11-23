import path from 'node:path';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { installConsoleLog } from '@shared/appLogFile';
import type { AppExitReason } from '@shared/types/ipc';
import { DEFAULT_UPDATE_CHANNEL, isUpdateChannel } from '@shared/updater/channel';
import { resolveAutoRestartMode } from '@shared/updater/idleRestart';
import { app, BrowserWindow, crashReporter, dialog } from 'electron';
import { syncDropShelf } from './desktop/dropShelf';
import {
  registerLocalImageProtocolHandler,
  registerLocalImageSchemePrivileges,
} from './desktop/localImageScheme';
import { installDesktopLocalUi } from './desktop/localUi';
import { openBotPdfWindow, openDesktopPdfWindow } from './desktop/pdfWindow';
import { confirmRevealExternal } from './desktop/revealExternalConfirm';
import { registerIpcHandlers } from './ipc';
import { resumeRootFromRestartManifest, wakeInterruptedRunOwners } from './ipc/agent';
import {
  clearRestartOverlay,
  registerAppRestartHandlers,
  setRestartOverlay,
  waitWithExitDialog,
} from './ipc/appRestart';
import { registerDesktopIpcHandlers } from './ipc/desktop';
import { needsQuitCheckpoint } from './ipc/sessionIndex';
import {
  consumeTrayReenterAfterUpdate,
  readLocale,
  readSettings,
  startProviderModelRefresh,
} from './ipc/settings';
import {
  noteOpenFolder,
  noteOpenFolderArgv,
  notifyOpenFolderRequested,
  openPluginInstallFromProtocol,
  openSecretaryConversationFromProtocol,
} from './ipc/window';
import { createPluginInstallInbox } from './protocol/pluginInstall';
import { createSecretaryLinkInbox } from './protocol/secretaryLink';
import {
  agentDataDir,
  agentWorkerAlive,
  forceAgentWorkerQuit,
  prepareAgentWorkerForQuit,
  recordAgentWorkerGone,
  startAgentWorker,
  stopAgentWorkerForQuit,
} from './services/agentHost';
import { appendAgentWorkerExitLog } from './services/agentWorkerExit';
import { allowAppQuit, setBeforeConfirmedQuit } from './services/appCloseConfirm';
import { appLogFile } from './services/appLogs';
import { installAppMenu, setAppMenuActions } from './services/appMenu';
import { setUserDataDir } from './services/appPaths';
import { attachAppQuitDrain } from './services/appQuitDrain';
import {
  agentWorkerQuitDrain,
  configureQuitWatchdog,
  quitWatchdog,
} from './services/appQuitWatchdog';
import { createAppRestart, restartOverlayFor } from './services/appRestart';
import {
  ensureTray,
  leaveServerMode,
  rebuildTrayMenu,
  restoreFromSecondInstance,
  scheduleReenterServerMode,
  setTrayRestartActions,
  shouldQuitOnWindowAllClosed,
  toggleTrayMode,
} from './services/appServerMode';
import { browserHost } from './services/browserHost';
import { getCaCertConfig } from './services/caCert';
import {
  coldRestartPlan,
  resumeColdRestartSessions,
  trackColdResume,
} from './services/coldRestart';
import { computerHost } from './services/computerHost';
import { startDesktopConfigCli, stopDesktopConfigCli } from './services/configCli';
import { installDesktopHooks } from './services/desktopHooks';
import {
  recordRunningSessionsAtExit,
  startExitInterruptRecovery,
  startRunningSessionsHeartbeat,
} from './services/exitInterruptHost';
import {
  closeMemoryDb,
  memoryServiceActive,
  scheduleMemoryServiceWarmup,
  shutdownMemoryService,
  syncMemoryDistillFromSettings,
  syncMemoryEmbeddingFromSettings,
  syncMemoryForgettingFromSettings,
  syncMemoryKgFromSettings,
  syncMemoryReconcileFromSettings,
} from './services/memoryHost';
import { registerNodeSettingsProtocolHandler } from './services/nodeRemote';
import {
  maybeNotify,
  maybeNotifyBot,
  notifyBotChat,
  notifySecretary,
  setViewedSession,
} from './services/notifications';
import { startPairGuest, stopPairGuest } from './services/pairGuest';
import { startPairHost, stopPairHost } from './services/pairHost';
import { getProxyConfig } from './services/proxyConfig';
import { setupRemoteRenderer } from './services/remoteRenderer';
import { setSecretaryOpenTarget } from './services/secretary/links';
import { readySecureStores } from './services/secureStores';
import { hydrateShellPath, seedProcessPath } from './services/shellPath';
import { disposeAllTerminals, hasPendingPtys, waitPtyQuitIdle } from './services/terminalService';
import {
  setTrayToggleHandler,
  stopTrayToggleShortcut,
  syncTrayToggleShortcut,
} from './services/trayToggleShortcut';
import { createMainWindow, getMainWindow } from './windows/MainWindow';
import { isVerifyLaunch } from './windows/verifyLaunch';
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

// 验收实例 app ready 前就降为 accessory：不进 Dock、不会被激活成前台应用
if (isVerifyLaunch() && process.platform === 'darwin') app.setActivationPolicy('accessory');

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
// 服务侧路径解析（模型目录等）不直接碰 Electron，统一从注入口取
setUserDataDir(app.getPath('userData'));
// 打包版 stdout 无人接收：console 同步落结构化滚动日志，供设置 → 日志汇总与导出
installConsoleLog(appLogFile(app.getPath('userData'), 'main'), 'main');

// 未启动 crashpad 时子进程 native 崩溃只剩 0xFFFF7003，真实异常码与现场全丢。
// 只落本地 minidump（userData/Crashpad），不上传。
app.setPath('crashDumps', path.join(app.getPath('userData'), 'Crashpad'));
crashReporter.start({ uploadToServer: false });

// 背景图媒体协议：特权 scheme 必须在 app ready 前登记
registerLocalImageSchemePrivileges();

// GUI 启动（Dock/Finder）继承 launchd 极简 PATH，pi 的 bash / MCP 子进程会
// 找不到 node/git。打包版立即前插保底目录；dev 从终端启动，环境本就完整。
if (app.isPackaged && process.platform !== 'win32') {
  seedProcessPath();
}

const gotTheLock = app.requestSingleInstanceLock();
const pluginInstallInbox = createPluginInstallInbox(process.platform);
const secretaryLinkInbox = createSecretaryLinkInbox(process.platform);
function showMenuError(message: string): void {
  const parent = BrowserWindow.getFocusedWindow() ?? getMainWindow();
  const options = { type: 'error' as const, message };
  void (
    parent && !parent.isDestroyed()
      ? dialog.showMessageBox(parent, options)
      : dialog.showMessageBox(options)
  ).catch((error: unknown) => console.error('[app-menu] 提示框失败:', error));
}

// 菜单「重启」：点下去主窗口立刻弹「正在重启」；先等 agent 安全点（有命令在跑弹层改成等命令、可强制退出），
// 再退出；will-quit 收尾拿同一个结果，新实例冷启动按清单续跑
const appRestart = createAppRestart({
  relaunch: () => {
    app.relaunch();
    quitWatchdog.begin('restart', '等 agent 安全点', { relaunched: true });
  },
  allowQuit: allowAppQuit,
  quit: () => {
    quitWatchdog.step('关窗退出', { finishing: true });
    app.quit();
  },
  prepareQuit: (onWaitingForTools) =>
    prepareAgentWorkerForQuit({
      reason: 'quit',
      hasRunningSessions: needsQuitCheckpoint,
      onWaitingForTools,
      // 应用马上重新打开：能脱离的转后台命令（dev server 等）交给新实例认回，不等也不停
      keepBackgroundTasks: true,
    }),
  stateChanged: (state, waitReason, blockers) => {
    installAppMenu(readLocale());
    rebuildTrayMenu();
    const overlay = restartOverlayFor(state, waitReason, blockers);
    if (overlay) setRestartOverlay(overlay);
    else clearRestartOverlay('restart');
  },
  abandonPrepare: () => void forceAgentWorkerQuit(),
});

// Cmd+Q / 关窗 / 菜单退出：确认退出后、窗口还在时先等安全点，有命令在跑主窗口弹等待层；
// will-quit 收尾拿同一个结果
setBeforeConfirmedQuit(async () => {
  quitWatchdog.begin('quit', '等 agent 安全点');
  try {
    await waitWithExitDialog('quit', (onWaitingForTools) =>
      prepareAgentWorkerForQuit({
        reason: 'quit',
        hasRunningSessions: needsQuitCheckpoint,
        onWaitingForTools,
      })
    );
  } finally {
    quitWatchdog.step('关窗退出', { finishing: true });
  }
});

/** 等待弹层上点「强制退出」：重启走重启自己的强制路径；安装更新与退出结束等待，各自照常往下走 */
function forceExitWait(exit: AppExitReason): void {
  if (exit === 'restart' && appRestart.forceQuit()) return;
  try {
    forceAgentWorkerQuit();
  } catch (error) {
    console.error(`[app-exit] ${exit} 强制退出时结束等待失败:`, error);
  }
}

function registerEnsoProtocol(): void {
  // 验收实例不改系统的 URL 处理程序，免得把用户正式版的 enso:// 深链抢走
  if (isVerifyLaunch()) return;
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('enso', process.execPath, [path.resolve(process.argv[1])]);
    return;
  }
  app.setAsDefaultProtocolClient('enso');
}

if (!gotTheLock) {
  app.quit();
} else {
  registerEnsoProtocol();
  // 被安装脚本 pkill（SIGTERM）时也要留下「退出时正在跑什么」：默认行为是直接终止，
  // 这里先同步写记录再走正常退出，来不及（SIGKILL）则由心跳兜底。
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      recordRunningSessionsAtExit();
      app.quit();
    });
  }
  startRunningSessionsHeartbeat();
  configureQuitWatchdog({
    relaunch: () => app.relaunch(),
    exit: () => app.exit(0),
    log: (message) => appendAgentWorkerExitLog(agentDataDir(), message),
  });
  startExitInterruptRecovery();
  pluginInstallInbox.noteArgv(process.argv);
  secretaryLinkInbox.noteArgv(process.argv);
  noteOpenFolderArgv(process.argv);
  app.on('open-url', (event, url) => {
    event.preventDefault();
    pluginInstallInbox.noteLink(url);
    secretaryLinkInbox.noteLink(url);
  });
  // macOS：拖到 Dock 图标或 `open -a EnsoCode <dir>`；冷启动早于 ready，由渲染端挂载时取走
  app.on('open-file', (event, folder) => {
    event.preventDefault();
    noteOpenFolder(folder);
    if (app.isReady()) notifyOpenFolderRequested();
  });
  app.on('second-instance', (_event, argv) => {
    restoreFromSecondInstance();
    pluginInstallInbox.noteArgv(argv);
    secretaryLinkInbox.noteArgv(argv);
    noteOpenFolderArgv(argv);
    notifyOpenFolderRequested();
  });
  app.on('child-process-gone', (_event, details) => {
    console.error(
      `[process] child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode} serviceName=${details.serviceName ?? ''} name=${details.name ?? ''}`
    );
    recordAgentWorkerGone(details);
  });

  app.whenReady().then(async () => {
    const secureStores = readySecureStores();
    electronApp.setAppUserModelId(
      resolveWindowsAppUserModelId({
        execPath: process.execPath,
        isPackaged: app.isPackaged,
      })
    );

    // dev 下 dock 显示 Electron 默认图标；手动设为 app 图标（打包由 electron-builder 处理）
    if (!app.isPackaged && process.platform === 'darwin' && !isVerifyLaunch()) {
      app.dock?.setIcon(path.join(app.getAppPath(), 'build', 'icon.png'));
    }
    setAppMenuActions({
      restartApp: () => void appRestart.restart(),
      restartState: () => appRestart.state,
      reportError: showMenuError,
    });
    setTrayRestartActions({
      restartApp: () => void appRestart.restart(),
      restartState: () => appRestart.state,
      reportError: showMenuError,
    });
    registerAppRestartHandlers(forceExitWait);
    installAppMenu(readLocale());

    // 开发环境下默认用 F12 打开/关闭 DevTools
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
      notify: { maybeNotify, maybeNotifyBot, notifySecretary, setViewedSession },
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
        syncAppLanguage: () => {
          installAppMenu(readLocale());
          rebuildTrayMenu();
        },
        syncDropShelf,
      },
    });
    await secureStores;
    // 上次退出 / 安装更新前停在安全点的会话：先读清单（渲染层取中断记录前就要知道哪些会续跑）
    const coldRestart = coldRestartPlan(agentDataDir());
    // 有会话要续跑：主窗口在恢复完成前显示「正在恢复会话」（有上限）
    trackColdResume(coldRestart, (resuming) =>
      resuming ? setRestartOverlay({ phase: 'resuming' }) : clearRestartOverlay('resuming')
    );
    registerIpcHandlers();
    registerDesktopIpcHandlers();
    void startDesktopConfigCli();
    void import('./services/modelsDevCatalog').then(({ startModelsDevRefreshSchedule }) => {
      startModelsDevRefreshSchedule();
    });
    pluginInstallInbox.start((url) => openPluginInstallFromProtocol(url));
    // 手机上的「在应用里打开」与深链走同一个入口
    setSecretaryOpenTarget((target) => openSecretaryConversationFromProtocol(target));
    secretaryLinkInbox.start((target) => openSecretaryConversationFromProtocol(target));
    setTrayToggleHandler(toggleTrayMode);
    // 协议处理器要赶在窗口加载内容之前注册（local-image:// 资源依赖它）。
    registerLocalImageProtocolHandler();
    registerNodeSettingsProtocolHandler();
    const persisted = readSettings()?.['enso-settings'] as
      | {
          state?: {
            proxyMode?: unknown;
            customProxyUrl?: unknown;
            customCaCertPath?: unknown;
            autoUpdate?: boolean;
          };
        }
      | undefined;
    getProxyConfig().initFromConfig(persisted?.state?.proxyMode, persisted?.state?.customProxyUrl);
    getCaCertConfig().initFromConfig(persisted?.state?.customCaCertPath);
    startProviderModelRefresh();
    const persistedState = (
      persisted?.state && typeof persisted.state === 'object' ? persisted.state : {}
    ) as Record<string, unknown>;
    syncTrayToggleShortcut(persistedState.keybindings);
    syncDropShelf(persistedState.dropShelfEnabled === true);
    syncMemoryEmbeddingFromSettings(persistedState);
    syncMemoryDistillFromSettings(persistedState);
    syncMemoryKgFromSettings(persistedState);
    syncMemoryReconcileFromSettings(persistedState);
    syncMemoryForgettingFromSettings(persistedState);
    scheduleMemoryServiceWarmup();
    // UI shell 必须先创建并发起加载；Agent worker 初始化变重时不得阻塞 renderer spawn。
    const mainWindow = createMainWindow();
    ensureTray();
    // 内嵌浏览器 guest view 挂主窗口（无头也要 viewport）；窗口重建后 getMainWindow 自动指向新窗
    browserHost.setHostWindow(getMainWindow);
    // 两个后台服务都不依赖窗口，同样延后，避免堵住首帧。
    setImmediate(() => {
      // 冷启动接管断点：第一代 worker 带上断点，再按清单重走 spawn（凭据现取）
      const startWorker = (): void => {
        startAgentWorker(coldRestart ? { restartCheckpointFile: coldRestart.checkpointFile } : {});
        if (coldRestart)
          void resumeColdRestartSessions(coldRestart, resumeRootFromRestartManifest).then(() =>
            wakeInterruptedRunOwners(coldRestart)
          );
      };
      // worker 的 env 是 fork 时的快照：等系统代理解析后再 fork，
      // 打包版再等登录 shell 探测出真实 PATH。
      const ready = getProxyConfig().whenReady();
      if (app.isPackaged && process.platform !== 'win32') {
        void ready.finally(() =>
          hydrateShellPath()
            .then(({ extraCaCerts }) => getCaCertConfig().applyShellValue(extraCaCerts))
            .finally(startWorker)
        );
      } else {
        void ready.finally(startWorker);
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
    // 退出记录要赶在 worker 与终端收尾之前：此刻会话状态还是权威的
    recordRunningSessionsAtExit();
    stopDesktopConfigCli();
    stopTrayToggleShortcut();
    stopPairHost();
    stopPairGuest();
    // 内嵌浏览器 Cookie / storage 落盘后再关 guest 页
    void browserHost.dispose();
    computerHost.closeAll();
    closeMemoryDb();
  });
  // node-pty TSFN / 记忆服务子进程（llama/sqlite 在里面）的收尾都要赶在退出前完成；
  // 三步共用一次 preventDefault，谁先 app.quit 都会拆掉其他两边的环境。
  // 先等 worker 到安全点、断点与恢复清单落盘（有超时兜底），再照常收尾
  const agentQuit = agentWorkerQuitDrain(quitWatchdog, {
    alive: agentWorkerAlive,
    prepare: () =>
      prepareAgentWorkerForQuit({ reason: 'quit', hasRunningSessions: needsQuitCheckpoint }),
    stop: () => stopAgentWorkerForQuit(3_000),
  });
  attachAppQuitDrain(
    app,
    [
      {
        name: '终端',
        begin: disposeAllTerminals,
        shouldWait: hasPendingPtys,
        wait: waitPtyQuitIdle,
      },
      {
        // 记忆服务（utilityProcess）：等它关库、卸载模型；超时内部 SIGKILL，
        // 卡死也不拖住退出（#323 看门狗同款，子进程死了 WAL 可恢复）
        name: '记忆服务',
        shouldWait: memoryServiceActive,
        wait: () => shutdownMemoryService(),
      },
      agentQuit.step,
    ],
    // 窗口已关、退出不可撤回：过了安全点之后卡住由看门狗限时强退
    agentQuit.onProgress
  );
}

/** 打包环境下启动自动更新(dev 无 app-update.yml,electron-updater 会报错;Linux deb 由 IPC 层守卫) */
async function initAutoUpdater(window: BrowserWindow): Promise<void> {
  if (!app.isPackaged) return;
  if (process.platform === 'linux' && !process.env.APPIMAGE) return;
  // 读持久化设置里的 autoUpdate(zustand persist 形状:{ state: {...} });缺省 true
  const persisted = readSettings()?.['enso-settings'] as
    | { state?: { autoUpdate?: boolean; updateChannel?: unknown } }
    | undefined;
  const autoUpdate = persisted?.state?.autoUpdate ?? true;
  const channel = isUpdateChannel(persisted?.state?.updateChannel)
    ? persisted.state.updateChannel
    : DEFAULT_UPDATE_CHANNEL;
  const { autoUpdaterService } = await import('./services/updater/AutoUpdater');
  autoUpdaterService.init(
    window,
    autoUpdate,
    // 旧版布尔开关：开着按「空闲时」，关着按「关」
    resolveAutoRestartMode(persisted?.state),
    channel
  );
}
