import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/settings';

/**
 * 背景图的前景透明化。
 *
 * 「透明度」的真正实现：背景图本身不变透明，而是把前景面板的颜色令牌
 * （--color-background/card/popover/... ）重映射为带 alpha 的半透明色，
 * 让背景图从面板后面透出来。重映射规则在 globals.css 的
 * `html.bg-image-enabled` 区块里，用 CSS 相对颜色语法
 * `oklch(from var(--background) l c h / alpha)` 派生 —— 因此天然兼容
 * light / dark / sync-terminal（ghostty 主题写入的任意颜色）。
 *
 * 本 hook 只负责：切换 <html> 的 bg-image-enabled 类 + 写入三个 alpha 变量。
 * 仅在主窗口 App 挂载（设置窗口保持不透明）。
 */
export function useBackgroundImage(): void {
  const enabled = useSettingsStore((s) => s.backgroundImageEnabled);
  const opacity = useSettingsStore((s) => s.backgroundOpacity);
  const composerOpacity = useSettingsStore((s) => s.backgroundComposerOpacity);
  const codeOpacity = useSettingsStore((s) => s.backgroundCodeOpacity);

  useEffect(() => {
    const root = document.documentElement;
    const clear = () => {
      root.classList.remove('bg-image-enabled');
      root.style.removeProperty('--bg-panel-alpha');
      root.style.removeProperty('--bg-popover-alpha');
      root.style.removeProperty('--bg-border-alpha');
      root.style.removeProperty('--bg-code-alpha');
      root.style.removeProperty('--bg-composer-alpha');
    };

    if (!enabled) {
      clear();
      return;
    }

    // backgroundOpacity 是「背景可见度」，面板 alpha 取补
    const panelAlpha = Math.min(1, Math.max(0, 1 - opacity));
    root.classList.add('bg-image-enabled');
    root.style.setProperty('--bg-panel-alpha', String(panelAlpha));
    // 弹出层（菜单/下拉/对话框）保底不透明度，否则叠在内容上没法读
    root.style.setProperty('--bg-popover-alpha', String(Math.max(panelAlpha, 0.92)));
    // 边框比面板略实一点，保住布局轮廓
    root.style.setProperty('--bg-border-alpha', String(Math.min(1, panelAlpha + 0.25)));
    // 代码块/diff 视图不透明度独立可调（有自己的色深，但永远透出背景）
    root.style.setProperty('--bg-code-alpha', String(codeOpacity));
    // 输入框不透明度独立可调（设置项直接控制，不随可见度联动）
    root.style.setProperty('--bg-composer-alpha', String(composerOpacity));
    return clear;
  }, [enabled, opacity, composerOpacity, codeOpacity]);
}
