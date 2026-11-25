import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeWindow = ReturnType<typeof fakeWindow>;

const mocks = vi.hoisted(() => ({
  created: [] as Array<{ entry: string }>,
  next: null as unknown,
  sent: [] as Array<{ win: unknown; channel: string }>,
  serverMode: false,
  leaveServerMode: vi.fn(),
  switchNode: vi.fn(),
}));

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('./createAppWindow', () => ({
  createAppWindow: (options: { entry: string }) => {
    mocks.created.push(options);
    return mocks.next;
  },
  getWindowWebContents: vi.fn(),
  sendToWindow: (win: unknown, channel: string) => mocks.sent.push({ win, channel }),
}));
vi.mock('../services/appCloseConfirm', () => ({ attachAppCloseConfirm: vi.fn() }));
vi.mock('../services/nodeRemote', () => ({ switchNode: mocks.switchNode }));
vi.mock('../services/remoteRenderer/senders', () => ({ isRemoteMainSender: () => false }));
vi.mock('../services/appServerMode', () => ({
  isServerMode: () => mocks.serverMode,
  leaveServerMode: mocks.leaveServerMode,
}));

function fakeWindow(state: { minimized?: boolean; visible?: boolean } = {}) {
  let minimized = state.minimized ?? false;
  let visible = state.visible ?? true;
  return {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    isVisible: () => visible,
    restore: vi.fn(() => {
      minimized = false;
    }),
    show: vi.fn(() => {
      visible = true;
    }),
    focus: vi.fn(),
    on: vi.fn(),
  };
}

const { createMainWindow } = await import('./MainWindow');
const { openSettingsInMainWindow, takeSettingsOpenRequest } = await import('./mainSettings');

function withMainWindow(win: FakeWindow): FakeWindow {
  mocks.next = win;
  createMainWindow();
  mocks.created.length = 0;
  return win;
}

const pushes = () => mocks.sent.filter((m) => m.channel === IPC_CHANNELS.SETTINGS_DEEP_LINK);

beforeEach(() => {
  takeSettingsOpenRequest();
  mocks.created.length = 0;
  mocks.sent.length = 0;
  mocks.serverMode = false;
  mocks.leaveServerMode.mockClear();
  mocks.switchNode.mockClear();
});

describe('本机「打开设置」入口都落到主窗口里的内嵌设置', () => {
  it('主窗口最小化：先恢复、显示并聚焦，再推送打开请求；不新开窗口', () => {
    const win = withMainWindow(fakeWindow({ minimized: true }));
    openSettingsInMainWindow({ category: 'logs', rowId: 'logs.root' });
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.isMinimized()).toBe(false);
    expect(win.focus).toHaveBeenCalled();
    expect(mocks.created).toEqual([]);
    expect(pushes()).toEqual([{ win, channel: IPC_CHANNELS.SETTINGS_DEEP_LINK }]);
    expect(takeSettingsOpenRequest()).toEqual({
      link: { category: 'logs', rowId: 'logs.root' },
    });
  });

  it('主窗口被隐藏（⌘H / 关到后台）：重新显示', () => {
    const win = withMainWindow(fakeWindow({ visible: false }));
    openSettingsInMainWindow();
    expect(win.show).toHaveBeenCalled();
    expect(win.isVisible()).toBe(true);
    expect(mocks.created).toEqual([]);
  });

  it('盖着远程节点时切回本机界面再打开', () => {
    withMainWindow(fakeWindow());
    openSettingsInMainWindow();
    expect(mocks.switchNode).toHaveBeenCalledWith('local');
  });

  it('连开多次也只用同一个主窗口', () => {
    const win = withMainWindow(fakeWindow());
    openSettingsInMainWindow();
    openSettingsInMainWindow({ category: 'plugins', rowId: 'plugins.root' });
    expect(mocks.created).toEqual([]);
    expect(pushes().map((p) => p.win)).toEqual([win, win]);
  });

  it('托盘态（主窗口已销毁）：退出托盘由它重建主窗口，这里不再另开窗口', () => {
    mocks.serverMode = true;
    mocks.next = null;
    openSettingsInMainWindow({ category: 'secretary', rowId: 'secretary.dispatchLimit' });
    expect(mocks.leaveServerMode).toHaveBeenCalledTimes(1);
    expect(mocks.created).toEqual([]);
    expect(takeSettingsOpenRequest()).toEqual({
      link: { category: 'secretary', rowId: 'secretary.dispatchLimit' },
    });
  });

  it('请求只被取走一次；不带深链的请求也要能取到（回到上次的分区）', () => {
    withMainWindow(fakeWindow());
    openSettingsInMainWindow();
    expect(takeSettingsOpenRequest()).toEqual({ link: null });
    expect(takeSettingsOpenRequest()).toBeNull();
  });
});

describe('主窗口还没创建', () => {
  it('只新建一个主窗口（不是设置窗口），打开请求留给它挂载时拉取', async () => {
    vi.resetModules();
    mocks.created.length = 0;
    mocks.next = fakeWindow();
    const fresh = await import('./mainSettings');
    fresh.openSettingsInMainWindow({ category: 'plugins', rowId: 'plugins.enso' });
    expect(mocks.created.map((options) => options.entry)).toEqual(['index']);
    expect(fresh.takeSettingsOpenRequest()).toEqual({
      link: { category: 'plugins', rowId: 'plugins.enso' },
    });
  });
});
