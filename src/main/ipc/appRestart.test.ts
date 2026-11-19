import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  handle: vi.fn(),
  send: vi.fn(),
  switchNode: vi.fn(),
  window: null as null | { isDestroyed(): boolean },
}));

vi.mock('electron', () => ({ ipcMain: { on: mocks.on, handle: mocks.handle } }));
vi.mock('../services/renderers', () => ({
  isMainRenderer: (id: number) => id === 2 || id === 7,
  localMainContents: () => ({ id: 2 }),
}));
vi.mock('../services/nodeRemote', () => ({ switchNode: mocks.switchNode }));
vi.mock('../windows/createAppWindow', () => ({ sendToWindow: mocks.send }));
vi.mock('../windows/MainWindow', () => ({ getMainWindow: () => mocks.window }));

import { clearRestartOverlay, registerAppRestartHandlers, setRestartOverlay } from './appRestart';

const listenerOf = (spy: typeof mocks.on, channel: string) =>
  spy.mock.calls.find(([name]) => name === channel)?.[1];

describe('app restart IPC', () => {
  beforeEach(() => {
    setRestartOverlay(null);
    mocks.on.mockClear();
    mocks.handle.mockClear();
    mocks.send.mockClear();
    mocks.switchNode.mockClear();
    mocks.window = null;
  });

  it('强制退出只认主窗口', () => {
    const forceQuit = vi.fn();
    registerAppRestartHandlers(forceQuit);
    const listener = listenerOf(mocks.on, IPC_CHANNELS.APP_RESTART_FORCE);
    listener({ sender: { id: 9 } });
    expect(forceQuit).not.toHaveBeenCalled();
    listener({ sender: { id: 2 } });
    expect(forceQuit).toHaveBeenCalledTimes(1);
  });

  it('弹层状态推给主窗口并切回本机界面；关弹层不切', () => {
    mocks.window = { isDestroyed: () => false };
    setRestartOverlay({ phase: 'restarting' });
    expect(mocks.send).toHaveBeenLastCalledWith(mocks.window, IPC_CHANNELS.APP_RESTART_WAITING, {
      phase: 'restarting',
    });
    expect(mocks.switchNode).toHaveBeenCalledWith('local');
    setRestartOverlay({ phase: 'waiting', reason: 'background-not-detachable' });
    expect(mocks.send).toHaveBeenLastCalledWith(mocks.window, IPC_CHANNELS.APP_RESTART_WAITING, {
      phase: 'waiting',
      reason: 'background-not-detachable',
    });
    mocks.switchNode.mockClear();
    setRestartOverlay(null);
    expect(mocks.send).toHaveBeenLastCalledWith(
      mocks.window,
      IPC_CHANNELS.APP_RESTART_WAITING,
      null
    );
    expect(mocks.switchNode).not.toHaveBeenCalled();
  });

  it('主窗口还没起来：不推，但记住状态，主窗口挂载时来取；只回本机主窗口', () => {
    registerAppRestartHandlers(vi.fn());
    const get = listenerOf(mocks.handle, IPC_CHANNELS.APP_RESTART_WAITING_GET);
    expect(get({ sender: { id: 2 } })).toBeNull();
    setRestartOverlay({ phase: 'resuming' });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(get({ sender: { id: 2 } })).toEqual({ phase: 'resuming' });
    // 远程主界面（节点页面 / 浏览器）与其它窗口都拿不到
    expect(get({ sender: { id: 7 } })).toBeNull();
    expect(get({ sender: { id: 9 } })).toBeNull();
  });

  it('按阶段关：恢复超时 / 结束只关恢复提示，不动之后开的重启弹层', () => {
    mocks.window = { isDestroyed: () => false };
    setRestartOverlay({ phase: 'resuming' });
    setRestartOverlay({ phase: 'restarting' });
    mocks.send.mockClear();
    clearRestartOverlay('resuming');
    expect(mocks.send).not.toHaveBeenCalled();
    setRestartOverlay({ phase: 'resuming' });
    clearRestartOverlay('resuming');
    expect(mocks.send).toHaveBeenLastCalledWith(
      mocks.window,
      IPC_CHANNELS.APP_RESTART_WAITING,
      null
    );
  });
});
