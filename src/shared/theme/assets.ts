import type {
  ThemeAsset,
  ThemeAssetSlot,
  ThemeAssetState,
  ThemeAssets,
  ThemeBackground,
  ThemeBackgroundParam,
  ThemeBackgroundSize,
} from './types';

const ASSET_STATES = ['running', 'waiting', 'error'] as const satisfies readonly ThemeAssetState[];

const v = (slot: ThemeAssetSlot) => `var(--enso-asset-${slot})`;
const overlay = (slot: ThemeAssetSlot, box: string, fit = 'center / contain no-repeat') =>
  `content:"";position:absolute;pointer-events:none;${box};background:${v(slot)} ${fit}`;

/** 时间线每一行也带 enso-chat-col，只认装着输入框的那一列 */
const COMPOSER_COL = `.enso-chat-col:has([data-enso="composer"])`;

/**
 * 槽位挂在哪、怎么摆，跟哪个状态属性变。定位取自奶龙主题。
 * `session` 跟当前会话，`activity` 跟所有主会话，见 themeState
 */
const SLOTS: Record<ThemeAssetSlot, { state: 'session' | 'activity'; css: string }> = {
  'canvas-pattern': {
    state: 'activity',
    css: `[data-enso="canvas"]:has([data-enso="sidebar"]){position:relative;isolation:isolate}[data-enso="canvas"]:has([data-enso="sidebar"])::before{${overlay('canvas-pattern', 'inset:0;z-index:-1', 'repeat 0 0')};clip-path:var(--enso-browser-holes-clip,none)}`,
  },
  'sidebar-footer': {
    state: 'activity',
    css: `[data-enso="sidebar"]{background:${v('sidebar-footer')} no-repeat center bottom 64px / min(150px, 80%) auto}`,
  },
  'empty-main': {
    state: 'activity',
    css: `[data-enso="main"]:not(:has([data-enso="timeline"])){background:${v('empty-main')} no-repeat center calc(50% - 130px) / 170px auto,var(--background)}`,
  },
  welcome: {
    state: 'session',
    css: `[data-enso="timeline"]:not(:has([data-enso="message-user"]))::after{${overlay('welcome', 'right:24px;bottom:12px;width:132px;height:132px')}}`,
  },
  'composer-peek': {
    state: 'session',
    css:
      `${COMPOSER_COL}>:first-child{position:relative;isolation:isolate}` +
      `${COMPOSER_COL}>:first-child::before{${overlay('composer-peek', 'right:72px;bottom:calc(100% - 4px);width:84px;height:66px;z-index:-1;transform-origin:center bottom;transition:transform 320ms cubic-bezier(0.34, 1.56, 0.64, 1)', 'center bottom / contain no-repeat')}}` +
      `${COMPOSER_COL}:focus-within>:first-child::before{transform:translateY(-5px) scale(1.04)}` +
      `@media (prefers-reduced-motion: reduce){${COMPOSER_COL}>:first-child::before{transition:none}${COMPOSER_COL}:focus-within>:first-child::before{transform:none}}`,
  },
  thinking: {
    state: 'session',
    css:
      `[data-enso="thinking"]{position:relative;padding-left:36px}` +
      `[data-enso="thinking"]::before{${overlay('thinking', 'left:-2px;top:-8px;width:34px;height:34px')}}` +
      `[data-enso="thinking"]:not([data-live])::before{background-image:var(--enso-asset-thinking-still,${v('thinking')})}`,
  },
  'code-corner': {
    state: 'session',
    css: `[data-enso="code-block"]::after{${overlay('code-corner', 'right:20px;top:-13px;width:24px;height:24px;z-index:1')}}`,
  },
  'todo-corner': {
    state: 'session',
    css: `[data-enso="todo"]{position:relative}[data-enso="todo"]:not(:has(+ * [data-enso="composer"]))::after{${overlay('todo-corner', 'right:6px;top:-30px;width:44px;height:44px')}}`,
  },
  'status-icon': {
    state: 'session',
    css: `[data-enso="status-line"]::before{${overlay('status-icon', 'left:2px;top:50%;width:20px;height:20px;translate:0 -50%')}}`,
  },
  'panel-corner': {
    state: 'session',
    css: `[data-enso="side-panel"]{position:relative}[data-enso="side-panel"]::after{${overlay('panel-corner', 'right:10px;bottom:10px;width:72px;height:72px;opacity:0.9;z-index:5')}}`,
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const UNSAFE_PATH_CHAR = /[\\:%?#"'()<>\s]/;

/** 与 localImage 的 IMAGE_EXTENSIONS 一致；本模块要能原样拷到主题生成器，不引用目录外模块 */
export const THEME_ASSET_EXTENSIONS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'jfif',
  'avif',
];

/** 主题 JSON 所在目录下的图片；不能越界，不带会被 URL 或 CSS 另行解释的字符 */
export function isThemeAssetPath(value: unknown): value is string {
  if (typeof value !== 'string' || UNSAFE_PATH_CHAR.test(value)) return false;
  const parts = value.split('/');
  const name = parts[parts.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  return (
    parts.every((part) => part !== '' && part !== '.' && part !== '..') &&
    dot > 0 &&
    THEME_ASSET_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase())
  );
}

function parseAsset(raw: unknown): ThemeAsset | null {
  if (!isRecord(raw) || !isThemeAssetPath(raw.src)) return null;
  const asset: ThemeAsset = { src: raw.src };
  for (const key of ['still', 'dark'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!isThemeAssetPath(value)) return null;
    asset[key] = value;
  }
  if (raw.states === undefined) return asset;
  if (!isRecord(raw.states)) return null;
  const states: Partial<Record<ThemeAssetState, string>> = {};
  for (const [key, value] of Object.entries(raw.states)) {
    const state = ASSET_STATES.find((s) => s === key);
    if (!state || !isThemeAssetPath(value)) return null;
    states[state] = value;
  }
  return { ...asset, states };
}

/** 主题 JSON 的 assets：未知或不合法的槽位整个丢掉，不让主题失败 */
export function parseThemeAssets(raw: unknown): ThemeAssets | undefined {
  if (!isRecord(raw)) return undefined;
  const assets: ThemeAssets = {};
  for (const slot of Object.keys(SLOTS) as ThemeAssetSlot[]) {
    const asset = parseAsset(raw[slot]);
    if (asset) assets[slot] = asset;
  }
  return Object.keys(assets).length > 0 ? assets : undefined;
}

export const THEME_BACKGROUND_SIZES = [
  'cover',
  'contain',
  'repeat',
  'center',
] as const satisfies readonly ThemeBackgroundSize[];

/** 与设置页背景图的范围和默认值一致 */
export const THEME_BACKGROUND_PARAMS: Record<
  ThemeBackgroundParam,
  { min: number; max: number; default: number }
> = {
  opacity: { min: 0, max: 1, default: 0.85 },
  blur: { min: 0, max: 20, default: 0 },
  brightness: { min: 0, max: 2, default: 1 },
  saturation: { min: 0, max: 2, default: 1 },
  mask: { min: 0, max: 1, default: 0.5 },
  composerOpacity: { min: 0, max: 1, default: 0.6 },
  codeOpacity: { min: 0, max: 1, default: 0.65 },
};

/** 主题 JSON 的 background：图片不合法整个丢掉；参数越界钳制，类型不对只丢该字段 */
export function parseThemeBackground(raw: unknown): ThemeBackground | undefined {
  if (!isRecord(raw)) return undefined;
  const image = parseAsset(raw.image);
  if (!image) return undefined;
  const background: ThemeBackground = { image };
  const size = THEME_BACKGROUND_SIZES.find((s) => s === raw.size);
  if (size) background.size = size;
  for (const [key, range] of Object.entries(THEME_BACKGROUND_PARAMS)) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value))
      background[key as ThemeBackgroundParam] = Math.min(range.max, Math.max(range.min, value));
  }
  return background;
}

