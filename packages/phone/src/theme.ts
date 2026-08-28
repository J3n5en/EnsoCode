import type { HostAppearance } from '@enso/pair';
import { applyTerminalThemeToApp, clearTerminalThemeFromApp } from './stubs/ghostty-theme';

/**
 * 主题优先级：本地覆盖 > 桌面下发 > 跟随系统。
 * 一旦用户在手机上显式选过，就不再被桌面的主题变更打断。
 * sync-terminal 与桌面同语义：整套 UI 配色由终端调色板推导。
 */

export type ThemePreference = 'auto' | 'light' | 'dark';

const OVERRIDE_KEY = 'enso-phone-theme';

let hostTheme: HostAppearance = 'system';
let override: ThemePreference = readOverride();
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function readOverride(): ThemePreference {
  const raw = localStorage.getItem(OVERRIDE_KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'auto';
}

/**
 * 让 Safari 的状态栏/工具栏底色跟随页面。写死的 theme-color 在主题切换后
 * 会与页面对不上，表现为上下两条系统灰边。
 *
 * 注意：浏览器取「第一个匹配的」theme-color 标签，所以必须清掉 index.html 里
 * 那两条带 media 的兜底并插到 head 最前，否则动态值永远轮不上。
 * 取实际渲染出的背景色（rgb 形式兼容性最好），下一帧再读以确保新变量已生效。
 */
function syncThemeColorMeta(): void {
  requestAnimationFrame(() => {
    const computed = getComputedStyle(document.body).backgroundColor;
    if (!computed) return;
    // 计算值可能是 oklch()（主题变量就是 oklch），theme-color 对新色彩空间的
    // 支持不一，统一过一遍 canvas 转成 rgb
    const color = toRgb(computed);
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.remove();
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = color;
    document.head.prepend(meta);
  });
}

/**
 * 把任意 CSS 颜色规约成 rgb()。canvas 的 fillStyle 对 oklch 是原样回吐、不做
 * 转换，所以实际画一像素再读回 —— 这一步一定得到 sRGB 数值。
 */
function toRgb(color: string): string {
  if (color.startsWith('rgb') || color.startsWith('#')) return color;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return color;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  } catch {
    return color;
  }
}

function apply(): void {
  // 本地覆盖优先，且覆盖时不套终端配色（用户要的是明确的浅/深）
  if (override !== 'auto') {
    clearTerminalThemeFromApp();
    document.documentElement.classList.toggle('dark', override === 'dark');
  } else if (hostTheme === 'sync-terminal') {
    applyTerminalThemeToApp(undefined, true);
  } else {
    clearTerminalThemeFromApp();
    const dark = hostTheme === 'system' ? media.matches : hostTheme === 'dark';
    document.documentElement.classList.toggle('dark', dark);
  }
  for (const listener of listeners) listener();
  syncThemeColorMeta();
}

/** 桌面下发的偏好（仅在未本地覆盖时生效） */
export function setHostTheme(theme: HostAppearance): void {
  hostTheme = theme;
  apply();
}

/** 终端调色板更新后需重算（sync-terminal 依赖它） */
export function refreshTheme(): void {
  apply();
}

export function getThemePreference(): ThemePreference {
  return override;
}

export function setThemePreference(next: ThemePreference): void {
  override = next;
  if (next === 'auto') localStorage.removeItem(OVERRIDE_KEY);
  else localStorage.setItem(OVERRIDE_KEY, next);
  apply();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initTheme(): void {
  apply();
  media.addEventListener('change', apply);
}
