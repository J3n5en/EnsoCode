import { BUILTIN_THEMES } from '@shared/theme/builtinThemes';
import { resolveTheme } from '@shared/theme/themeKey';
import { themeTokensCss } from '@shared/theme/tokensCss';
import type { ThemeDefinition } from '@shared/theme/types';
import { startPluginThemes, usePluginThemesStore } from '@/stores/pluginThemes';
import { type SettingsState, useSettingsStore } from '@/stores/settings';

/** 按此顺序追加到 <head> 末尾，后者覆盖前者 */
const STYLE_IDS = ['enso-theme-tokens', 'enso-theme-css', 'enso-user-css'] as const;

function writeStyle(id: (typeof STYLE_IDS)[number], css: string): void {
  if (!document.getElementById(STYLE_IDS[0])) {
    for (const styleId of STYLE_IDS) {
      const style = document.createElement('style');
      style.id = styleId;
      document.head.append(style);
    }
  }
  const style = document.getElementById(id);
  if (style && style.textContent !== css) style.textContent = css;
}

/** 内置主题加上已加载的插件主题 */
export function availableThemes(
  pluginThemes = usePluginThemesStore.getState().themes
): readonly ThemeDefinition[] {
  return pluginThemes ? [...BUILTIN_THEMES, ...pluginThemes] : BUILTIN_THEMES;
}

function applyTheme({ themeId, accentColor }: SettingsState): void {
  const pluginThemes = usePluginThemesStore.getState().themes;
  // 插件主题还在读：保持上一个主题，免得先闪回 enso
  if (pluginThemes === null && !BUILTIN_THEMES.some((theme) => theme.id === themeId)) return;
  const theme = resolveTheme(themeId, availableThemes(pluginThemes));
  writeStyle('enso-theme-tokens', themeTokensCss(theme, accentColor));
  writeStyle('enso-theme-css', theme.css ?? '');
  document.documentElement.dataset.theme = theme.id;
}

/** 窗口入口在首次渲染前调用，水合完成或设置变更后跟随重写 */
export function installThemeStyles(): void {
  applyTheme(useSettingsStore.getState());
  useSettingsStore.subscribe((state, prev) => {
    if (state.themeId !== prev.themeId || state.accentColor !== prev.accentColor) {
      applyTheme(state);
    }
    if (state.userCssEnabled !== prev.userCssEnabled) void syncUserCss();
  });
  usePluginThemesStore.subscribe((state, prev) => {
    if (state.themes !== prev.themes) applyTheme(useSettingsStore.getState());
  });
  startPluginThemes();
  window.electronAPI.appearance.onUserCssChanged(() => void syncUserCss());
  void syncUserCss();
}

let userCssRead = 0;

/** 只认最后一次读取：开关或文件在读取途中又变了，旧结果作废 */
async function syncUserCss(): Promise<void> {
  const read = ++userCssRead;
  const css = useSettingsStore.getState().userCssEnabled
    ? ((await window.electronAPI.appearance.readUserCss()) ?? '')
    : '';
  if (read === userCssRead) writeStyle('enso-user-css', css);
}
