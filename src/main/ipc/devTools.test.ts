import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLocalCall } from '../services/nodeRemote/boundary';
import { isRemoteChannelAllowed } from '../services/remoteRenderer/channels';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  getMainWindow: vi.fn(),
  getSettingsWindow: vi.fn(),
  verifyLaunch: false,
  contents: {
    id: 10,
    isDestroyed: vi.fn(() => false),
    isDevToolsOpened: vi.fn(() => false),
    openDevTools: vi.fn(),
    devToolsWebContents: { focus: vi.fn() } as { focus: () => void } | null,
  },
}));

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock('../windows/MainWindow', () => ({ getMainWindow: mocks.getMainWindow }));
vi.mock('../windows/SettingsWindow', () => ({ getSettingsWindow: mocks.getSettingsWindow }));
vi.mock('../windows/createAppWindow', () => ({ getWindowWebContents: () => mocks.contents }));
vi.mock('../windows/verifyLaunch', () => ({ isVerifyLaunch: () => mocks.verifyLaunch }));

import { registerDevToolsHandlers } from './devTools';

const mainWindow = (destroyed = false) => ({ isDestroyed: () => destroyed });
const settingsWindow = (id = 20, destroyed = false) => ({
  isDestroyed: () => destroyed,
  webContents: { id, isDestroyed: () => destroyed },
});
const fromSettings = () => ({ sender: { id: 20 } });
const fromMain = () => ({ sender: { id: 10 } });

let handler: (event: unknown, ...args: unknown[]) => unknown;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyLaunch = false;
  mocks.contents.isDestroyed.mockReturnValue(false);
  mocks.contents.isDevToolsOpened.mockReturnValue(false);
  mocks.getMainWindow.mockReturnValue(mainWindow());
  mocks.getSettingsWindow.mockReturnValue(settingsWindow());
  registerDevToolsHandlers();
  handler = mocks.handle.mock.calls.find(([ch]) => ch === IPC_CHANNELS.WINDOW_OPEN_DEV_TOOLS)?.[1];
});

describe('WINDOW_OPEN_DEV_TOOLS', () => {
  it('对主窗口 UI 的 webContents 以独立窗口打开 DevTools', () => {
    expect(handler(fromSettings())).toEqual({ ok: true });
    expect(mocks.contents.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
    expect(handler(fromMain())).toEqual({ ok: true });
  });

  it('主窗口不存在或已销毁时返回可读错误，不抛异常', () => {
    mocks.getMainWindow.mockReturnValue(null);
    expect(handler(fromSettings())).toEqual({ ok: false, error: 'main-window-unavailable' });
    mocks.getMainWindow.mockReturnValue(mainWindow(true));
    expect(handler(fromSettings())).toEqual({ ok: false, error: 'main-window-unavailable' });
    mocks.getMainWindow.mockReturnValue(mainWindow());
    mocks.contents.isDestroyed.mockReturnValue(true);
    expect(handler(fromSettings())).toEqual({ ok: false, error: 'main-window-unavailable' });
    expect(mocks.contents.openDevTools).not.toHaveBeenCalled();
  });

  it('DevTools 已开着时只把它提到前面，不重复打开', () => {
    mocks.contents.isDevToolsOpened.mockReturnValue(true);
    expect(handler(fromSettings())).toEqual({ ok: true });
    expect(mocks.contents.openDevTools).not.toHaveBeenCalled();
    expect(mocks.contents.devToolsWebContents?.focus).toHaveBeenCalled();
  });

  it('隔离验收实例（ENSO_VERIFY=1）打开 DevTools 不抢焦点，已打开也不 focus', () => {
    mocks.verifyLaunch = true;
    expect(handler(fromSettings())).toEqual({ ok: true });
    expect(mocks.contents.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: false });

    mocks.contents.isDevToolsOpened.mockReturnValue(true);
    expect(handler(fromSettings())).toEqual({ ok: true });
    expect(mocks.contents.devToolsWebContents?.focus).not.toHaveBeenCalled();
  });

  it('Electron 抛错时转成错误结果', () => {
    mocks.contents.openDevTools.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(handler(fromSettings())).toEqual({ ok: false, error: 'boom' });
  });

  it('不接受任何参数', () => {
    expect(handler(fromSettings(), { mode: 'right' })).toEqual({
      ok: false,
      error: 'invalid-arguments',
    });
    expect(mocks.contents.openDevTools).not.toHaveBeenCalled();
  });

  it('拒绝非本机主窗口/设置窗口的调用者（防止外部页面或节点页面调用）', () => {
    expect(handler({ sender: { id: 999 } })).toEqual({ ok: false, error: 'forbidden' });
    expect(handler({})).toEqual({ ok: false, error: 'forbidden' });
    expect(mocks.contents.openDevTools).not.toHaveBeenCalled();
  });

  it('只在本机可用：远程浏览器与远程节点界面都调不到', () => {
    expect(isRemoteChannelAllowed(IPC_CHANNELS.WINDOW_OPEN_DEV_TOOLS, true, true)).toBe(false);
    expect(parseLocalCall(IPC_CHANNELS.WINDOW_OPEN_DEV_TOOLS, '[]')).toBeNull();
  });
});
