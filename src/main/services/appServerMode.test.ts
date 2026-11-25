import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dock: { hide: vi.fn(), show: vi.fn(async () => undefined), isVisible: vi.fn(() => true) },
  hibernate: { release: () => {} },
  win: null as null | Record<string, ReturnType<typeof vi.fn>>,
  openSettings: vi.fn(),
  trays: [] as Array<{ on: ReturnType<typeof vi.fn> }>,
  settings: {} as Record<string, unknown>,
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
    constructor() {
      mocks.trays.push(this);
    }
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
  readSettings: () => mocks.settings,
  readTrayPreventDisplaySleep: () => false,
  readTraySleepPolicy: () => 'when-agent-running',
  writeTrayPreventDisplaySleep: vi.fn(),
  writeTraySleepPolicy: vi.fn(),
  writeTrayReenterAfterUpdate: vi.fn(),
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
vi.mock('../windows/mainSettings', () => ({ openSettingsInMainWindow: mocks.openSettings }));

import { app, Menu } from 'electron';
import { flushSettings, writeTrayReenterAfterUpdate } from '../ipc/settings';
import { getWindowWebContents } from '../windows/createAppWindow';
import { attachAppCloseConfirm } from './appCloseConfirm';
import type { AppRestartState } from './appRestart';
import {
  ensureTray,
  enterServerMode,
  isServerMode,
  leaveServerMode,
  setTrayRestartActions,
  toggleTrayMode,
} from './appServerMode';

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
      isVisible: vi.fn(() => true),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
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
    isVisible: vi.fn(() => true),
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

/** 有显隐事件的主窗口桩：isVisible 由用例控制 */
function eventedWindow() {
  const events = new EventEmitter();
  let visible = true;
  const win = {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => visible),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
  };
  return {
    win,
    events,
    setVisible: (next: boolean) => {
      visible = next;
    },
  };
}

function toggleItem() {
  const template = vi.mocked(Menu.buildFromTemplate).mock.lastCall?.[0];
  return template?.[0] as { label?: string; click?: () => void };
}

function trayHandler(event: string): () => void {
  const tray = mocks.trays.at(-1);
  const call = tray?.on.mock.calls.findLast(([name]) => name === event);
  return call?.[1] as () => void;
}

