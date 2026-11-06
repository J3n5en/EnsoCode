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

export type ThemeAssetSlot =
  | 'canvas-pattern'
  | 'sidebar-footer'
  | 'empty-main'
  | 'welcome'
  | 'composer-peek'
  | 'thinking'
  | 'code-corner'
  | 'todo-corner'
  | 'status-icon'
  | 'panel-corner';

export type ThemeAssetState = 'running' | 'waiting' | 'error';

/** 主题 JSON 里是相对路径，加载后换成可直接放进 url() 的地址 */
export interface ThemeAsset {
  src: string;
  /** 减少动态效果时，以及思考块不在进行时 */
  still?: string;
  dark?: string;
  states?: Partial<Record<ThemeAssetState, string>>;
}

export type ThemeAssets = Partial<Record<ThemeAssetSlot, ThemeAsset>>;

export type ThemeBackgroundSize = 'cover' | 'contain' | 'repeat' | 'center';

/** 主题自带的背景图，参数与设置页背景图同义同范围；用户自己开了背景图时不生效 */
export interface ThemeBackground {
  /** states 跟 data-enso-activity */
  image: ThemeAsset;
  size?: ThemeBackgroundSize;
  blur?: number;
  brightness?: number;
  saturation?: number;
  /** 主题色遮罩 */
  mask?: number;
  /** 背景可见度，面板 alpha 取补 */
  opacity?: number;
  composerOpacity?: number;
  codeOpacity?: number;
}

export type ThemeBackgroundParam = Exclude<keyof ThemeBackground, 'image' | 'size'>;

export interface ThemeDefinition {
  id: ThemeKey;
  name: string;
  source: { kind: 'builtin' } | { kind: 'plugin'; pluginId: string; pluginName: string };
  light: ThemePalette;
  dark: ThemePalette;
  /** 任意 `--x` 覆盖，派生之后叠加 */
  tokens?: Partial<Record<ThemeMode, ThemeTokens>>;
  assets?: ThemeAssets;
  background?: ThemeBackground;
  css?: string;
}
