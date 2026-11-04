import { describe, expect, it } from 'vitest';
import { BUILTIN_THEMES } from './builtinThemes';
import { parseThemeKey, pluginThemeKey, resolveTheme } from './themeKey';
import type { ThemeDefinition } from './types';

const nord: ThemeDefinition = {
  ...BUILTIN_THEMES[0],
  id: 'acme.themes/nord',
  name: 'Nord',
  source: { kind: 'plugin', pluginId: 'acme.themes', pluginName: 'Acme Themes' },
};

describe('parseThemeKey', () => {
  it('接受内置主题与合法的插件主题 key', () => {
    for (const key of [
      'enso',
      'graphite',
      'paper',
      'acme.themes/nord',
      'enso.x/catppuccin-mocha',
    ]) {
      expect(parseThemeKey(key)).toBe(key);
    }
  });

  it('拒绝未知内置 id、坏插件 id、多段路径与非字符串', () => {
    for (const bad of [
      '',
      'Enso',
      'nord',
      'nord/nord',
      'acme.themes/',
      '/nord',
      'acme.themes/Nord',
      'acme.themes/nord/extra',
      'acme.themes:nord',
      null,
      undefined,
      1,
      {},
    ]) {
      expect(parseThemeKey(bad)).toBeNull();
    }
  });

  it('pluginThemeKey 构造的 key 能被解析回自身', () => {
    const key = pluginThemeKey('acme.themes', 'nord');
    expect(key).toBe('acme.themes/nord');
    expect(parseThemeKey(key)).toBe(key);
  });
});

describe('resolveTheme', () => {
  it('找到对应主题', () => {
    expect(resolveTheme('graphite').id).toBe('graphite');
    expect(resolveTheme('acme.themes/nord', [...BUILTIN_THEMES, nord])).toBe(nord);
  });

  it('插件主题不可用时回落 enso', () => {
    expect(resolveTheme('acme.themes/nord').id).toBe('enso');
    expect(resolveTheme('acme.themes/nord', []).id).toBe('enso');
  });
});
