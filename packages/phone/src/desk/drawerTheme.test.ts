import { describe, expect, it } from 'vitest';
import { readDeskTheme } from './drawerTheme';

describe('readDeskTheme', () => {
  it('按主题变量映射，缺的项取次选或留空', () => {
    const values: Record<string, string> = {
      '--background': ' oklch(0.2 0 0) ',
      '--foreground': '#fafafa',
      '--primary': 'oklch(0.7 0.2 250)',
      '--muted': '',
      '--accent': '#333',
    };
    const theme = readDeskTheme((name) => values[name] ?? '', true);
    expect(theme.dark).toBe(true);
    expect(theme.vars).toEqual({
      '--dd-bg': 'oklch(0.2 0 0)',
      '--dd-fg': '#fafafa',
      '--dd-muted': '#333',
      '--dd-primary': 'oklch(0.7 0.2 250)',
    });
  });

  it('弹层色优先于底色', () => {
    const theme = readDeskTheme(
      (name) => ({ '--popover': '#111', '--background': '#000' })[name] ?? '',
      false
    );
    expect(theme.vars['--dd-bg']).toBe('#111');
  });
});