function mapAsset(asset: ThemeAsset, map: (path: string) => string): ThemeAsset {
  return {
    src: map(asset.src),
    ...(asset.still !== undefined ? { still: map(asset.still) } : {}),
    ...(asset.dark !== undefined ? { dark: map(asset.dark) } : {}),
    ...(asset.states
      ? { states: Object.fromEntries(Object.entries(asset.states).map(([k, p]) => [k, map(p)])) }
      : {}),
  };
}

function themeDirMap(themePath: string, toUrl: (rel: string) => string) {
  const dir = themePath.split('/').slice(0, -1).join('/');
  return (path: string) => toUrl(dir ? `${dir}/${path}` : path);
}

/** 路径按主题 JSON 所在目录解析成插件内相对路径后交给 toUrl */
export function resolveThemeAssets(
  assets: ThemeAssets,
  themePath: string,
  toUrl: (rel: string) => string
): ThemeAssets {
  const map = themeDirMap(themePath, toUrl);
  return Object.fromEntries(
    Object.entries(assets).map(([slot, asset]) => [slot, mapAsset(asset, map)])
  );
}

export function resolveThemeBackground(
  background: ThemeBackground,
  themePath: string,
  toUrl: (rel: string) => string
): ThemeBackground {
  return { ...background, image: mapAsset(background.image, themeDirMap(themePath, toUrl)) };
}

