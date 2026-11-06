import { resolveTheme } from '@shared/theme/themeKey';
import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { backgroundAppearance } from '@/lib/backgroundAppearance';
import { type EffectiveBackground, effectiveBackground } from '@/lib/effectiveBackground';
import { availableThemes } from '@/lib/themeStyles';
import { usePluginThemesStore } from '@/stores/pluginThemes';
import { useSettingsStore } from '@/stores/settings';

/** 当前生效的背景：用户背景图优先，否则当前主题自带的背景 */
export function useEffectiveBackground(): EffectiveBackground | null {
  const user = useSettingsStore(
    useShallow((s) => ({
      backgroundImageEnabled: s.backgroundImageEnabled,
      backgroundSizeMode: s.backgroundSizeMode,
      backgroundOpacity: s.backgroundOpacity,
      backgroundBlur: s.backgroundBlur,
      backgroundBrightness: s.backgroundBrightness,
      backgroundSaturation: s.backgroundSaturation,
      backgroundMask: s.backgroundMask,
      backgroundComposerOpacity: s.backgroundComposerOpacity,
      backgroundCodeOpacity: s.backgroundCodeOpacity,
    }))
  );
  const themeId = useSettingsStore((s) => s.themeId);
  const pluginThemes = usePluginThemesStore((s) => s.themes);
  return useMemo(
    () =>
      effectiveBackground(user, resolveTheme(themeId, availableThemes(pluginThemes)).background),
    [user, themeId, pluginThemes]
  );
}

/**
 * 背景图的前景透明化。
 *
 * 背景可见度由 BackgroundLayer 在整张壁纸上合成一次，普通面板置透，
 * 避免侧栏、顶栏与内容区出现不同深度。重映射规则在 globals.css 的
 * `html.bg-image-enabled` 区块里，用 CSS 相对颜色语法
 * `oklch(from var(--background) l c h / alpha)` 派生 —— 因此天然兼容
 * light / dark / sync-terminal（ghostty 主题写入的任意颜色）。
 *
 * 本 hook 只负责：切换 <html> 的 bg-image-enabled 类 + 写入 alpha 变量。
 * 仅在主窗口 App 挂载（设置窗口保持不透明）。
 */
export function useBackgroundImage(): void {
  const background = useEffectiveBackground();

  useEffect(() => {
    const root = document.documentElement;
    const clear = () => {
      root.classList.remove('bg-image-enabled');
      root.style.removeProperty('--bg-panel-alpha');
      root.style.removeProperty('--bg-popover-alpha');
      root.style.removeProperty('--bg-code-alpha');
      root.style.removeProperty('--bg-composer-alpha');
    };

    if (!background) {
      clear();
      return;
    }
    const { opacity, composerOpacity, codeOpacity } = background;

    // 可见度在 BackgroundLayer 全局合成，前景面板不再重复铺底。
    const { panelAlpha, popoverAlpha } = backgroundAppearance(opacity);
    root.classList.add('bg-image-enabled');
    root.style.setProperty('--bg-panel-alpha', String(panelAlpha));
    // 弹出层（菜单/下拉/对话框）保底不透明度，否则叠在内容上没法读
    root.style.setProperty('--bg-popover-alpha', String(popoverAlpha));
    // 代码块/diff 视图不透明度独立可调（有自己的色深，但永远透出背景）
    root.style.setProperty('--bg-code-alpha', String(codeOpacity));
    // 输入框不透明度独立可调（设置项直接控制，不随可见度联动）
    root.style.setProperty('--bg-composer-alpha', String(composerOpacity));
    return clear;
  }, [background]);
}
