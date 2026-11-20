import { EventEmitter } from 'node:events';
import { IPC_CHANNELS } from '@shared/types';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: new EventEmitter(), ipcMain: new EventEmitter() }));
vi.mock('./updater/AutoUpdater', () => ({
  autoUpdaterService: { isQuittingForUpdate: () => false },
}));

import { app, ipcMain } from 'electron';
import { attachAppCloseConfirm, setBeforeConfirmedQuit } from './appCloseConfirm';

describe('app close confirmation visibility', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    app.removeAllListeners();
    ipcMain.removeAllListeners();
    setBeforeConfirmedQuit(null);
  });

  it.each(['close', 'before-quit'] as const)(
    'brings the confirmation host above settings on %s',
    (eventName) => {
      let focused = 'settings';
      const win = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        isMinimized: () => false,
        restore: vi.fn(),
        show: vi.fn(),
        focus: () => {
          focused = 'main';
        },
      });
      const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
      const send = vi.fn(() => focused);
      attachAppCloseConfirm(win, send, () => contents as unknown as WebContents, {
        interceptBeforeQuit: true,
        onTray: vi.fn(),
      });

      const preventDefault = vi.fn();
      (eventName === 'close' ? win : app).emit(eventName, { preventDefault });

      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focused).toBe('main');
      expect(send).toHaveBeenCalledWith(IPC_CHANNELS.APP_CLOSE_REQUEST, expect.any(String));
      expect(send).toHaveReturnedWith('main');
      expect(win.restore).not.toHaveBeenCalled();
      win.emit('closed');
    }
  );

  it('restores and shows a minimized hidden host before requesting confirmation', () => {
    let minimized = true;
    let visible = false;
    let focused = false;
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isMinimized: () => minimized,
      restore: () => {
        minimized = false;
      },
      show: () => {
        visible = true;
      },
      focus: () => {
        focused = visible && !minimized;
      },
    });
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    const send = vi.fn();
    attachAppCloseConfirm(win, send, () => contents as unknown as WebContents, {
      interceptBeforeQuit: true,
      onTray: vi.fn(),
    });

    app.emit('before-quit', { preventDefault: vi.fn() });

    expect({ minimized, visible, focused }).toEqual({
      minimized: false,
      visible: true,
      focused: true,
    });
    expect(send).toHaveBeenCalledOnce();
    win.emit('closed');
  });

  it('确认退出后先等命令（期间主窗口弹等待层），等完才真正退出；等待中再按 Cmd+Q 不重复问', async () => {
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    });
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    const send = vi.fn();
    attachAppCloseConfirm(win, send, () => contents as unknown as WebContents, {
      interceptBeforeQuit: true,
      onTray: vi.fn(),
    });
    const waited = Promise.withResolvers<void>();
    const beforeQuit = vi.fn(() => waited.promise);
    setBeforeConfirmedQuit(beforeQuit);
    const quit = vi.fn();
    Object.assign(app, { quit });

    app.emit('before-quit', { preventDefault: vi.fn() });
    const requestId = send.mock.calls[0][1];
    ipcMain.emit(IPC_CHANNELS.APP_CLOSE_RESPONSE, { sender: contents }, requestId, {
      action: 'quit',
    });
    await vi.waitFor(() => expect(beforeQuit).toHaveBeenCalledOnce());
    expect(quit).not.toHaveBeenCalled();

    const again = vi.fn();
    app.emit('before-quit', { preventDefault: again });
    expect(again).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();

    waited.resolve();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    win.emit('closed');
  });

  it('等命令出错：记日志照常退出，不卡住', async () => {
    // 上一条已放行退出（模块级 allowQuit），换一份干净的模块
    vi.resetModules();
    const fresh = await import('./appCloseConfirm');
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    });
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    const send = vi.fn();
    fresh.attachAppCloseConfirm(win, send, () => contents as unknown as WebContents, {
      interceptBeforeQuit: true,
      onTray: vi.fn(),
    });
    fresh.setBeforeConfirmedQuit(() => Promise.reject(new Error('boom')));
    const quit = vi.fn();
    Object.assign(app, { quit });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    win.emit('close', { preventDefault: vi.fn() });
    ipcMain.emit(IPC_CHANNELS.APP_CLOSE_RESPONSE, { sender: contents }, send.mock.calls[0][1], {
      action: 'quit',
    });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    expect(log).toHaveBeenCalled();
    log.mockRestore();
    win.emit('closed');
  });
});