describe('tray toggle follows actual window visibility', () => {
  beforeEach(() => {
    mocks.dock.isVisible.mockReturnValue(true);
    mocks.dock.show.mockClear();
    vi.mocked(Menu.buildFromTemplate).mockClear();
  });

  // 真实场景：computer 浮窗把 App 转成 accessory，主窗口被压下去，菜单却仍是「最小化到托盘」，要点两次才回来
  it('Dock 被藏起时菜单显示「打开」，点一次即唤回且不进托盘', () => {
    const { win } = eventedWindow();
    mocks.win = win;
    mocks.dock.isVisible.mockReturnValue(false);
    ensureTray();
    const item = toggleItem();
    expect(item.label).toBe('Show EnsoCode');

    item.click?.();
    expect(isServerMode()).toBe(false);
    expect(mocks.dock.show).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it('主窗口 hide / show 后菜单文案随之更新', () => {
    const target = eventedWindow();
    mocks.win = target.win;
    ensureTray();
    expect(toggleItem().label).toBe('Minimize to tray');

    target.setVisible(false);
    target.events.emit('hide');
    expect(toggleItem().label).toBe('Show EnsoCode');

    target.setVisible(true);
    target.events.emit('show');
    expect(toggleItem().label).toBe('Minimize to tray');
  });

  it('鼠标移到托盘图标上时按当前 Dock 状态重建菜单', () => {
    mocks.win = eventedWindow().win;
    ensureTray();
    expect(toggleItem().label).toBe('Minimize to tray');
    mocks.dock.isVisible.mockReturnValue(false);
    trayHandler('mouse-enter')();
    expect(toggleItem().label).toBe('Show EnsoCode');
  });

  it('窗口在前台时点击进托盘，托盘中再点图标唤回', async () => {
    const { win } = eventedWindow();
    mocks.win = win;
    // 不走 renderer 落盘握手
    vi.mocked(getWindowWebContents).mockReturnValueOnce({
      isDestroyed: () => true,
    } as unknown as WebContents);
    toggleTrayMode();
    await vi.waitFor(() => expect(isServerMode()).toBe(true));
    mocks.hibernate.release();
    await vi.waitFor(() => expect(win.destroy).toHaveBeenCalledOnce());
    expect(toggleItem().label).toBe('Show EnsoCode');

    trayHandler('click')();
    expect(isServerMode()).toBe(false);
    expect(win.show).toHaveBeenCalled();
  });
});

function trayItems() {
  return (vi.mocked(Menu.buildFromTemplate).mock.lastCall?.[0] ?? []) as Array<{
    label?: string;
    type?: string;
    enabled?: boolean;
    click?: () => void;
  }>;
}

describe('tray settings', () => {
  beforeEach(() => {
    mocks.settings = {};
    mocks.openSettings.mockClear();
    vi.mocked(Menu.buildFromTemplate).mockClear();
    mocks.win = eventedWindow().win;
  });

  it('切换项下面就是「设置…」，点了在主窗口里打开设置（不带深链 = 回到上次的分区）', () => {
    ensureTray();
    const items = trayItems();
    expect(items[1]?.label).toBe('Settings…');
    items[1]?.click?.();
    expect(mocks.openSettings).toHaveBeenCalledTimes(1);
    expect(mocks.openSettings).toHaveBeenCalledWith();
  });

  it('中文界面显示「设置…」', () => {
    mocks.settings = { 'enso-settings': { state: { language: 'zh' } } };
    ensureTray();
    expect(trayItems()[1]?.label).toBe('设置…');
  });
});

describe('tray restart', () => {
  let state: AppRestartState;
  const reportError = vi.fn();
  const restartApp = vi.fn(() => {
    state = 'restarting';
  });

  beforeEach(() => {
    state = 'idle';
    mocks.settings = {};
    restartApp.mockClear();
    reportError.mockClear();
    vi.mocked(flushSettings).mockClear();
    vi.mocked(writeTrayReenterAfterUpdate).mockClear();
    vi.mocked(Menu.buildFromTemplate).mockClear();
    mocks.win = eventedWindow().win;
    setTrayRestartActions({ restartApp, restartState: () => state, reportError });
  });

  it('「重启」紧挨在「退出」上面', () => {
    ensureTray();
    const items = trayItems();
    expect(items.slice(-3).map((item) => item.type ?? item.label)).toEqual([
      'separator',
      'Restart',
      'Quit',
    ]);
  });

  it('点「重启」走注入的应用重启，窗口模式下不标记回托盘', () => {
    ensureTray();
    trayItems().at(-2)?.click?.();
    expect(restartApp).toHaveBeenCalledOnce();
    expect(writeTrayReenterAfterUpdate).not.toHaveBeenCalled();
  });

  it('重启进行中菜单项置灰，不会重复登记重启', () => {
    ensureTray();
    const restart = trayItems().at(-2);
    restart?.click?.();
    restart?.click?.();
    expect(restartApp).toHaveBeenCalledOnce();

    ensureTray();
    expect(trayItems().at(-2)).toMatchObject({ label: 'Restarting…', enabled: false });
    state = 'waiting-for-tools';
    ensureTray();
    expect(trayItems().at(-2)).toMatchObject({ enabled: false });
  });

  it('托盘模式下重启：新实例冷启动后回到托盘', async () => {
    vi.mocked(getWindowWebContents).mockReturnValueOnce({
      isDestroyed: () => true,
    } as unknown as WebContents);
    const entering = enterServerMode();
    await vi.waitFor(() => expect(isServerMode()).toBe(true));
    mocks.hibernate.release();
    await entering;
    try {
      vi.mocked(flushSettings).mockClear();
      trayItems().at(-2)?.click?.();
      expect(writeTrayReenterAfterUpdate).toHaveBeenCalledWith(true);
      expect(flushSettings).toHaveBeenCalledOnce();
      expect(restartApp).toHaveBeenCalledOnce();
    } finally {
      leaveServerMode();
    }
    expect(writeTrayReenterAfterUpdate).toHaveBeenLastCalledWith(false);
  });

  it('重启抛错时回滚回托盘标记、立即落盘并汇报错误', async () => {
    vi.mocked(getWindowWebContents).mockReturnValueOnce({
      isDestroyed: () => true,
    } as unknown as WebContents);
    const entering = enterServerMode();
    await vi.waitFor(() => expect(isServerMode()).toBe(true));
    mocks.hibernate.release();
    await entering;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.mocked(flushSettings).mockClear();
      restartApp.mockImplementationOnce(() => {
        throw new Error('relaunch failed');
      });
      trayItems().at(-2)?.click?.();
      expect(writeTrayReenterAfterUpdate).toHaveBeenNthCalledWith(1, true);
      expect(writeTrayReenterAfterUpdate).toHaveBeenNthCalledWith(2, false);
      expect(flushSettings).toHaveBeenCalledTimes(2);
      expect(reportError).toHaveBeenCalledWith('Restart failed: relaunch failed');
    } finally {
      log.mockRestore();
      leaveServerMode();
    }
  });

  it('中文模式下托盘重启项和进行中文案为中文', () => {
    mocks.settings = { 'enso-settings': { state: { language: 'zh' } } };
    ensureTray();
    expect(trayItems().at(-2)).toMatchObject({ label: '重启' });

    state = 'restarting';
    ensureTray();
    expect(trayItems().at(-2)).toMatchObject({ label: '正在重启…', enabled: false });

    state = 'waiting-for-tools';
    ensureTray();
    expect(trayItems().at(-2)).toMatchObject({ label: '等命令跑完再重启…', enabled: false });
  });
});
