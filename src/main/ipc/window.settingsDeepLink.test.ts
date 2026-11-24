import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  settingsWindow: null as { isDestroyed: () => boolean } | null,
  sent: [] as Array<{ channel: string; args: unknown[] }>,
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
  getSettingsWindow: () => mocks.settingsWindow,
  openSettingsWindow: () => {
    mocks.settingsWindow ??= { isDestroyed: () => false };
    return mocks.settingsWindow;
  },
}));
vi.mock('../windows/createAppWindow', () => ({
  getWindowWebContents: vi.fn(),
  sendToWindow: (_win: unknown, channel: string, ...args: unknown[]) =>
    mocks.sent.push({ channel, args }),
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

const { registerWindowHandlers } = await import('./window');
registerWindowHandlers();

const openSettings = (link?: unknown) =>
  mocks.handlers.get(IPC_CHANNELS.WINDOW_OPEN_SETTINGS)?.({}, link);
/** 设置页挂载时拉取的深链 */
const consumeOnMount = () => mocks.handlers.get(IPC_CHANNELS.SETTINGS_DEEP_LINK_CONSUME)?.();
/** 已挂载的设置页收到的深链 */
const liveLinks = () =>
  mocks.sent.filter((m) => m.channel === IPC_CHANNELS.SETTINGS_DEEP_LINK).map((m) => m.args[0]);
const closeSettingsWindow = () => {
  mocks.settingsWindow = null;
};

beforeEach(() => {
  closeSettingsWindow();
  consumeOnMount();
  mocks.sent.length = 0;
});

describe('设置窗口深链', () => {
  it('窗口未打开：新窗口挂载时拿到日志页深链', () => {
    openSettings({ category: 'logs' });
    expect(consumeOnMount()).toMatchObject({ category: 'logs' });
    expect(consumeOnMount()).toBeNull();
  });

  it('窗口已打开（停在通用页）：深链直接推给已挂载的页面', () => {
    openSettings();
    consumeOnMount();
    openSettings({ category: 'logs' });
    expect(liveLinks()).toEqual([expect.objectContaining({ category: 'logs' })]);
  });

  it('已打开时推送过的深链不留到下一次新开窗口', () => {
    openSettings();
    consumeOnMount();
    openSettings({ category: 'logs', rowId: 'logs.root' });
    closeSettingsWindow();
    openSettings();
    expect(consumeOnMount()).toBeNull();
  });
});
