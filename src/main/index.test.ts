import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  isPackaged: false,
  appHandlers: new Map<string, (...args: unknown[]) => void>(),
  setPath: vi.fn(),
  crashReporterStart: vi.fn(),
  autoUpdaterInit: vi.fn(),
  startAgentWorker: vi.fn(() => mocks.order.push('worker')),
  createMainWindow: vi.fn(() => {
    mocks.order.push('window');
    return {};
  }),
  consumeTrayReenter: vi.fn(() => false),
  scheduleReenter: vi.fn(),
  prepareQuit: vi.fn(async (_options: unknown) => 'skipped'),
  forceAgentWorkerQuit: vi.fn(() => true),
  registerForce: vi.fn(),
  beforeConfirmedQuit: null as null | (() => Promise<void>),
  dialog: [] as string[],
  needsCheckpoint: false,
  setAsDefaultProtocolClient: vi.fn(),
  rebuildTrayMenu: vi.fn(),
  installAppMenu: vi.fn(),
  desktopHooks: null as null | { app?: { syncAppLanguage?: () => void } },
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.isPackaged;
    },
    commandLine: { appendSwitch: vi.fn() },
    dock: { setIcon: vi.fn() },
    getAppPath: () => '/app',
    getPath: (name: string) => (name === 'appData' ? '/system-app-data' : '/tmp'),
    setPath: mocks.setPath,
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: mocks.setAsDefaultProtocolClient,
    setActivationPolicy: vi.fn(),
    quit: vi.fn(),
    whenReady: () => Promise.resolve(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      mocks.appHandlers.set(event, handler);
    }),
  },
  BrowserWindow: { getAllWindows: () => [] },
  crashReporter: { start: mocks.crashReporterStart },
}));
vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
}));
vi.mock('./ipc', () => ({
  registerIpcHandlers: vi.fn(() => mocks.order.push('ipc')),
}));
vi.mock('./ipc/settings', () => ({
  readSettings: vi.fn(() => null),
  readSettingsState: vi.fn(() => ({})),
  readLocale: vi.fn(() => 'en'),
  consumeTrayReenterAfterUpdate: () => mocks.consumeTrayReenter(),
  startProviderModelRefresh: vi.fn(),
}));
vi.mock('./ipc/desktop', () => ({ registerDesktopIpcHandlers: vi.fn() }));
vi.mock('./desktop/dropShelf', () => ({ syncDropShelf: vi.fn() }));
vi.mock('./ipc/window', () => ({
  openPluginInstallFromProtocol: vi.fn(),
  noteOpenFolder: vi.fn(),
  noteOpenFolderArgv: vi.fn(),
  notifyOpenFolderRequested: vi.fn(),
}));
vi.mock('./desktop/localUi', () => ({ installDesktopLocalUi: vi.fn() }));
vi.mock('./desktop/localImageScheme', () => ({
  registerLocalImageProtocolHandler: vi.fn(),
  registerLocalImageSchemePrivileges: vi.fn(),
}));
vi.mock('./services/remoteRenderer', () => ({ setupRemoteRenderer: vi.fn() }));
vi.mock('./services/nodeRemote', () => ({ registerNodeSettingsProtocolHandler: vi.fn() }));
vi.mock('./services/appMenu', () => ({
  installAppMenu: mocks.installAppMenu,
  setAppMenuActions: vi.fn(),
}));
vi.mock('./services/computerHost', () => ({ computerHost: { closeAll: vi.fn() } }));
vi.mock('./services/pairHost', () => ({
  startPairHost: vi.fn(() => mocks.order.push('pair')),
  stopPairHost: vi.fn(),
  refreshPowerKeepAlive: vi.fn(),
}));
vi.mock('./services/pairGuest', () => ({
  startPairGuest: vi.fn(),
  stopPairGuest: vi.fn(),
}));
vi.mock('./services/agentHost', () => ({
  startAgentWorker: mocks.startAgentWorker,
  agentWorkerAlive: () => false,
  stopAgentWorkerForQuit: vi.fn(async () => undefined),
  prepareAgentWorkerForQuit: mocks.prepareQuit,
  forceAgentWorkerQuit: mocks.forceAgentWorkerQuit,
  recordAgentWorkerGone: vi.fn(),
  agentDataDir: () => '/tmp/enso-index-test/agent',
}));
vi.mock('./ipc/agent', () => ({
  resumeRootFromRestartManifest: vi.fn(),
  wakeInterruptedRunOwners: vi.fn(),
}));
vi.mock('./ipc/appRestart', () => ({
  clearRestartOverlay: vi.fn(),
  registerAppRestartHandlers: mocks.registerForce,
  setRestartOverlay: vi.fn(),
  waitWithExitDialog: async (
    exit: string,
    prepare: (onWaiting: (reason: string) => void) => Promise<unknown>
  ) => {
    try {
      return await prepare((reason) => mocks.dialog.push(`open:${exit}:${reason}`));
    } finally {
      mocks.dialog.push(`close:${exit}`);
    }
  },
}));
vi.mock('./services/appCloseConfirm', () => ({
  allowAppQuit: vi.fn(),
  setBeforeConfirmedQuit: (hook: () => Promise<void>) => {
    mocks.beforeConfirmedQuit = hook;
  },
}));
vi.mock('./ipc/sessionIndex', () => ({
  agentSessionIndex: { runningRootSessionIds: () => [] },
  needsQuitCheckpoint: () => mocks.needsCheckpoint,
}));
vi.mock('./services/coldRestart', () => ({
  coldRestartPlan: () => null,
  resumeColdRestartSessions: vi.fn(),
  trackColdResume: vi.fn(),
}));
vi.mock('./services/proxyConfig', () => ({
  getProxyConfig: () => ({
    initFromConfig: vi.fn(),
    whenReady: () => Promise.resolve(true),
  }),
}));
vi.mock('./services/caCert', () => ({
  getCaCertConfig: () => ({ initFromConfig: vi.fn(), applyShellValue: vi.fn() }),
}));
vi.mock('./services/secureStores', () => ({
  readySecureStores: vi.fn(async () => {
    mocks.order.push('secure');
  }),
}));
vi.mock('./services/updater/AutoUpdater', () => ({
  autoUpdaterService: { init: mocks.autoUpdaterInit },
}));
vi.mock('./windows/MainWindow', () => ({
  createMainWindow: mocks.createMainWindow,
  getMainWindow: vi.fn(() => null),
}));
vi.mock('./services/appServerMode', () => ({
  ensureTray: vi.fn(() => mocks.order.push('tray')),
  leaveServerMode: vi.fn(),
  enterServerMode: vi.fn(),
  isServerMode: () => false,
  restoreFromSecondInstance: vi.fn(),
  rebuildTrayMenu: mocks.rebuildTrayMenu,
  setTrayRestartActions: vi.fn(),
  shouldQuitOnWindowAllClosed: () => false,
  scheduleReenterServerMode: (...args: unknown[]) => mocks.scheduleReenter(...args),
  toggleTrayMode: vi.fn(),
}));
vi.mock('./services/desktopHooks', () => ({
  installDesktopHooks: (hooks: { app?: { syncAppLanguage?: () => void } }) => {
    mocks.desktopHooks = hooks;
  },
}));
vi.mock('./services/trayToggleShortcut', () => ({
  setTrayToggleHandler: vi.fn(),
  syncTrayToggleShortcut: vi.fn(),
  stopTrayToggleShortcut: vi.fn(),
}));
// 下面几个只被入口接线调用，真实加载占冷启动大头（会话历史连带整个 pi-coding-agent、浏览器宿主、配置 CLI 服务）
vi.mock('./services/exitInterruptHost', () => ({
  recordRunningSessionsAtExit: vi.fn(),
  startExitInterruptRecovery: vi.fn(),
  startRunningSessionsHeartbeat: vi.fn(),
}));
vi.mock('./services/browserHost', () => ({
  browserHost: { setHostWindow: vi.fn(), dispose: vi.fn(async () => undefined) },
}));
vi.mock('./services/configCli', () => ({
  startDesktopConfigCli: vi.fn(async () => undefined),
  stopDesktopConfigCli: vi.fn(),
}));
vi.mock('./desktop/revealExternalConfirm', () => ({ confirmRevealExternal: vi.fn() }));

