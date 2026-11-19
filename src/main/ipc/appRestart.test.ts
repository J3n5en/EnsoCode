import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  send: vi.fn(),
  window: null as null | { isDestroyed(): boolean },
}));

vi.mock('electron', () => ({ ipcMain: { on: mocks.on } }));
vi.mock('../services/renderers', () => ({ isMainRenderer: (id: number) => id === 2 }));
vi.mock('../windows/createAppWindow', () => ({ sendToWindow: mocks.send }));
vi.mock('../windows/MainWindow', () => ({ getMainWindow: () => mocks.window }));

import { notifyRestartWaiting, registerAppRestartHandlers } from './appRestart';

describe('app restart IPC', () => {
  beforeEach(() => {
    mocks.on.mockClear();
    mocks.send.mockClear();
    mocks.window = null;
  });

  it('强制退出只认主窗口', () => {
    const forceQuit = vi.fn();
    registerAppRestartHandlers(forceQuit);
    const listener = mocks.on.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.APP_RESTART_FORCE
    )?.[1];
    listener({ sender: { id: 9 } });
    expect(forceQuit).not.toHaveBeenCalled();
    listener({ sender: { id: 2 } });
    expect(forceQuit).toHaveBeenCalledTimes(1);
  });

  it('等待开关推给主窗口 UI；没有主窗口不推', () => {
    notifyRestartWaiting(true);
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.window = { isDestroyed: () => false };
    notifyRestartWaiting(true);
    expect(mocks.send).toHaveBeenCalledWith(mocks.window, IPC_CHANNELS.APP_RESTART_WAITING, true);
  });
});
