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
