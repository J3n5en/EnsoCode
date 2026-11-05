import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  isPackaged: false,
  appHandlers: new Map<string, (...args: unknown[]) => void>(),
  setPath: vi.fn(),
  autoUpdaterInit: vi.fn(),
  startAgentWorker: vi.fn(() => mocks.order.push('worker')),
  createMainWindow: vi.fn(() => {
    mocks.order.push('window');
    return {};
  }),
  consumeTrayReenter: vi.fn(() => false),
  scheduleReenter: vi.fn(),
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
    setAsDefaultProtocolClient: vi.fn(),
    quit: vi.fn(),
    whenReady: () => Promise.resolve(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      mocks.appHandlers.set(event, handler);
    }),
  },
  BrowserWindow: { getAllWindows: () => [] },
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
  consumeTrayReenterAfterUpdate: () => mocks.consumeTrayReenter(),
}));
vi.mock('./ipc/desktop', () => ({ registerDesktopIpcHandlers: vi.fn() }));
vi.mock('./ipc/window', () => ({ openPluginInstallFromProtocol: vi.fn() }));
vi.mock('./desktop/localUi', () => ({ installDesktopLocalUi: vi.fn() }));
vi.mock('./desktop/localImageScheme', () => ({
  registerLocalImageProtocolHandler: vi.fn(),
  registerLocalImageSchemePrivileges: vi.fn(),
}));
vi.mock('./services/remoteRenderer', () => ({ setupRemoteRenderer: vi.fn() }));
vi.mock('./services/nodeRemote', () => ({ registerNodeSettingsProtocolHandler: vi.fn() }));
vi.mock('./services/appMenu', () => ({ installAppMenu: vi.fn() }));
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
}));
vi.mock('./services/proxyConfig', () => ({
  getProxyConfig: () => ({
    initFromConfig: vi.fn(),
    whenReady: () => Promise.resolve(true),
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
  shouldQuitOnWindowAllClosed: () => false,
  scheduleReenterServerMode: (...args: unknown[]) => mocks.scheduleReenter(...args),
}));
vi.mock('./services/trayToggleShortcut', () => ({
  setTrayToggleHandler: vi.fn(),
  syncTrayToggleShortcut: vi.fn(),
  stopTrayToggleShortcut: vi.fn(),
}));

const originalUserDataOverride = process.env.ENSO_USER_DATA_DIR;

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
  delete process.env.ENSO_USER_DATA_DIR;
});

afterAll(() => {
  if (originalUserDataOverride === undefined) delete process.env.ENSO_USER_DATA_DIR;
  else process.env.ENSO_USER_DATA_DIR = originalUserDataOverride;
});

describe('Main startup order', () => {
  it('creates the renderer window before asynchronously starting the worker, exactly once', async () => {
    await import('./index');
    await Promise.resolve();

    expect(mocks.order).toEqual(['ipc', 'window', 'tray']);
    expect(mocks.startAgentWorker).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setImmediate(resolve));
    // pair 不依赖代理；worker 等 whenReady 后再 fork，所以排在 pair 之后。
    await Promise.resolve();
    expect(mocks.order).toEqual(['ipc', 'window', 'tray', 'pair', 'worker']);
    expect(mocks.createMainWindow).toHaveBeenCalledOnce();
    expect(mocks.startAgentWorker).toHaveBeenCalledOnce();
    expect(mocks.scheduleReenter).not.toHaveBeenCalled();
  });

  it('schedules tray re-entry after an update restart', async () => {
    mocks.consumeTrayReenter.mockReturnValue(true);
    await import('./index');
    await Promise.resolve();
    expect(mocks.createMainWindow).toHaveBeenCalledOnce();
    expect(mocks.scheduleReenter).toHaveBeenCalledOnce();
  });
});

describe('Main process diagnostics', () => {
  it('listens for child-process-gone', async () => {
    await import('./index');
    expect(mocks.appHandlers.has('child-process-gone')).toBe(true);
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
