import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  request: null as unknown,
  openSettingsInMainWindow: vi.fn(),
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
vi.mock('../windows/mainSettings', () => ({
  openSettingsInMainWindow: mocks.openSettingsInMainWindow,
  takeSettingsOpenRequest: () => mocks.request,
}));
vi.mock('../windows/createAppWindow', () => ({
  getWindowWebContents: vi.fn(),
  sendToWindow: vi.fn(),
  TRAFFIC_LIGHT_POSITION: { x: 0, y: 0 },
}));
vi.mock('../windows/MainWindow', () => ({ focusMainWindow: vi.fn() }));
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

beforeEach(() => mocks.openSettingsInMainWindow.mockClear());

describe('设置只在主窗口里打开', () => {
  it('enso://install-plugin 在主窗口打开插件页并带上安装地址', () => {
    openPluginInstallFromProtocol('https://example.com/p.zip');
    expect(mocks.openSettingsInMainWindow).toHaveBeenCalledWith({
      category: 'plugins',
      rowId: 'plugins.installUrl',
      pluginInstallUrl: 'https://example.com/p.zip',
    });
  });

  it('主窗口渲染层挂载或收到推送时拉取同一份打开请求', () => {
    mocks.request = { link: { category: 'logs', rowId: 'logs.root' } };
    expect(mocks.handlers.get(IPC_CHANNELS.SETTINGS_DEEP_LINK_CONSUME)?.()).toEqual(mocks.request);
  });

  it('没有任何开独立设置窗口的通道', () => {
    expect(Object.values(IPC_CHANNELS)).not.toContain('window:open-settings');
    expect(Object.values(IPC_CHANNELS)).not.toContain('nodes:open-settings');
    expect([...mocks.handlers.keys()].filter((channel) => /open-settings/.test(channel))).toEqual(
      []
    );
  });
});
