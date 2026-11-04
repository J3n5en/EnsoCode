import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS } from '../accentColor';
import { BUILTIN_THEMES } from './builtinThemes';
import { resolveThemeTokens } from './derive';
import { themeTokensCss, tokensCss } from './tokensCss';
import { THEME_MODES } from './types';

/** 把 `selector{--a:b;…}` 文本解析回 { selector: { --a: b } } */
function parseBlocks(css: string): Record<string, Record<string, string>> {
  const blocks: Record<string, Record<string, string>> = {};
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls: Record<string, string> = {};
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) decls[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
    blocks[selector.trim()] = decls;
  }
  return blocks;
}

describe('tokensCss', () => {
  it('输出单个选择器块，保留合法声明', () => {
    const blocks = parseBlocks(tokensCss(':root', { '--a': 'red', '--b-2': 'oklch(1 0 0 / 0.5)' }));
    expect(blocks).toEqual({ ':root': { '--a': 'red', '--b-2': 'oklch(1 0 0 / 0.5)' } });
  });

  it('丢弃非法 key 与可能逃逸声明块的值', () => {
    const css = tokensCss(':root', {
      '--ok': 'blue',
      color: 'red',
      '--Upper': 'red',
      '--a b': 'red',
      '--semi': 'red; --evil: 1',
      '--brace': 'red} body{display:none',
      '--tag': '</style><script>',
      '--comment': 'red /*',
      '--newline': 'red\n--x: 1',
      '--backslash': 'red\\',
      '--empty': '  ',
    });
    expect(parseBlocks(css)).toEqual({ ':root': { '--ok': 'blue' } });
    expect(css).not.toMatch(/evil|display|script|Upper/);
  });
});

describe('themeTokensCss', () => {
  it('同时写出浅色与 .dark 两套 token', () => {
    const enso = BUILTIN_THEMES[0];
    const blocks = Object.entries(parseBlocks(themeTokensCss(enso, 'theme')));
    expect(blocks).toHaveLength(2);
    const dark = blocks.find(([selector]) => selector.includes('.dark'));
    const light = blocks.find(([selector]) => !selector.includes('.dark'));
    expect(light?.[1]['--background']).toBe(enso.light.surface);
    expect(dark?.[1]['--background']).toBe(enso.dark.surface);
    expect(light?.[1]['--brand']).toBe(enso.light.accent);
  });

  it('非跟随主题的强调色按模式取预设值', () => {
    const css = themeTokensCss(BUILTIN_THEMES[0], 'teal');
    const blocks = Object.entries(parseBlocks(css));
    expect(blocks.find(([s]) => !s.includes('.dark'))?.[1]['--brand']).toBe(
      ACCENT_PRESETS.teal.light
    );
    expect(blocks.find(([s]) => s.includes('.dark'))?.[1]['--brand']).toBe(
      ACCENT_PRESETS.teal.dark
    );
  });

  it('内置主题的派生 token 一个都不会被过滤掉', () => {
    for (const theme of BUILTIN_THEMES) {
      const blocks = Object.values(parseBlocks(themeTokensCss(theme, 'theme')));
      THEME_MODES.forEach((mode, i) => {
        expect(blocks[i]).toEqual(resolveThemeTokens(theme, mode));
      });
    }
  });
});
