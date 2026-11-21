import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dock: { hide: vi.fn(), show: vi.fn(), isVisible: vi.fn(() => true) },
  windows: [] as Array<{ setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn> }>,
}));

vi.mock('electron', () => {
  class BrowserWindow {
    visible = false;
    destroyed = false;
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setContentProtection = vi.fn();
    setBounds = vi.fn();
    loadURL = vi.fn(async () => undefined);
    showInactive = vi.fn(() => {
      this.visible = true;
    });
    hide = vi.fn(() => {
      this.visible = false;
    });
    isVisible = () => this.visible;
    isDestroyed = () => this.destroyed;
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    webContents = { isLoading: () => false, executeJavaScript: vi.fn(async () => undefined) };
    constructor() {
      mocks.windows.push(this);
    }
  }
  return {
    app: {
      dock: mocks.dock,
      isReady: () => true,
      getLocale: () => 'en-US',
      getName: () => 'EnsoCode',
    },
    BrowserWindow,
    globalShortcut: { register: () => true, unregister: vi.fn() },
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
  };
});
vi.mock('./occupancyHid', () => ({ hidSecondsSinceLastEvent: () => 0 }));

import { showOnAllSpaces } from './floatingWindow';
import { createElectronOccupancyDeps } from './occupancyOverlay';
import { createVirtualCursor } from './virtualCursor';

const ALL_SPACES = { visibleOnFullScreen: true, skipTransformProcessType: true };

function expectAppPolicyUntouched() {
  expect(mocks.dock.hide).not.toHaveBeenCalled();
  expect(mocks.dock.show).not.toHaveBeenCalled();
  for (const win of mocks.windows) {
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, ALL_SPACES);
  }
}

// 真实场景：浮窗不带 skipTransformProcessType，macOS 把整个 App 转成 accessory，主窗口随即「消失」
describe('computer floating windows keep the app activation policy', () => {
  beforeEach(() => {
    mocks.windows.length = 0;
    mocks.dock.hide.mockClear();
    mocks.dock.show.mockClear();
    mocks.dock.isVisible.mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('showOnAllSpaces 跳过进程类型切换', () => {
    const win = { setVisibleOnAllWorkspaces: vi.fn() };
    showOnAllSpaces(win);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, ALL_SPACES);
  });

  it('后台虚拟光标：显示、自动隐藏到销毁全程不动 Dock / 激活策略', () => {
    vi.useFakeTimers();
    const cursor = createVirtualCursor();
    cursor.pointer({ pid: 42, app: 'Finder', screenX: 100, screenY: 200 });
    expect(mocks.windows).toHaveLength(1);
    vi.runAllTimers();
    cursor.dispose();
    expectAppPolicyUntouched();
  });

  it('前台占用条：显示与隐藏不动 Dock，托盘模式下也不会把 Dock 拉出来', () => {
    mocks.dock.isVisible.mockReturnValue(false);
    const deps = createElectronOccupancyDeps();
    deps.show();
    deps.hide();
    deps.show();
    deps.hide();
    expect(mocks.windows).toHaveLength(1);
    expectAppPolicyUntouched();
  });
});
