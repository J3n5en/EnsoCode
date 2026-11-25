import { IPC_CHANNELS } from '@shared/types/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendToLocalMain = vi.hoisted(() => vi.fn());
const openSettingsInMainWindow = vi.hoisted(() => vi.fn());
vi.mock('./renderers', () => ({ sendToLocalMain }));
vi.mock('../windows/mainSettings', () => ({ openSettingsInMainWindow }));

import { APP_DISPLAY_NAME, type AppMenuActions, macAppMenuTemplate } from './appMenu';
import type { AppRestartState } from './appRestart';

describe('macAppMenuTemplate', () => {
  beforeEach(() => sendToLocalMain.mockClear());

  it('labels app menu items with the product name instead of the package name', () => {
    const [appMenu] = macAppMenuTemplate();
    expect(appMenu.label).toBe(APP_DISPLAY_NAME);
    const items = appMenu.submenu as { role?: string; label?: string }[];
    const labelOf = (role: string) => items.find((item) => item.role === role)?.label;
    expect(labelOf('about')).toBe('About EnsoCode');
    expect(labelOf('hide')).toBe('Hide EnsoCode');
    expect(labelOf('quit')).toBe('Quit EnsoCode');
    expect(JSON.stringify(macAppMenuTemplate())).not.toContain('enso-code');
  });

  it('keeps the remaining default top-level menus', () => {
    const rest = macAppMenuTemplate().slice(1);
    expect(rest.map(({ label, role }) => ({ label, role }))).toEqual([
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { label: 'View' },
      { role: 'windowMenu' },
    ]);
  });

  it('View 菜单有显示/隐藏侧边栏，加速键 ⌘B，点击通知本机主界面切换', () => {
    const view = macAppMenuTemplate('zh').find((menu) => menu.label === 'View');
    const items = view?.submenu as {
      label?: string;
      role?: string;
      accelerator?: string;
      type?: string;
      click?: () => void;
    }[];
    const sidebar = items.find((item) => item.label === '显示/隐藏侧边栏');
    expect(sidebar).toBeDefined();
    expect(sidebar?.accelerator).toBe('CmdOrCtrl+B');
    expect(items.indexOf(sidebar ?? {})).toBe(0);
    expect(items[1]).toEqual({ type: 'separator' });
    // 其余仍是 Electron 默认 viewMenu 的条目，只是展开成显式模板
    expect(items.filter((item) => item.role).map((item) => item.role)).toEqual([
      'reload',
      'forceReload',
      'toggleDevTools',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'togglefullscreen',
    ]);
    sidebar?.click?.();
    expect(sendToLocalMain).toHaveBeenCalledWith(IPC_CHANNELS.WINDOW_TOGGLE_SIDEBAR);
    expect(sendToLocalMain).toHaveBeenCalledTimes(1);
  });

  it('puts shell integrations in their own translated menu in packaged builds', () => {
    const labels = (installed: boolean) => {
      const status = { ensoCommand: installed, finderQuickAction: installed };
      const menu = macAppMenuTemplate('zh', true, status).find((m) => m.label === '集成');
      return ((menu?.submenu ?? []) as { label?: string }[]).map((item) => item.label);
    };
    expect(labels(false)).toEqual(['在 PATH 中安装 enso 命令', '安装访达快速操作']);
    expect(labels(true)).toEqual(['卸载 enso 命令', '卸载访达快速操作']);
    const template = macAppMenuTemplate('zh', true, {
      ensoCommand: false,
      finderQuickAction: false,
    });
    const integrations = template.find((menu) => menu.label === '集成');
    expect(template.indexOf(integrations ?? {})).toBe(template.length - 2);
    expect(JSON.stringify(template[0])).not.toContain('enso 命令');
    expect(macAppMenuTemplate('zh', false).some((menu) => menu.label === '集成')).toBe(false);
  });

  it('应用菜单「设置…」紧跟关于，在主窗口里打开设置；不占 ⌘,（留给可改绑的快捷键）', () => {
    const items = macAppMenuTemplate('zh', false)[0].submenu as {
      role?: string;
      label?: string;
      accelerator?: string;
      click?: () => void;
    }[];
    const about = items.findIndex((item) => item.role === 'about');
    expect(items[about + 1]).toEqual({ type: 'separator' });
    const settings = items[about + 2];
    expect(settings?.label).toBe('设置…');
    expect(settings?.accelerator).toBeUndefined();
    openSettingsInMainWindow.mockClear();
    settings?.click?.();
    expect(openSettingsInMainWindow).toHaveBeenCalledTimes(1);
    expect(openSettingsInMainWindow).toHaveBeenCalledWith();
  });

  describe('重启', () => {
    const status = { ensoCommand: false, finderQuickAction: false };
    const setup = (options: { state?: AppRestartState; fail?: boolean } = {}) => {
      const actions: AppMenuActions = {
        restartApp: vi.fn(() => {
          if (options.fail) throw new Error('relaunch unavailable');
        }),
        restartState: () => options.state ?? 'idle',
        reportError: vi.fn(),
      };
      const items = macAppMenuTemplate('zh', false, status, actions)[0].submenu as {
        role?: string;
        label?: string;
        enabled?: boolean;
        click?: () => void;
      }[];
      const restart = items.find((item) =>
        ['重启', '正在重启…', '等命令跑完再重启…'].includes(item.label ?? '')
      );
      return { actions, items, restart };
    };

    it('放在应用菜单里、紧挨着退出', () => {
      const { items, restart } = setup();
      expect(restart).toBeDefined();
      expect(items.indexOf(restart ?? {}) + 1).toBe(
        items.findIndex((item) => item.role === 'quit')
      );
      expect(restart).not.toHaveProperty('role');
    });

    it('点击重启整个应用', () => {
      const { actions, restart } = setup();
      expect(restart?.label).toBe('重启');
      restart?.click?.();
      expect(actions.restartApp).toHaveBeenCalledTimes(1);
      expect(actions.reportError).not.toHaveBeenCalled();
    });

    it('重启进行中：菜单项显示「正在重启…」且不可再点', () => {
      const { restart } = setup({ state: 'restarting' });
      expect(restart?.label).toBe('正在重启…');
      expect(restart?.enabled).toBe(false);
    });

    it('等命令跑完：菜单项显示等待状态且不可再点', () => {
      const { restart } = setup({ state: 'waiting-for-tools' });
      expect(restart?.label).toBe('等命令跑完再重启…');
      expect(restart?.enabled).toBe(false);
      expect(restart?.click).toBeUndefined();
    });

    it('点击处理抛错：不吞掉，给用户一句失败原因', () => {
      const { actions, restart } = setup({ fail: true });
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => restart?.click?.()).not.toThrow();
      expect(actions.reportError).toHaveBeenCalledWith('重启失败：relaunch unavailable');
      expect(log).toHaveBeenCalled();
      log.mockRestore();
    });
  });
});
