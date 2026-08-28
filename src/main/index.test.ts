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
vi.mock('./ipc/settings', () => ({ readSettings: vi.fn(() => null) }));
vi.mock('./services/agentHost', () => ({ startAgentWorker: mocks.startAgentWorker }));
vi.mock('./services/updater/AutoUpdater', () => ({
  autoUpdaterService: { init: mocks.autoUpdaterInit },
}));
vi.mock('./windows/MainWindow', () => ({
  createMainWindow: mocks.createMainWindow,
  getMainWindow: vi.fn(() => null),
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

    expect(mocks.order).toEqual(['ipc', 'window']);
    expect(mocks.startAgentWorker).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.order).toEqual(['ipc', 'window', 'worker']);
    expect(mocks.createMainWindow).toHaveBeenCalledOnce();
    expect(mocks.startAgentWorker).toHaveBeenCalledOnce();
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