const cssUrl = (url: string) => `url("${url.replace(/["\\\n\r\f]/g, encodeURIComponent)}")`;

/**
 * 地址已解析好的素材 → CSS。每个槽位一个变量 `--enso-asset-<slot>`，主题 CSS 也能引用。
 * 背景图只出变量 `--enso-asset-background`，由背景层引用，状态跟 data-enso-activity。
 * 层叠顺序：默认 < 深色 < 减少动态效果 < 状态
 */
export function themeAssetsCss(
  assets: ThemeAssets | undefined,
  background?: ThemeBackground
): string {
  const entries: { name: string; asset: ThemeAsset; state: 'session' | 'activity'; css: string }[] =
    (Object.keys(SLOTS) as ThemeAssetSlot[]).flatMap((slot) => {
      const asset = assets?.[slot];
      return asset ? [{ name: slot, asset, ...SLOTS[slot] }] : [];
    });
  if (background)
    entries.push({ name: 'background', asset: background.image, state: 'activity', css: '' });
  const base: string[] = [];
  const dark: string[] = [];
  const still: string[] = [];
  const states: string[] = [];
  const rules: string[] = [];
  for (const { name: slot, asset, state: stateAttr, css } of entries) {
    const name = `--enso-asset-${slot}`;
    base.push(`${name}:${cssUrl(asset.src)}`);
    if (asset.still) {
      if (slot === 'thinking') base.push(`${name}-still:${cssUrl(asset.still)}`);
      still.push(`${name}:${cssUrl(asset.still)}`);
    }
    if (asset.dark) dark.push(`${name}:${cssUrl(asset.dark)}`);
    for (const state of ASSET_STATES) {
      const url = asset.states?.[state];
      if (url) states.push(`:root[data-enso-${stateAttr}="${state}"]{${name}:${cssUrl(url)}}`);
    }
    if (css) rules.push(css);
  }
  if (base.length === 0) return '';
  return [
    `:root{${base.join(';')}}`,
    dark.length > 0 ? `:root.dark{${dark.join(';')}}` : '',
    still.length > 0
      ? `@media (prefers-reduced-motion: reduce){:root,:root.dark{${still.join(';')}}}`
      : '',
    ...states,
    ...rules,
  ]
    .filter(Boolean)
    .join('\n');
}
