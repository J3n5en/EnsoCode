import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  handle: vi.fn(),
  send: vi.fn(),
  switchNode: vi.fn(),
  window: null as null | { isDestroyed(): boolean },
  present: vi.fn(),
  focused: true,
}));

vi.mock('electron', () => ({ ipcMain: { on: mocks.on, handle: mocks.handle } }));
vi.mock('../services/renderers', () => ({
  isMainRenderer: (id: number) => id === 2 || id === 7,
  localMainContents: () => ({ id: 2 }),
  anyRendererFocused: () => mocks.focused,
}));
vi.mock('../services/nodeRemote', () => ({ switchNode: mocks.switchNode }));
vi.mock('../windows/createAppWindow', () => ({ sendToWindow: mocks.send }));
vi.mock('../windows/MainWindow', () => ({ getMainWindow: () => mocks.window }));
vi.mock('../windows/verifyLaunch', () => ({ presentWindow: mocks.present }));

import {
  clearRestartOverlay,
  registerAppRestartHandlers,
  setRestartOverlay,
  waitWithExitDialog,
} from './appRestart';

const listenerOf = (spy: typeof mocks.on, channel: string) =>
  spy.mock.calls.find(([name]) => name === channel)?.[1];
const pushed = () => mocks.send.mock.calls.map((call) => call[2]);

describe('app restart IPC', () => {
  beforeEach(() => {
    setRestartOverlay(null);
    mocks.on.mockClear();
    mocks.handle.mockClear();
    mocks.send.mockClear();
    mocks.switchNode.mockClear();
    mocks.present.mockClear();
    mocks.window = { isDestroyed: () => false };
  });

  it('强制退出只认主窗口，只在等命令时生效，并带上是哪条路径在等', () => {
    const forceQuit = vi.fn();
    registerAppRestartHandlers(forceQuit);
    const listener = listenerOf(mocks.on, IPC_CHANNELS.APP_RESTART_FORCE);
    listener({ sender: { id: 2 } });
    setRestartOverlay({ phase: 'restarting' });
    listener({ sender: { id: 2 } });
    expect(forceQuit).not.toHaveBeenCalled();
    setRestartOverlay({ phase: 'waiting', reason: 'tool', exit: 'update' });
    listener({ sender: { id: 9 } });
    expect(forceQuit).not.toHaveBeenCalled();
    listener({ sender: { id: 2 } });
    expect(forceQuit).toHaveBeenCalledExactlyOnceWith('update');
  });

  it('弹层状态推给主窗口并切回本机界面；关弹层不切', () => {
    setRestartOverlay({ phase: 'restarting' });
    expect(mocks.send).toHaveBeenLastCalledWith(mocks.window, IPC_CHANNELS.APP_RESTART_WAITING, {
      phase: 'restarting',
    });
    expect(mocks.switchNode).toHaveBeenCalledWith('local');
    setRestartOverlay({ phase: 'waiting', reason: 'background-not-detachable', exit: 'restart' });
    expect(mocks.send).toHaveBeenLastCalledWith(mocks.window, IPC_CHANNELS.APP_RESTART_WAITING, {
      phase: 'waiting',
      reason: 'background-not-detachable',
      exit: 'restart',
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
    mocks.window = null;
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

  it('按归属关：恢复超时 / 结束只关恢复提示，不动之后开的重启弹层', () => {
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

  it('关弹层只认开它的那条路径：「正在重启」归 restart，等命令归 exit', () => {
    setRestartOverlay({ phase: 'waiting', reason: 'tool', exit: 'quit' });
    clearRestartOverlay('restart');
    clearRestartOverlay('update');
    clearRestartOverlay('resuming');
    expect(pushed()).toEqual([{ phase: 'waiting', reason: 'tool', exit: 'quit' }]);
    clearRestartOverlay('quit');
    expect(pushed()).toHaveLength(2);
    expect(pushed()[1]).toBeNull();

    mocks.send.mockClear();
    setRestartOverlay({ phase: 'restarting' });
    clearRestartOverlay('quit');
    clearRestartOverlay('restart');
    expect(pushed()).toEqual([{ phase: 'restarting' }, null]);
  });

  it.each(['update', 'quit'] as const)(
    '%s：没有命令在跑不弹；有命令在跑开弹层，等完先关弹层再往下走',
    async (exit) => {
      await expect(waitWithExitDialog(exit, async () => 'skipped')).resolves.toBe('skipped');
      expect(mocks.send).not.toHaveBeenCalled();

      const prepared = Promise.withResolvers<string>();
      let report: ((reason: 'tool' | 'background-not-detachable') => void) | undefined;
      const waited = waitWithExitDialog(exit, (onWaitingForTools) => {
        report = onWaitingForTools;
        return prepared.promise;
      });
      report?.('tool');
      expect(pushed()).toEqual([{ phase: 'waiting', reason: 'tool', exit }]);
      prepared.resolve('checkpointed');
      await expect(waited).resolves.toBe('checkpointed');
      expect(pushed()).toEqual([{ phase: 'waiting', reason: 'tool', exit }, null]);
      // 等完之后迟到的回调不再把弹层开回来
      report?.('tool');
      expect(pushed()).toHaveLength(2);
    }
  );

  it('等安全点出错也关掉弹层，错误交给调用方', async () => {
    const waited = waitWithExitDialog('quit', (onWaitingForTools) => {
      onWaitingForTools('tool');
      return Promise.reject(new Error('boom'));
    });
    await expect(waited).rejects.toThrow('boom');
    expect(pushed()).toEqual([{ phase: 'waiting', reason: 'tool', exit: 'quit' }, null]);
  });

  it('开始等命令时把主窗口唤到前台：设置窗口里点的重启更新也看得见等待层', () => {
    setRestartOverlay({ phase: 'restarting' });
    expect(mocks.present).not.toHaveBeenCalled();
    setRestartOverlay({ phase: 'waiting', reason: 'tool', exit: 'update' });
    setRestartOverlay({ phase: 'waiting', reason: 'background-not-detachable', exit: 'update' });
    expect(mocks.present).toHaveBeenCalledExactlyOnceWith(mocks.window);
  });

  it('后台自动重启（用户在用别的应用）开等待层不抢焦点', () => {
    mocks.focused = false;
    setRestartOverlay({ phase: 'waiting', reason: 'tool', exit: 'update' });
    expect(mocks.present).not.toHaveBeenCalled();
    expect(pushed()).toContainEqual({ phase: 'waiting', reason: 'tool', exit: 'update' });
    mocks.focused = true;
  });
});
