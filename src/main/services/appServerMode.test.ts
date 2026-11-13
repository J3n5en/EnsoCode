import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dock: { hide: vi.fn(), show: vi.fn(async () => undefined) },
  hibernate: { release: () => {} },
  win: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));
Object.assign(process, { resourcesPath: '/resources' });

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
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
    app: Object.assign(new EventEmitter(), {
      dock: mocks.dock,
      getAppPath: () => '/app',
      quit: vi.fn(),
    }),
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
// 关窗确认用真实模块：放行标志在两个模块之间流转，单独 mock 掉就测不到泄漏
vi.mock('./updater/AutoUpdater', () => ({
  autoUpdaterService: { isQuittingForUpdate: () => false },
}));
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

import { app } from 'electron';
import { attachAppCloseConfirm } from './appCloseConfirm';
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

/** 挂好关窗确认的主窗口桩；Electron 的 destroy() 不派发 close，只派发 closed */
function confirmedWindow() {
  const events = new EventEmitter();
  const win = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    destroy: vi.fn(() => events.emit('closed')),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) =>
      events.on(event, listener)
    ),
    once: vi.fn((event: string, listener: () => void) => events.once(event, listener)),
    removeListener: vi.fn((event: string, listener: () => void) =>
      events.removeListener(event, listener)
    ),
  };
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  attachAppCloseConfirm(win, vi.fn(), () => contents as unknown as WebContents, {
    interceptBeforeQuit: true,
    onTray: vi.fn(),
  });
  return { win, events };
}

describe('app server mode close confirmation', () => {
  beforeEach(() => {
    mocks.win = null;
  });
  // 用例中途失败时窗口来不及派发 closed，残留的 before-quit 监听会串到下一个用例
  afterEach(() => {
    app.removeAllListeners();
  });

  // 真实场景：关窗选「托盘」后从托盘恢复，新主窗口第一次关窗 / Cmd+Q 不再弹确认，Windows/Linux 上直接退出、中断运行中的 agent
  it.each(['close', 'before-quit'] as const)(
    '进托盘销毁旧窗口后从托盘恢复：新主窗口的 %s 仍要确认',
    async (eventName) => {
      const old = confirmedWindow();
      const entering = enterServerMode();
      await vi.waitFor(() => expect(isServerMode()).toBe(true));
      mocks.win = old.win;
      mocks.hibernate.release();
      await entering;
      expect(old.win.destroy).toHaveBeenCalledOnce();

      const restored = confirmedWindow();
      mocks.win = restored.win;
      leaveServerMode();
      const preventDefault = vi.fn();
      (eventName === 'close' ? restored.events : app).emit(eventName, { preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      restored.events.emit('closed');
    }
  );

  // 真实场景：进托盘途中（hibernateAll 未完成）被唤回，窗口没被销毁，放行标志却留了下来
  it('进托盘途中被唤回：留下的窗口下次关窗仍要确认', async () => {
    const kept = confirmedWindow();
    const entering = enterServerMode();
    await vi.waitFor(() => expect(isServerMode()).toBe(true));
    mocks.win = kept.win;
    leaveServerMode();
    mocks.hibernate.release();
    await entering;
    expect(kept.win.destroy).not.toHaveBeenCalled();

    const preventDefault = vi.fn();
    kept.events.emit('close', { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    kept.events.emit('closed');
  });
});
