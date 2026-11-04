import type { ThemeMode } from './theme/types';

/** 界面强调色；`theme` 跟随当前主题，其余预设覆盖主题的品牌色 */
export const ACCENT_COLORS = ['theme', 'violet', 'indigo', 'teal', 'amber', 'graphite'] as const;

export type AccentColor = (typeof ACCENT_COLORS)[number];

export const DEFAULT_ACCENT_COLOR: AccentColor = 'theme';

export const ACCENT_PRESETS: Record<Exclude<AccentColor, 'theme'>, Record<ThemeMode, string>> = {
  violet: { light: 'oklch(0.54 0.2 280)', dark: 'oklch(0.72 0.14 280)' },
  indigo: { light: 'oklch(0.53 0.19 265)', dark: 'oklch(0.7 0.14 265)' },
  teal: { light: 'oklch(0.56 0.1 185)', dark: 'oklch(0.76 0.12 185)' },
  amber: { light: 'oklch(0.64 0.16 55)', dark: 'oklch(0.78 0.14 70)' },
  graphite: { light: 'oklch(0.27 0.01 285)', dark: 'oklch(0.9 0.005 285)' },
};

export function accentOverride(accent: AccentColor, mode: ThemeMode): string | undefined {
  return accent === 'theme' ? undefined : ACCENT_PRESETS[accent][mode];
}

export function parseAccentColor(value: unknown): AccentColor | null {
  return typeof value === 'string' && (ACCENT_COLORS as readonly string[]).includes(value)
    ? (value as AccentColor)
    : null;
}

/** 非法值（外部手改 settings.json / 旧版本载荷）落回默认值 */
export function resolveAccentColor(value: unknown): AccentColor {
  return parseAccentColor(value) ?? DEFAULT_ACCENT_COLOR;
}
