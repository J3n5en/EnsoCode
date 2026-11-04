import { type AccentColor, accentOverride } from '../accentColor';
import { resolveThemeTokens } from './derive';
import { THEME_MODES, type ThemeDefinition, type ThemeMode, type ThemeTokens } from './types';

const TOKEN_KEY = /^--[a-z0-9-]+$/;
/** 能提前结束声明或声明块、或吞掉后续声明的字符 */
const UNSAFE_VALUE = /[;{}<>\\\r\n]|\/\*/;

/**
 * `:where()` 把特异性压到 0：浅深两块靠先后顺序区分，主题或用户 CSS 里普通的
 * `:root` / `.dark` 规则都能覆盖它们。
 */
const MODE_SELECTOR: Record<ThemeMode, string> = {
  light: ':where(:root)',
  dark: ':where(:root.dark)',
};

export function tokensCss(selector: string, tokens: ThemeTokens): string {
  const declarations = Object.entries(tokens)
    .filter(([key, value]) => TOKEN_KEY.test(key) && value.trim() && !UNSAFE_VALUE.test(value))
    .map(([key, value]) => `  ${key}: ${value.trim()};\n`);
  return `${selector} {\n${declarations.join('')}}\n`;
}

export function themeTokensCss(theme: ThemeDefinition, accent: AccentColor): string {
  return THEME_MODES.map((mode) =>
    tokensCss(MODE_SELECTOR[mode], resolveThemeTokens(theme, mode, accentOverride(accent, mode)))
  ).join('');
}
