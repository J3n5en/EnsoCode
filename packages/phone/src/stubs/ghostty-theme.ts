import type { TerminalPalette } from '@enso/pair';
import { getTerminalPalette } from './settings-store';

/**
 * `@/lib/ghosttyTheme` 的 PWA 桩：手机不打包整份 ghostty 主题库（几百套），
 * 桌面只下发当前选中主题解析后的调色板，这里直接返回它。
 * UI 配色映射逻辑与桌面 src/renderer/lib/ghosttyTheme.ts 保持一致
 * （sync-terminal 模式下整套 UI 变量由终端配色推导）。
 * 经 vite alias 注入，TerminalOutput 无需改动。
 */

export type XtermTheme = TerminalPalette;

export const defaultDarkTheme: XtermTheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  selectionForeground: '#ffffff',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

/** 忽略主题名：手机侧只有桌面下发的那一套调色板 */
export function getXtermTheme(_name?: string): XtermTheme | undefined {
  return getTerminalPalette();
}

// ── 颜色工具（与桌面同实现）──────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i.exec(hex.trim());
  return m
    ? { r: Number.parseInt(m[1], 16), g: Number.parseInt(m[2], 16), b: Number.parseInt(m[3], 16) }
    : null;
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
}

function mixColors(color1: string, color2: string, weight: number): string {
  const c1 = hexToRgb(color1);
  const c2 = hexToRgb(color2);
  if (!c1 || !c2) return color1;
  const w = Math.max(0, Math.min(1, weight));
  return rgbToHex(c1.r * (1 - w) + c2.r * w, c1.g * (1 - w) + c2.g * w, c1.b * (1 - w) + c2.b * w);
}

function getLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function isTerminalThemeDark(_name?: string): boolean {
  const theme = getXtermTheme();
  if (!theme) return true;
  return getLuminance(theme.background) < 0.5;
}

const THEMED_VARS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--success',
  '--success-foreground',
  '--warning',
  '--warning-foreground',
  '--info',
  '--info-foreground',
  '--border',
  '--input',
  '--ring',
];

/** 把终端配色映射到整套 UI 变量（sync-terminal 模式），与桌面同一套推导 */
export function applyTerminalThemeToApp(_name?: string, syncDarkMode = true): void {
  const theme = getXtermTheme();
  if (!theme) return;

  const root = document.documentElement;
  const isDark = getLuminance(theme.background) < 0.5;
  if (syncDarkMode) root.classList.toggle('dark', isDark);

  root.style.setProperty('--background', theme.background);
  root.style.setProperty('--foreground', theme.foreground);
  root.style.setProperty('--card', theme.background);
  root.style.setProperty('--card-foreground', theme.foreground);
  root.style.setProperty('--popover', theme.background);
  root.style.setProperty('--popover-foreground', theme.foreground);
  root.style.setProperty('--primary', theme.foreground);
  root.style.setProperty('--primary-foreground', theme.background);

  const secondaryBg = isDark
    ? mixColors(theme.background, theme.brightBlack, 0.5)
    : mixColors(theme.background, theme.black, 0.1);
  root.style.setProperty('--secondary', secondaryBg);
  root.style.setProperty('--secondary-foreground', theme.foreground);

  const mutedBg = isDark
    ? mixColors(theme.background, theme.brightBlack, 0.4)
    : mixColors(theme.background, theme.black, 0.08);
  const mutedFg = isDark
    ? mixColors(theme.foreground, theme.background, 0.4)
    : mixColors(theme.foreground, theme.background, 0.3);
  root.style.setProperty('--muted', mutedBg);
  root.style.setProperty('--muted-foreground', mutedFg);

  const accentColor = isDark ? theme.brightBlue : theme.blue;
  const softAccent = mixColors(theme.background, accentColor, 0.3);
  root.style.setProperty('--accent', softAccent);
  root.style.setProperty(
    '--accent-foreground',
    getLuminance(softAccent) < 0.5 ? '#ffffff' : '#000000'
  );

  root.style.setProperty('--destructive', theme.red);
  root.style.setProperty('--destructive-foreground', '#ffffff');
  root.style.setProperty('--success', theme.green);
  root.style.setProperty('--success-foreground', '#ffffff');
  root.style.setProperty('--warning', theme.yellow);
  root.style.setProperty('--warning-foreground', isDark ? theme.background : '#000000');
  root.style.setProperty('--info', theme.blue);
  root.style.setProperty('--info-foreground', '#ffffff');

  const borderColor = isDark
    ? mixColors(theme.background, theme.foreground, 0.15)
    : mixColors(theme.background, theme.foreground, 0.12);
  root.style.setProperty('--border', borderColor);
  root.style.setProperty('--input', borderColor);
  root.style.setProperty('--ring', isDark ? theme.brightBlue : theme.blue);
}

/** 还原为样式表里的默认配色 */
export function clearTerminalThemeFromApp(): void {
  for (const v of THEMED_VARS) document.documentElement.style.removeProperty(v);
}
