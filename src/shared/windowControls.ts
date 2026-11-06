export const WINDOW_TITLE_BAR_HEIGHT = 44;
export const WINDOWS_CAPTION_BUTTONS_WIDTH = 138;

export interface TitleBarAppearance {
  /** `#rrggbb`，或带 alpha 的 `#rrggbbaa`（壁纸透过原生按钮区） */
  color: string;
  /** 只接受不透明 `#rrggbb` */
  symbolColor: string;
  /** 可选的窗口宿主底色（不透明 `#rrggbb`）；标题栏半透明时由画布色提供 */
  surface?: string;
}

const OPAQUE_HEX = /^#[\da-f]{6}$/i;
const ALPHA_HEX = /^#[\da-f]{6}([\da-f]{2})?$/i;

/**
 * 原生按钮底色可带 alpha（Window Controls Overlay 叠在透明工作区上，壁纸能透出来），
 * 按钮图标色必须不透明；渲染层不能借外观同步修改高度或其他窗口属性。
 *
 * The overlay color may carry alpha so wallpapers show behind native buttons; the
 * symbol color stays opaque. Updates cannot change the height or other window options.
 */
export function parseTitleBarAppearance(raw: unknown): TitleBarAppearance | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!('color' in raw) || !('symbolColor' in raw)) return null;
  const { color, symbolColor } = raw;
  const surface = 'surface' in raw ? raw.surface : undefined;
  const matches = (pattern: RegExp, value: unknown): value is string =>
    typeof value === 'string' && pattern.test(value);
  if (!matches(ALPHA_HEX, color) || !matches(OPAQUE_HEX, symbolColor)) return null;
  if (surface === undefined) return { color, symbolColor };
  return matches(OPAQUE_HEX, surface) ? { color, symbolColor, surface } : null;
}

/** 画布像素 RGBA → 原生标题栏颜色；完全不透明时省掉 alpha 字节 */
export function toTitleBarHex(pixel: ArrayLike<number>): string {
  const bytes = pixel[3] === 255 ? [pixel[0], pixel[1], pixel[2]] : Array.from(pixel).slice(0, 4);
  return `#${bytes.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 窗口宿主底色只能不透明（Windows 顶层窗口保持不透明）：优先用显式 surface，
 * 其次用不透明的按钮底色。半透明按钮底色不能当宿主底色（丢掉 alpha 会刷成近黑），
 * 返回 null 让调用方保留原值。
 */
export function windowSurfaceColor(appearance: TitleBarAppearance): string | null {
  if (appearance.surface) return appearance.surface;
  const { color } = appearance;
  if (OPAQUE_HEX.test(color)) return color;
  return color.slice(7).toLowerCase() === 'ff' ? color.slice(0, 7) : null;
}
