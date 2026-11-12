import { describe, expect, it, vi } from 'vitest';

/**
 * 主窗口 UI 跑在独立的 WebContentsView 里，`win.webContents` 只是没有 preload 的空壳。
 * 核心层经 LocalUi 广播，必须拿到 getWindowWebContents(win) 解析出的 UI webContents。
 */
const mocks = vi.hoisted(() => {
  const shell = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const ui = { id: 2, isDestroyed: () => false, send: vi.fn() };
  const win = { isDestroyed: () => false, isFocused: () => false, webContents: shell };
  const appListeners = new Map<string, (...args: unknown[]) => void>();
  return { shell, ui, win, appListeners };
});

vi.mock('electron', () => ({
  app: {
    on: (event: string, listener: (...args: unknown[]) => void) =>
      mocks.appListeners.set(event, listener),
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [mocks.win] },
  session: { fromPartition: vi.fn() },
  webContents: { getAllWebContents: () => [] },
}));
vi.mock('../windows/createAppWindow', () => ({
  getWindowWebContents: () => mocks.ui,
  getWorkbenchView: () => ({ webContents: mocks.ui }),
}));
vi.mock('../windows/MainWindow', () => ({
  getMainWindow: () => mocks.win,
  focusMainWindow: vi.fn(),
}));
vi.mock('../windows/SettingsWindow', () => ({ getSettingsWindow: () => null }));
vi.mock('../services/appServerMode', () => ({ isServerMode: () => false }));

describe('desktop LocalUi', () => {
  it('resolves windows to their UI webContents, not the shell', async () => {
    const { installDesktopLocalUi } = await import('./localUi');
    const { broadcastToRenderers, isMainRenderer, sendToLocalMain } = await import(
      '../services/renderers'
    );
    installDesktopLocalUi();

    broadcastToRenderers('ch:all', 1);
    sendToLocalMain('ch:main', 2);

    expect(mocks.ui.send).toHaveBeenCalledWith('ch:all', 1);
    expect(mocks.ui.send).toHaveBeenCalledWith('ch:main', 2);
    expect(mocks.shell.send).not.toHaveBeenCalled();
    expect(isMainRenderer(mocks.ui.id)).toBe(true);
    expect(isMainRenderer(mocks.shell.id)).toBe(false);
  });

  // 真实场景：locked Enso child 的能力询问未回答时把主窗口关到托盘（窗口被 destroy）。询问归属记的是
  // pinned view 的 id（event.sender.id），只按外壳 id 释放永远匹配不到，之后所有询问都排在它后面
  it('主窗口关闭时上报 UI webContents 的 id，能力网关才能释放它名下的询问', async () => {
    const { installDesktopLocalUi } = await import('./localUi');
    const { localUi } = await import('../services/uiHost');
    installDesktopLocalUi();
    const closedIds: number[] = [];
    localUi()?.onWindowClosed((id) => closedIds.push(id));

    let emitClosed = () => {};
    const window = {
      webContents: mocks.shell,
      once: (event: string, listener: () => void) => {
        if (event === 'closed') emitClosed = listener;
      },
    };
    mocks.appListeners.get('browser-window-created')?.({}, window);
    emitClosed();

    expect(closedIds).toContain(mocks.ui.id);
  });
});
