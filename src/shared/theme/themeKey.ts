import { BUILTIN_THEMES } from './builtinThemes';
import type { ThemeDefinition, ThemeKey } from './types';

const BUILTIN_IDS: readonly string[] = BUILTIN_THEMES.map((theme) => theme.id);
const PLUGIN_ID = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
const LOCAL_ID = /^[a-z][a-z0-9-]{0,31}$/;

export function pluginThemeKey(pluginId: string, themeId: string): ThemeKey {
  return `${pluginId}/${themeId}`;
}

export function parseThemeKey(value: unknown): ThemeKey | null {
  if (typeof value !== 'string') return null;
  if (BUILTIN_IDS.includes(value)) return value as ThemeKey;
  const [pluginId, themeId, ...rest] = value.split('/');
  if (rest.length || !PLUGIN_ID.test(pluginId) || !LOCAL_ID.test(themeId ?? '')) return null;
  return pluginThemeKey(pluginId, themeId);
}

/** 找不到（插件被禁用或卸载）时回落 enso；不改写设置，插件恢复后自动回来 */
export function resolveTheme(
  key: ThemeKey,
  themes: readonly ThemeDefinition[] = BUILTIN_THEMES
): ThemeDefinition {
  return themes.find((theme) => theme.id === key) ?? BUILTIN_THEMES[0];
}
