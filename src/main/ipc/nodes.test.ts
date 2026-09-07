import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 主窗口 UI 跑在独立的顶层 WebContentsView 里（createPinnedWorkbench），
 * `win.webContents` 只是 BrowserWindow 自带的空壳，没有 preload 监听。
 * 节点状态/下行帧必须发到 getWindowWebContents(win)，否则渲染层永远收不到，
 * 节点点一直灰、会话一直转圈（b968fdf 漏改了 nodes.ts）。
 */

const mocks = vi.hoisted(() => {
  const shellContents = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const uiContents = { id: 2, isDestroyed: () => false, send: vi.fn() };
  const mainWindow = { isDestroyed: () => false, webContents: shellContents };
  return {
    shellContents,
    uiContents,
    mainWindow,
    statusListener: null as ((status: unknown) => void) | null,
    messageListener: null as ((message: unknown) => void) | null,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => [mocks.mainWindow]) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

vi.mock('../windows/createAppWindow', () => ({
  getWindowWebContents: vi.fn(() => mocks.uiContents),
  sendToWindow: vi.fn((_win: unknown, channel: string, ...args: unknown[]) => {
    mocks.uiContents.send(channel, ...args);
  }),
  sendToAllWindows: vi.fn((channel: string, ...args: unknown[]) => {
    mocks.uiContents.send(channel, ...args);
  }),
}));

vi.mock('../windows/MainWindow', () => ({
  // 与真实实现同口径：比较的是 UI webContents 的 id，不是 win.webContents.id
  isMainWebContents: vi.fn((id: number) => id === mocks.uiContents.id),
}));

vi.mock('../services/pairGuest', () => ({
  getNodesStatus: vi.fn(),
  pairNode: vi.fn(),
  removeNode: vi.fn(),
  renameNode: vi.fn(),
  sendToNode: vi.fn(),
  setNodesStatusListener: vi.fn((listener: (status: unknown) => void) => {
    mocks.statusListener = listener;
  }),
  setNodesMessageListener: vi.fn((listener: (message: unknown) => void) => {
    mocks.messageListener = listener;
  }),
}));

vi.mock('../services/pairGuestPolicy', () => ({ parseGuestOutbound: vi.fn() }));

describe('registerNodesHandlers → renderer 推送目标', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.statusListener = null;
    mocks.messageListener = null;
    const { registerNodesHandlers } = await import('./nodes');
    registerNodesHandlers();
  });

  it('NODES_STATUS_CHANGED 发到 UI webContents，而不是 BrowserWindow 的空壳', () => {
    const status = { nodes: [], secureStorage: true };
    mocks.statusListener?.(status);
    expect(mocks.uiContents.send).toHaveBeenCalledWith(IPC_CHANNELS.NODES_STATUS_CHANGED, status);
    expect(mocks.shellContents.send).not.toHaveBeenCalled();
  });

  it('NODES_MESSAGE 发到主窗口的 UI webContents（isMainWebContents 按 UI id 判定）', () => {
    const message = { nodeId: 'n1', payload: { type: 'catalog', entries: [] } };
    mocks.messageListener?.(message);
    expect(mocks.uiContents.send).toHaveBeenCalledWith(IPC_CHANNELS.NODES_MESSAGE, message);
    expect(mocks.shellContents.send).not.toHaveBeenCalled();
  });
});
