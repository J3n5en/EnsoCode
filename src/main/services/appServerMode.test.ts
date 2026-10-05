import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dock: { hide: vi.fn(), show: vi.fn(async () => undefined) },
  hibernate: { release: () => {} },
  win: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));
Object.assign(process, { resourcesPath: '/resources' });

vi.mock('electron', () => {
  class Tray {
    on = vi.fn();
    setContextMenu = vi.fn();
    setToolTip = vi.fn();
    isDestroyed = () => false;
    destroy = vi.fn();
  }
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 16 }),
    setTemplateImage: vi.fn(),
  };
  return {
    app: { dock: mocks.dock, getAppPath: () => '/app' },
    ipcMain: { on: vi.fn(), removeListener: vi.fn() },
    Menu: { buildFromTemplate: vi.fn() },
    nativeImage: { createFromPath: () => image, createFromDataURL: () => image },
    Tray,
  };
});
vi.mock('../ipc/settings', () => ({
  flushSettings: vi.fn(),
  readSettings: () => ({}),
  readTrayPreventDisplaySleep: () => false,
  readTraySleepPolicy: () => 'when-agent-running',
  writeTrayPreventDisplaySleep: vi.fn(),
  writeTraySleepPolicy: vi.fn(),
}));
vi.mock('../windows/createAppWindow', () => ({
  closeWindowWebContents: vi.fn(),
  getWindowWebContents: vi.fn(),
  sendToWindow: vi.fn(),
}));
vi.mock('../windows/MainWindow', () => ({
  createMainWindow: vi.fn(),
  getMainWindow: () => mocks.win,
  isMainWindowAlive: () => mocks.win !== null,
}));
vi.mock('../windows/SettingsWindow', () => ({ getSettingsWindow: () => null }));
vi.mock('./appCloseConfirm', () => ({ allowAppQuit: vi.fn(), bypassNextCloseConfirm: vi.fn() }));
vi.mock('./browserHost', () => ({
  browserHost: {
    hibernateAll: () =>
      new Promise<void>((resolve) => {
        mocks.hibernate.release = resolve;
      }),
  },
}));
vi.mock('./pairHost', () => ({ refreshPowerKeepAlive: vi.fn() }));
vi.mock('./pairSessionHost', () => ({ setPairHeadless: vi.fn() }));

import { enterServerMode, isServerMode, leaveServerMode } from './appServerMode';

describe('app server mode dock visibility', () => {
  beforeEach(() => {
    mocks.dock.hide.mockClear();
    mocks.dock.show.mockClear();
    mocks.win = null;
  });

  it('进托盘途中被唤回：不再隐藏 Dock、不销毁已唤回的窗口', async () => {
    const entering = enterServerMode();
    await vi.waitFor(() => expect(isServerMode()).toBe(true));

    // hibernateAll 未完成时用户点 Dock / 托盘 / 快捷键唤回
    mocks.win = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      destroy: vi.fn(),
    };
    leaveServerMode();
    mocks.hibernate.release();
    await entering;

    expect(isServerMode()).toBe(false);
    expect(mocks.dock.hide).not.toHaveBeenCalled();
    expect(mocks.win.destroy).not.toHaveBeenCalled();
  });

  it('正常进托盘仍隐藏 Dock，唤回时再显示', async () => {
    const entering = enterServerMode();
    await vi.waitFor(() => expect(isServerMode()).toBe(true));
    mocks.hibernate.release();
    await entering;
    expect(mocks.dock.hide).toHaveBeenCalledTimes(1);

    leaveServerMode();
    expect(mocks.dock.show).toHaveBeenCalledTimes(1);
    expect(isServerMode()).toBe(false);
  });
});