const originalUserDataOverride = process.env.ENSO_USER_DATA_DIR;
const originalVerify = process.env.ENSO_VERIFY;

// 入口依赖图在收集阶段加载一次；用例里 resetModules 之后只重新求值
await import('./index');
for (let i = 0; i < 2; i++) await new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.resetModules();
  mocks.order.length = 0;
  mocks.appHandlers.clear();
  mocks.isPackaged = false;
  mocks.setPath.mockClear();
  mocks.startAgentWorker.mockClear();
  mocks.createMainWindow.mockClear();
  mocks.autoUpdaterInit.mockClear();
  mocks.consumeTrayReenter.mockReset();
  mocks.consumeTrayReenter.mockReturnValue(false);
  mocks.scheduleReenter.mockClear();
  mocks.setAsDefaultProtocolClient.mockClear();
  delete process.env.ENSO_USER_DATA_DIR;
  delete process.env.ENSO_VERIFY;
});

afterAll(() => {
  if (originalUserDataOverride === undefined) delete process.env.ENSO_USER_DATA_DIR;
  else process.env.ENSO_USER_DATA_DIR = originalUserDataOverride;
  if (originalVerify === undefined) delete process.env.ENSO_VERIFY;
  else process.env.ENSO_VERIFY = originalVerify;
});

