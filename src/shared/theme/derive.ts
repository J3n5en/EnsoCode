import type { ThemeDefinition, ThemeMode, ThemePalette, ThemeTokens } from './types';

const mix = (color: string, percent: number, base: string) =>
  `color-mix(in oklch, ${color} ${percent}%, ${base})`;

/** 状态色与浮层阴影不进调色板，主题需要时用 tokens 覆盖 */
const FIXED_TOKENS: Record<ThemeMode, ThemeTokens> = {
  light: {
    '--destructive': 'oklch(0.577 0.245 27.33)',
    '--destructive-foreground': 'oklch(0.985 0 0)',
    '--success': 'oklch(0.527 0.154 150.07)',
    '--success-foreground': 'oklch(0.985 0 0)',
    '--warning': 'oklch(0.769 0.189 70.08)',
    '--warning-foreground': 'oklch(0.205 0.014 285.82)',
    '--info': 'oklch(0.623 0.214 259.81)',
    '--info-foreground': 'oklch(0.985 0 0)',
    '--elevation-float':
      '0 1px 2px oklch(0.2 0.01 285 / 0.05), 0 12px 32px -12px oklch(0.2 0.02 285 / 0.18)',
  },
  dark: {
    '--destructive': 'oklch(0.396 0.141 25.72)',
    '--destructive-foreground': 'oklch(0.985 0 0)',
    '--success': 'oklch(0.527 0.154 150.07)',
    '--success-foreground': 'oklch(0.985 0 0)',
    '--warning': 'oklch(0.769 0.189 70.08)',
    '--warning-foreground': 'oklch(0.205 0.014 285.82)',
    '--info': 'oklch(0.623 0.214 259.81)',
    '--info-foreground': 'oklch(0.985 0 0)',
    '--elevation-float': '0 1px 2px oklch(0 0 0 / 0.3), 0 16px 40px -12px oklch(0 0 0 / 0.55)',
  },
};

export function deriveThemeTokens(
  palette: ThemePalette,
  mode: ThemeMode,
  accentOverride?: string
): ThemeTokens {
  const { canvas, surface, sunken, text } = palette;
  const dark = mode === 'dark';
  const brand = accentOverride ?? palette.accent;
  return {
    '--canvas': canvas,
    '--background': surface,
    '--foreground': text,
    '--card': dark ? mix(text, 3, surface) : surface,
    '--card-foreground': text,
    '--popover': dark ? mix(text, 5, surface) : surface,
    '--popover-foreground': text,
    '--primary': text,
    '--primary-foreground': surface,
    '--secondary': mix(text, 6, surface),
    '--secondary-foreground': text,
    '--muted': mix(text, dark ? 7 : 4.5, surface),
    '--muted-foreground': palette.textMuted,
    '--subtle-foreground': palette.textSubtle,
    '--sunken': sunken,
    '--accent': mix(text, 6, 'transparent'),
    '--accent-foreground': text,
    '--border': palette.border,
    '--input': palette.borderStrong,
    '--ring': mix(brand, 50, 'transparent'),
    '--brand': brand,
    '--brand-foreground': dark ? canvas : 'oklch(0.985 0 0)',
    '--elevation-surface': dark
      ? `0 0 0 1px ${mix(text, 6, 'transparent')}, 0 2px 8px rgb(0 0 0 / 0.3)`
      : `0 0 0 1px ${mix(text, 7, 'transparent')}, 0 1px 3px rgb(0 0 0 / 0.04)`,
    ...FIXED_TOKENS[mode],
  };
}

export function resolveThemeTokens(
  theme: ThemeDefinition,
  mode: ThemeMode,
  accentOverride?: string
): ThemeTokens {
  return { ...deriveThemeTokens(theme[mode], mode, accentOverride), ...theme.tokens?.[mode] };
}
