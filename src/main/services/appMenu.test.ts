import { describe, expect, it } from 'vitest';

import { APP_DISPLAY_NAME, macAppMenuTemplate } from './appMenu';

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
});
