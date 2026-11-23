import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLocalCall } from '../services/nodeRemote/boundary';
import { isRemoteChannelAllowed } from '../services/remoteRenderer/channels';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  getMainWindow: vi.fn(),
  contents: {
    isDestroyed: vi.fn(() => false),
    isDevToolsOpened: vi.fn(() => false),
    openDevTools: vi.fn(),
    devToolsWebContents: { focus: vi.fn() } as { focus: () => void } | null,
  },
}));

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock('../windows/MainWindow', () => ({ getMainWindow: mocks.getMainWindow }));
vi.mock('../windows/createAppWindow', () => ({ getWindowWebContents: () => mocks.contents }));

import { registerDevToolsHandlers } from './devTools';

const mainWindow = (destroyed = false) => ({ isDestroyed: () => destroyed });

let handler: (event: unknown, ...args: unknown[]) => unknown;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contents.isDestroyed.mockReturnValue(false);
  mocks.contents.isDevToolsOpened.mockReturnValue(false);
  mocks.getMainWindow.mockReturnValue(mainWindow());
  registerDevToolsHandlers();
  handler = mocks.handle.mock.calls.find(([ch]) => ch === IPC_CHANNELS.WINDOW_OPEN_DEV_TOOLS)?.[1];
});

describe('WINDOW_OPEN_DEV_TOOLS', () => {
  it('对主窗口 UI 的 webContents 以独立窗口打开 DevTools', () => {
    expect(handler({})).toEqual({ ok: true });
    expect(mocks.contents.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
  });

  it('主窗口不存在或已销毁时返回可读错误，不抛异常', () => {
    mocks.getMainWindow.mockReturnValue(null);
    expect(handler({})).toEqual({ ok: false, error: 'main-window-unavailable' });
    mocks.getMainWindow.mockReturnValue(mainWindow(true));
    expect(handler({})).toEqual({ ok: false, error: 'main-window-unavailable' });
    mocks.getMainWindow.mockReturnValue(mainWindow());
    mocks.contents.isDestroyed.mockReturnValue(true);
    expect(handler({})).toEqual({ ok: false, error: 'main-window-unavailable' });
    expect(mocks.contents.openDevTools).not.toHaveBeenCalled();
  });

  it('DevTools 已开着时只把它提到前面，不重复打开', () => {
    mocks.contents.isDevToolsOpened.mockReturnValue(true);
    expect(handler({})).toEqual({ ok: true });
    expect(mocks.contents.openDevTools).not.toHaveBeenCalled();
    expect(mocks.contents.devToolsWebContents?.focus).toHaveBeenCalled();
  });

  it('Electron 抛错时转成错误结果', () => {
    mocks.contents.openDevTools.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(handler({})).toEqual({ ok: false, error: 'boom' });
  });

  it('不接受任何参数', () => {
    expect(handler({}, { mode: 'right' })).toEqual({ ok: false, error: 'invalid-arguments' });
    expect(mocks.contents.openDevTools).not.toHaveBeenCalled();
  });

  it('只在本机可用：远程浏览器与远程节点界面都调不到', () => {
    expect(isRemoteChannelAllowed(IPC_CHANNELS.WINDOW_OPEN_DEV_TOOLS, true, true)).toBe(false);
    expect(parseLocalCall(IPC_CHANNELS.WINDOW_OPEN_DEV_TOOLS, '[]')).toBeNull();
  });
});
