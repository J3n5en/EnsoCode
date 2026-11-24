import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  mainWindow: { id: 'main' },
  openSettingsWindow: vi.fn(),
  focusMainWindow: vi.fn(),
  sent: [] as Array<{ win: unknown; channel: string; args: unknown[] }>,
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: {},
  Menu: {},
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, fn),
  },
}));
vi.mock('../windows/SettingsWindow', () => ({
  getSettingsWindow: () => null,
  openSettingsWindow: mocks.openSettingsWindow,
}));
vi.mock('../windows/createAppWindow', () => ({
  getWindowWebContents: vi.fn(),
  sendToWindow: (win: unknown, channel: string, ...args: unknown[]) =>
    mocks.sent.push({ win, channel, args }),
  TRAFFIC_LIGHT_POSITION: { x: 0, y: 0 },
}));
vi.mock('../windows/MainWindow', () => ({
  focusMainWindow: mocks.focusMainWindow.mockImplementation(() => mocks.mainWindow),
}));
vi.mock('../windows/dragRegionRefresh', () => ({ shouldRefreshDragRegions: vi.fn() }));
vi.mock('../desktop/shellCommand', () => ({
  readShellIntegrationStatusSync: vi.fn(),
  shellIntegrationAction: vi.fn(),
}));
vi.mock('../services/appMenu', () => ({ installAppMenu: vi.fn() }));
vi.mock('../services/nodeRemote', () => ({ sendToNodeViews: vi.fn() }));
vi.mock('./settings', () => ({ readLocale: () => 'zh' }));

const { openPluginInstallFromProtocol, registerWindowHandlers } = await import('./window');
registerWindowHandlers();

const openSettings = (link?: unknown) =>
  mocks.handlers.get(IPC_CHANNELS.WINDOW_OPEN_SETTINGS)?.({}, link);
/** 主窗口渲染层拉取暂存的深链（挂载时，或收到推送后） */
const consume = () => mocks.handlers.get(IPC_CHANNELS.SETTINGS_DEEP_LINK_CONSUME)?.();
const pushes = () => mocks.sent.filter((m) => m.channel === IPC_CHANNELS.SETTINGS_DEEP_LINK);

beforeEach(() => {
  consume();
  mocks.sent.length = 0;
  mocks.focusMainWindow.mockClear();
  mocks.openSettingsWindow.mockClear();
});

describe('设置深链投到主窗口的内嵌设置页', () => {
  it('不再打开独立设置窗口：聚焦主窗口并推送', () => {
    openSettings({ category: 'logs' });
    expect(mocks.openSettingsWindow).not.toHaveBeenCalled();
    expect(mocks.focusMainWindow).toHaveBeenCalledTimes(1);
    expect(pushes()).toEqual([
      {
        win: mocks.mainWindow,
        channel: IPC_CHANNELS.SETTINGS_DEEP_LINK,
        args: [expect.objectContaining({ category: 'logs' })],
      },
    ]);
  });

  it('主窗口渲染层还没挂上（推送丢了）：挂载时拉到日志页深链，只拉一次', () => {
    openSettings({ category: 'logs' });
    expect(consume()).toMatchObject({ category: 'logs', rowId: 'logs.root' });
    expect(consume()).toBeNull();
  });

  it('enso://install-plugin 落到插件页并带上安装地址', () => {
    openPluginInstallFromProtocol('https://example.com/p.zip');
    expect(consume()).toEqual({
      category: 'plugins',
      rowId: 'plugins.enso',
      pluginInstallUrl: 'https://example.com/p.zip',
    });
  });

  it('不带链接或链接非法：仍进设置，不残留上一条深链', () => {
    openSettings({ category: 'logs' });
    openSettings({ category: 'nope' });
    expect(pushes()).toHaveLength(2);
    expect(consume()).toBeNull();
  });
});
