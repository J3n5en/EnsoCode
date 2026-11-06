import { parseThemeAssets, parseThemeBackground } from './assets';
import { isSafeTokenValue, sanitizeTokens } from './tokensCss';
import {
  THEME_MODES,
  type ThemeAssets,
  type ThemeBackground,
  type ThemeMode,
  type ThemePalette,
  type ThemeTokens,
} from './types';

const PALETTE_KEYS = [
  'canvas',
  'surface',
  'sunken',
  'border',
  'borderStrong',
  'text',
  'textMuted',
  'textSubtle',
  'accent',
] as const satisfies readonly (keyof ThemePalette)[];

export type ThemeFileResult =
  | {
      ok: true;
      light: ThemePalette;
      dark: ThemePalette;
      tokens?: Partial<Record<ThemeMode, ThemeTokens>>;
      assets?: ThemeAssets;
      background?: ThemeBackground;
    }
  | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parsePalette(raw: unknown, mode: ThemeMode): ThemePalette | string {
  if (!isRecord(raw)) return `缺少 ${mode} 调色板`;
  const palette = {} as ThemePalette;
  for (const key of PALETTE_KEYS) {
    const value = raw[key];
    if (typeof value !== 'string' || !value.trim() || !isSafeTokenValue(value))
      return `${mode}.${key} 必须是 CSS 颜色`;
    palette[key] = value.trim();
  }
  return palette;
}

/** 插件主题 JSON 的边界解析；tokens 里不合法的键值、assets 里不合法的槽位、不合法的 background 直接丢掉，不算错误 */
export function parseThemeFile(raw: unknown): ThemeFileResult {
  if (!isRecord(raw)) return { ok: false, error: '主题文件必须是 JSON 对象' };
  const light = parsePalette(raw.light, 'light');
  if (typeof light === 'string') return { ok: false, error: light };
  const dark = parsePalette(raw.dark, 'dark');
  if (typeof dark === 'string') return { ok: false, error: dark };
  const assets = parseThemeAssets(raw.assets);
  const background = parseThemeBackground(raw.background);
  const base = {
    ok: true as const,
    light,
    dark,
    ...(assets ? { assets } : {}),
    ...(background ? { background } : {}),
  };
  if (raw.tokens === undefined) return base;
  if (!isRecord(raw.tokens)) return { ok: false, error: 'tokens 必须是对象' };
  const tokens: Partial<Record<ThemeMode, ThemeTokens>> = {};
  for (const mode of THEME_MODES) {
    const value = raw.tokens[mode];
    if (value === undefined) continue;
    if (!isRecord(value)) return { ok: false, error: `tokens.${mode} 必须是对象` };
    const kept = sanitizeTokens(value);
    if (Object.keys(kept).length > 0) tokens[mode] = kept;
  }
  return { ...base, ...(Object.keys(tokens).length > 0 ? { tokens } : {}) };
}
