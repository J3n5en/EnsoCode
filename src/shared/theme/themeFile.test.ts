import { describe, expect, it } from 'vitest';
import { parseThemeFile } from './themeFile';

const palette = (accent = '#88c0d0') => ({
  canvas: '#d8dee9',
  surface: '#eceff4',
  sunken: '#e5e9f0',
  border: '#d8dee9',
  borderStrong: '#4c566a',
  text: '#2e3440',
  textMuted: '#3b4252',
  textSubtle: '#4c566a',
  accent,
});

describe('parseThemeFile', () => {
  it('读出浅深两套调色板，忽略未知字段', () => {
    const result = parseThemeFile({ light: palette(), dark: palette('#5e81ac'), extra: 1 });
    expect(result).toEqual({ ok: true, light: palette(), dark: palette('#5e81ac') });
  });

  it('带出背景，坏背景不让主题失败', () => {
    const background = { image: { src: 'assets/bg.webp' }, size: 'repeat', mask: 0.2 };
    const good = parseThemeFile({ light: palette(), dark: palette(), background });
    expect(good.ok && good.background).toEqual(background);
    const bad = parseThemeFile({ light: palette(), dark: palette(), background: { blur: 1 } });
    expect(bad).toEqual({ ok: true, light: palette(), dark: palette() });
  });

  it('tokens 只留合法键值，空的模式不出现', () => {
    const result = parseThemeFile({
      light: palette(),
      dark: palette(),
      tokens: {
        dark: {
          '--destructive': 'oklch(0.7 0.14 25)',
          '--Bad': 'red',
          color: 'red',
          '--x': 'red; } body { display:none',
          '--n': 3,
        },
        light: { '--y': '' },
      },
    });
    expect(result.ok && result.tokens).toEqual({ dark: { '--destructive': 'oklch(0.7 0.14 25)' } });
  });

  it.each<[string, unknown, RegExp]>([
    ['不是对象', '[]', /对象/],
    ['数组', [], /对象/],
    ['缺 dark', { light: palette() }, /dark/],
    ['缺字段', { light: palette(), dark: { ...palette(), accent: undefined } }, /dark\.accent/],
    ['空字符串', { light: { ...palette(), text: ' ' }, dark: palette() }, /light\.text/],
    ['非字符串', { light: { ...palette(), canvas: 1 }, dark: palette() }, /light\.canvas/],
    [
      '能逃出声明的值',
      { light: { ...palette(), surface: 'red;} body{display:none' }, dark: palette() },
      /light\.surface/,
    ],
    ['tokens 不是对象', { light: palette(), dark: palette(), tokens: 'x' }, /tokens/],
    [
      'tokens 的模式不是对象',
      { light: palette(), dark: palette(), tokens: { dark: [] } },
      /tokens\.dark/,
    ],
  ])('%s 时返回带原因的错误', (_label, raw, reason) => {
    const result = parseThemeFile(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(reason);
  });
});