describe('Main startup order', () => {
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it('creates the renderer window before asynchronously starting the worker, exactly once', async () => {
    await import('./index');
    await settle();

    // 凭据存储先解密进内存，IPC 才注册
    expect(mocks.order).toEqual(['secure', 'ipc', 'window', 'tray']);
    expect(mocks.startAgentWorker).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setImmediate(resolve));
    // pair 不依赖代理；worker 等 whenReady 后再 fork，所以排在 pair 之后。
    await Promise.resolve();
    expect(mocks.order).toEqual(['secure', 'ipc', 'window', 'tray', 'pair', 'worker']);
    expect(mocks.createMainWindow).toHaveBeenCalledOnce();
    expect(mocks.startAgentWorker).toHaveBeenCalledOnce();
    expect(mocks.scheduleReenter).not.toHaveBeenCalled();
  });

  it('schedules tray re-entry after an update restart', async () => {
    mocks.consumeTrayReenter.mockReturnValue(true);
    await import('./index');
    await settle();
    expect(mocks.createMainWindow).toHaveBeenCalledOnce();
    expect(mocks.scheduleReenter).toHaveBeenCalledOnce();
  });

  it('切换语言时同时刷新应用菜单与托盘菜单', async () => {
    await import('./index');
    await settle();
    mocks.installAppMenu.mockClear();
    mocks.rebuildTrayMenu.mockClear();
    mocks.desktopHooks?.app?.syncAppLanguage?.();
    expect(mocks.installAppMenu).toHaveBeenCalledOnce();
    expect(mocks.rebuildTrayMenu).toHaveBeenCalledOnce();
  });
});

describe('Main process diagnostics', () => {
  it('listens for child-process-gone', async () => {
    await import('./index');
    expect(mocks.appHandlers.has('child-process-gone')).toBe(true);
  });

  it('crash dumps 落在 userData 下且只存本地', async () => {
    mocks.crashReporterStart.mockClear();
    await import('./index');
    // mock 的 getPath('userData') 固定返回 /tmp
    expect(mocks.setPath).toHaveBeenCalledWith('crashDumps', path.join('/tmp', 'Crashpad'));
    expect(mocks.crashReporterStart).toHaveBeenCalledWith({ uploadToServer: false });
  });
});

describe('退出与安装更新的等待弹层接线', () => {
  it('确认退出后先等安全点：有命令在跑开「等完退出」弹层，等完关掉', async () => {
    mocks.dialog.length = 0;
    mocks.prepareQuit.mockImplementationOnce(async (options) => {
      (options as { onWaitingForTools: (reason: string) => void }).onWaitingForTools('tool');
      return 'checkpointed';
    });
    await import('./index');
    await mocks.beforeConfirmedQuit?.();
    expect(mocks.prepareQuit).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'quit' }));
    expect(mocks.dialog).toEqual(['open:quit:tool', 'close:quit']);
  });

  it('回合都已结束、只剩转后台命令在跑：退出同样先等安全点（由后台命令决定，不只看在跑的回合）', async () => {
    await import('./index');
    await mocks.beforeConfirmedQuit?.();
    const options = mocks.prepareQuit.mock.calls.at(-1)?.[0] as {
      hasRunningSessions: () => boolean;
    };
    mocks.needsCheckpoint = false;
    expect(options.hasRunningSessions()).toBe(false);
    mocks.needsCheckpoint = true;
    expect(options.hasRunningSessions()).toBe(true);
    mocks.needsCheckpoint = false;
  });

  it.each(['update', 'quit'] as const)('%s 弹层上的「强制退出」结束等安全点', async (exit) => {
    mocks.forceAgentWorkerQuit.mockClear();
    mocks.registerForce.mockClear();
    await import('./index');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const force = mocks.registerForce.mock.calls[0]?.[0] as (exit: string) => void;
    force(exit);
    expect(mocks.forceAgentWorkerQuit).toHaveBeenCalledOnce();
  });
});

describe('Main userData isolation', () => {
  it('uses ENSO_USER_DATA_DIR only in development when it is non-empty', async () => {
    process.env.ENSO_USER_DATA_DIR = '  ./temp/isolated-user-data  ';
    await import('./index');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.setPath).toHaveBeenCalledWith(
      'userData',
      path.resolve('./temp/isolated-user-data')
    );
  });

  it('defaults development userData to the isolated enso-code-dev profile', async () => {
    await import('./index');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.setPath).toHaveBeenCalledWith(
      'userData',
      path.join('/system-app-data', 'enso-code-dev')
    );
  });

  it('ignores ENSO_USER_DATA_DIR in packaged builds', async () => {
    mocks.isPackaged = true;
    process.env.ENSO_USER_DATA_DIR = '/tmp/must-not-be-used';
    await import('./index');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.setPath).toHaveBeenCalledWith(
      'userData',
      path.join('/system-app-data', 'enso-code')
    );
    expect(mocks.setPath).not.toHaveBeenCalledWith('userData', '/tmp/must-not-be-used');
  });
});

describe('enso:// 协议注册', () => {
  it('平时（含普通 dev）照常注册', async () => {
    await import('./index');
    expect(mocks.setAsDefaultProtocolClient).toHaveBeenCalledOnce();
    expect(mocks.setAsDefaultProtocolClient.mock.calls[0][0]).toBe('enso');
  });

  it('验收实例不改系统的 URL 处理程序', async () => {
    process.env.ENSO_VERIFY = '1';
    await import('./index');
    expect(mocks.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it('打包版忽略 ENSO_VERIFY，照常注册', async () => {
    mocks.isPackaged = true;
    process.env.ENSO_VERIFY = '1';
    await import('./index');
    expect(mocks.setAsDefaultProtocolClient).toHaveBeenCalledOnce();
  });
});
