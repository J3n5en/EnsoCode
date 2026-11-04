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

export const isSafeTokenValue = (value: string): boolean => !UNSAFE_VALUE.test(value);

/** 只留 `--x` 键与不能逃出声明的非空字符串值 */
export function sanitizeTokens(tokens: Record<string, unknown>): ThemeTokens {
  const kept: ThemeTokens = {};
  for (const [key, value] of Object.entries(tokens)) {
    if (TOKEN_KEY.test(key) && typeof value === 'string' && value.trim() && isSafeTokenValue(value))
      kept[key] = value.trim();
  }
  return kept;
}

export function tokensCss(selector: string, tokens: ThemeTokens): string {
  const declarations = Object.entries(sanitizeTokens(tokens)).map(
    ([key, value]) => `  ${key}: ${value};\n`
  );
  return `${selector} {\n${declarations.join('')}}\n`;
}

export function themeTokensCss(theme: ThemeDefinition, accent: AccentColor): string {
  return THEME_MODES.map((mode) =>
    tokensCss(MODE_SELECTOR[mode], resolveThemeTokens(theme, mode, accentOverride(accent, mode)))
  ).join('');
}
