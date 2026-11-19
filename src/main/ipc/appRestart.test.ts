import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  send: vi.fn(),
  switchNode: vi.fn(),
  window: null as null | { isDestroyed(): boolean },
}));

vi.mock('electron', () => ({ ipcMain: { on: mocks.on } }));
vi.mock('../services/renderers', () => ({ isMainRenderer: (id: number) => id === 2 }));
vi.mock('../services/nodeRemote', () => ({ switchNode: mocks.switchNode }));
vi.mock('../windows/createAppWindow', () => ({ sendToWindow: mocks.send }));
vi.mock('../windows/MainWindow', () => ({ getMainWindow: () => mocks.window }));

import { notifyRestartWaiting, registerAppRestartHandlers, waitWithExitDialog } from './appRestart';

const pushed = () => mocks.send.mock.calls.map((call) => call.slice(2));

describe('app restart IPC', () => {
  beforeEach(() => {
    mocks.on.mockClear();
    mocks.send.mockClear();
    mocks.switchNode.mockClear();
    mocks.window = { isDestroyed: () => false };
  });
  afterEach(() => {
    for (const exit of ['restart', 'update', 'quit'] as const)
      notifyRestartWaiting(false, undefined, exit);
  });

  it('强制退出只认主窗口，只在弹层开着时生效，并带上是哪条路径在等', () => {
    const forceQuit = vi.fn();
    registerAppRestartHandlers(forceQuit);
    const listener = mocks.on.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.APP_RESTART_FORCE
    )?.[1];
    listener({ sender: { id: 2 } });
    expect(forceQuit).not.toHaveBeenCalled();
    notifyRestartWaiting(true, 'tool', 'update');
    listener({ sender: { id: 9 } });
    expect(forceQuit).not.toHaveBeenCalled();
    listener({ sender: { id: 2 } });
    expect(forceQuit).toHaveBeenCalledExactlyOnceWith('update');
  });

  it('等待开关只推给主窗口 UI，带上原因和等完要做什么；开弹层时切回本机界面', () => {
    mocks.window = null;
    notifyRestartWaiting(true);
    expect(mocks.send).not.toHaveBeenCalled();
    notifyRestartWaiting(false);
    mocks.window = { isDestroyed: () => false };
    notifyRestartWaiting(true);
    expect(mocks.send).toHaveBeenLastCalledWith(
      mocks.window,
      IPC_CHANNELS.APP_RESTART_WAITING,
      true,
      'tool',
      'restart'
    );
    expect(mocks.switchNode).toHaveBeenCalledWith('local');
    notifyRestartWaiting(true, 'background-not-detachable', 'restart');
    notifyRestartWaiting(false, 'tool', 'restart');
    expect(pushed()).toEqual([
      [true, 'tool', 'restart'],
      [true, 'background-not-detachable', 'restart'],
      [false, undefined, undefined],
    ]);
  });

  it('关弹层只认开它的那条路径', () => {
    notifyRestartWaiting(true, 'tool', 'quit');
    notifyRestartWaiting(false, undefined, 'restart');
    notifyRestartWaiting(false, undefined, 'update');
    expect(pushed()).toEqual([[true, 'tool', 'quit']]);
    notifyRestartWaiting(false, undefined, 'quit');
    expect(pushed()).toEqual([
      [true, 'tool', 'quit'],
      [false, undefined, undefined],
    ]);
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
      expect(pushed()).toEqual([[true, 'tool', exit]]);
      prepared.resolve('checkpointed');
      await expect(waited).resolves.toBe('checkpointed');
      expect(pushed()).toEqual([
        [true, 'tool', exit],
        [false, undefined, undefined],
      ]);
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
    expect(pushed()).toEqual([
      [true, 'tool', 'quit'],
      [false, undefined, undefined],
    ]);
  });
});
