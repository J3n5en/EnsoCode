/**
 * iOS 主屏启动图：只认 apple-touch-startup-image，且必须与机型像素尺寸精确匹配（不匹配就显示纯白）。
 * 竖屏、深浅色各一张；底色与 desk.html / manifest / theme-color 一致，打开时不先闪白。
 */
export interface StartupDevice {
  /** CSS 像素（竖屏） */
  width: number;
  height: number;
  ratio: number;
}

export const STARTUP_DEVICES: readonly StartupDevice[] = [
  { width: 375, height: 667, ratio: 2 }, // SE 2/3、8
  { width: 414, height: 736, ratio: 3 }, // 8 Plus
  { width: 375, height: 812, ratio: 3 }, // X、XS、11 Pro、12/13 mini
  { width: 414, height: 896, ratio: 2 }, // XR、11
  { width: 414, height: 896, ratio: 3 }, // XS Max、11 Pro Max
  { width: 390, height: 844, ratio: 3 }, // 12、13、14、16e
  { width: 428, height: 926, ratio: 3 }, // 12/13 Pro Max、14 Plus
  { width: 393, height: 852, ratio: 3 }, // 14 Pro、15、15 Pro、16
  { width: 430, height: 932, ratio: 3 }, // 14 Pro Max、15 Plus、15 Pro Max、16 Plus
  { width: 402, height: 874, ratio: 3 }, // 16 Pro、17、17 Pro
  { width: 420, height: 912, ratio: 3 }, // Air
  { width: 440, height: 956, ratio: 3 }, // 16 Pro Max、17 Pro Max
];

export type StartupScheme = 'light' | 'dark';

/** 与 desk.html 启动画面、theme-color 同色 */
export const STARTUP_BACKGROUND: Record<StartupScheme, string> = {
  light: '#ffffff',
  dark: '#252529',
};

export const startupImagePath = (d: StartupDevice, scheme: StartupScheme): string =>
  `/splash/${d.width * d.ratio}x${d.height * d.ratio}-${scheme}.png`;

export const startupImageMedia = (d: StartupDevice, scheme: StartupScheme): string =>
  `screen and (device-width: ${d.width}px) and (device-height: ${d.height}px) and (-webkit-device-pixel-ratio: ${d.ratio}) and (orientation: portrait) and (prefers-color-scheme: ${scheme})`;

export function startupImageLinks(): string {
  return STARTUP_DEVICES.flatMap((d) =>
    (['light', 'dark'] as const).map(
      (scheme) =>
        `<link rel="apple-touch-startup-image" media="${startupImageMedia(d, scheme)}" href="${startupImagePath(d, scheme)}" />`
    )
  ).join('\n    ');
}
