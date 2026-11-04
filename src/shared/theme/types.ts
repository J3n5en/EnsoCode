export type ThemeMode = 'light' | 'dark';

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark'];

export type BuiltinThemeId = 'enso' | 'graphite' | 'paper';

/** 内置主题 id，或插件主题 `<pluginId>/<themeId>` */
export type ThemeKey = BuiltinThemeId | `${string}/${string}`;

/** 主题唯一必填内容；值是任意 CSS 颜色字符串 */
export interface ThemePalette {
  /** 窗口画布，侧栏直接坐在上面 */
  canvas: string;
  /** 主内容卡片、右面板、弹层 */
  surface: string;
  /** 代码块、diff 等凹面 */
  sunken: string;
  border: string;
  /** 输入框、控件描边 */
  borderStrong: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  /** 品牌强调色，只用于状态 */
  accent: string;
}

export type ThemeTokens = Record<string, string>;

export interface ThemeDefinition {
  id: ThemeKey;
  name: string;
  source: { kind: 'builtin' } | { kind: 'plugin'; pluginId: string; pluginName: string };
  light: ThemePalette;
  dark: ThemePalette;
  /** 任意 `--x` 覆盖，派生之后叠加 */
  tokens?: Partial<Record<ThemeMode, ThemeTokens>>;
  css?: string;
}
