import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILTIN_THEMES } from './builtinThemes';
import { deriveThemeTokens, resolveThemeTokens } from './derive';
import { THEME_MODES, type ThemeDefinition } from './types';

const enso = BUILTIN_THEMES[0];

/** 样式表 @theme 里 `--color-*` / `--shadow-*` 引用的原始变量：派生必须全部产出 */
function referencedTokens(): string[] {
  const names = new Set<string>();
  for (const file of ['globals.css', 'shared.css']) {
    const css = readFileSync(new URL(`../../renderer/styles/${file}`, import.meta.url), 'utf8');
    for (const m of css.matchAll(/--(?:color|shadow)-[a-z-]+:\s*var\((--[a-z0-9-]+)\)/g)) {
      names.add(m[1]);
    }
  }
  return [...names];
}

describe('deriveThemeTokens', () => {
  it('产出样式表引用的全部颜色与阴影变量', () => {
    const referenced = referencedTokens();
    expect(referenced).toEqual(expect.arrayContaining(['--background', '--brand', '--ring']));
    for (const theme of BUILTIN_THEMES) {
      for (const mode of THEME_MODES) {
        const tokens = deriveThemeTokens(theme[mode], mode);
        for (const name of referenced)
          expect(tokens[name], `${theme.id}/${mode} ${name}`).toBeTruthy();
      }
    }
  });

  it('调色板直接映射到对应语义变量', () => {
    const p = enso.dark;
    const tokens = deriveThemeTokens(p, 'dark');
    expect(tokens['--canvas']).toBe(p.canvas);
    expect(tokens['--background']).toBe(p.surface);
    expect(tokens['--sunken']).toBe(p.sunken);
    expect(tokens['--foreground']).toBe(p.text);
    expect(tokens['--muted-foreground']).toBe(p.textMuted);
    expect(tokens['--subtle-foreground']).toBe(p.textSubtle);
    expect(tokens['--border']).toBe(p.border);
    expect(tokens['--input']).toBe(p.borderStrong);
    expect(tokens['--brand']).toBe(p.accent);
  });

  it('浅色卡片与弹层贴表面，深色稍提亮', () => {
    expect(deriveThemeTokens(enso.light, 'light')['--card']).toBe(enso.light.surface);
    expect(deriveThemeTokens(enso.dark, 'dark')['--card']).not.toBe(enso.dark.surface);
    expect(deriveThemeTokens(enso.dark, 'dark')['--popover']).not.toBe(enso.dark.surface);
  });

  it('强调色覆盖替换品牌色并带动焦点环', () => {
    const teal = 'oklch(0.56 0.1 185)';
    const tokens = deriveThemeTokens(enso.light, 'light', teal);
    expect(tokens['--brand']).toBe(teal);
    expect(tokens['--ring']).toContain(teal);
    expect(tokens['--ring']).not.toContain(enso.light.accent);
  });
});

describe('resolveThemeTokens', () => {
  const custom: ThemeDefinition = {
    ...enso,
    tokens: { dark: { '--background': 'black', '--x-glow': '0 0 4px red' } },
  };

  it('主题 tokens 在派生之后叠加，只作用于对应模式', () => {
    const dark = resolveThemeTokens(custom, 'dark');
    expect(dark['--background']).toBe('black');
    expect(dark['--x-glow']).toBe('0 0 4px red');
    expect(dark['--foreground']).toBe(enso.dark.text);
    const light = resolveThemeTokens(custom, 'light');
    expect(light['--background']).toBe(enso.light.surface);
    expect(light['--x-glow']).toBeUndefined();
  });
});
