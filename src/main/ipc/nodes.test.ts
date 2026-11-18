import type { RendererContents } from '@platform';
import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 主窗口 UI 跑在独立的顶层 WebContentsView 里（createPinnedWorkbench），
 * `win.webContents` 只是 BrowserWindow 自带的空壳，没有 preload 监听。
 * 节点状态必须发到 getWindowWebContents(win)，否则渲染层永远收不到，节点点一直灰（b968fdf 漏改了 nodes.ts）。
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
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => [mocks.mainWindow]) },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

// 桌面 LocalUi 负责把窗口解析成 UI webContents（见 desktop/localUi）；这里直接给出解析结果
vi.mock('../services/uiHost', async () =>
  (await import('../../../test/helpers/localUi')).mockUiHost(
    () => [{ isDestroyed: () => false, webContents: mocks.uiContents }],
    { mainContents: () => mocks.uiContents as unknown as RendererContents }
  )
);

vi.mock('../services/pairGuest', () => ({
  getNodesStatus: vi.fn(),
  pairNode: vi.fn(),
  removeNode: vi.fn(),
  renameNode: vi.fn(),
  setNodesStatusListener: vi.fn((listener: (status: unknown) => void) => {
    mocks.statusListener = listener;
  }),
}));

describe('registerNodesHandlers → renderer 推送目标', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.statusListener = null;
    const { registerNodesHandlers } = await import('./nodes');
    registerNodesHandlers();
  });

  it('NODES_STATUS_CHANGED 发到 UI webContents，而不是 BrowserWindow 的空壳', () => {
    const status = { nodes: [], secureStorage: true };
    mocks.statusListener?.(status);
    expect(mocks.uiContents.send).toHaveBeenCalledWith(IPC_CHANNELS.NODES_STATUS_CHANGED, status);
    expect(mocks.shellContents.send).not.toHaveBeenCalled();
  });
});
