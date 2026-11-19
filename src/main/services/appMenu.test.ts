import { describe, expect, it, vi } from 'vitest';

import { APP_DISPLAY_NAME, type AppMenuActions, macAppMenuTemplate } from './appMenu';

describe('macAppMenuTemplate', () => {
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
    expect(macAppMenuTemplate().slice(1)).toEqual([
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]);
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

  describe('重启', () => {
    const status = { ensoCommand: false, finderQuickAction: false };
    const setup = (result: ReturnType<AppMenuActions['restartAgent']>) => {
      const actions = { restartAgent: vi.fn(() => result), notify: vi.fn() };
      const items = macAppMenuTemplate('zh', false, status, actions)[0].submenu as {
        role?: string;
        label?: string;
        click?: () => void;
      }[];
      return { actions, items, restart: items.find((item) => item.label === '重启') };
    };

    it('放在应用菜单里、紧挨着退出', () => {
      const { items, restart } = setup('requested');
      expect(restart).toBeDefined();
      expect(items.indexOf(restart ?? {}) + 1).toBe(
        items.findIndex((item) => item.role === 'quit')
      );
      expect(restart).not.toHaveProperty('role');
    });

    it('点击发出优雅重启请求；请求已受理时不弹窗', () => {
      const { actions, restart } = setup('requested');
      restart?.click?.();
      expect(actions.restartAgent).toHaveBeenCalledTimes(1);
      expect(actions.notify).not.toHaveBeenCalled();
    });

    it('没有可重启的会话：明确提示', () => {
      const { actions, restart } = setup('no-session');
      restart?.click?.();
      expect(actions.notify).toHaveBeenCalledWith('现在没有可重启的会话。');
    });

    it('重启进行中再点：不再发请求以外的动作，只提示', () => {
      const { actions, restart } = setup('already-restarting');
      restart?.click?.();
      expect(actions.notify).toHaveBeenCalledWith(
        '重启已在进行中，正在跑的工具调用结束后就会完成。'
      );
    });
  });
});
