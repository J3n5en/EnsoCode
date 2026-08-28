import type { HostAppearance } from '@enso/pair';

/**
 * 主题优先级：本地覆盖 > 桌面下发 > 跟随系统。
 * 一旦用户在手机上显式选过，就不再被桌面的主题变更打断。
 */

export type ThemePreference = 'auto' | HostAppearance;

const OVERRIDE_KEY = 'enso-phone-theme';

let hostTheme: HostAppearance = 'system';
let override: ThemePreference = readOverride();
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function readOverride(): ThemePreference {
  const raw = localStorage.getItem(OVERRIDE_KEY);
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'auto';
}

/** 生效的取值：auto 表示跟随桌面 */
function effective(): HostAppearance {
  return override === 'auto' ? hostTheme : override;
}

function apply(): void {
  const dark = effective() === 'system' ? media.matches : effective() === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  for (const listener of listeners) listener();
}

/** 桌面下发的偏好（仅在未本地覆盖时生效） */
export function setHostTheme(theme: HostAppearance): void {
  hostTheme = theme;
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

/** 当前实际解析出的深浅色（供 UI 展示） */
export function resolvedIsDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initTheme(): void {
  apply();
  media.addEventListener('change', apply);
}
