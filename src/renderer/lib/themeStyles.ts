import { BUILTIN_THEMES } from '@shared/theme/builtinThemes';
import { resolveTheme } from '@shared/theme/themeKey';
import { themeTokensCss } from '@shared/theme/tokensCss';
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

function applyThemeTokens({ themeId, accentColor }: SettingsState): void {
  const theme = resolveTheme(themeId, BUILTIN_THEMES);
  writeStyle('enso-theme-tokens', themeTokensCss(theme, accentColor));
  document.documentElement.dataset.theme = theme.id;
}

/** 窗口入口在首次渲染前调用，水合完成或设置变更后跟随重写 */
export function installThemeStyles(): void {
  applyThemeTokens(useSettingsStore.getState());
  useSettingsStore.subscribe((state, prev) => {
    if (state.themeId !== prev.themeId || state.accentColor !== prev.accentColor) {
      applyThemeTokens(state);
    }
    if (state.userCssEnabled !== prev.userCssEnabled) void syncUserCss();
  });
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
  if (read === userCssRead) applyUserCss(css);
}

export function applyThemeCss(css: string): void {
  writeStyle('enso-theme-css', css);
}

export function applyUserCss(css: string): void {
  writeStyle('enso-user-css', css);
}
