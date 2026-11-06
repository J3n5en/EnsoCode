import { type TitleBarAppearance, toTitleBarHex } from '@shared/windowControls';
import { type RefObject, useEffect } from 'react';

/**
 * 用实际标题栏配色同步原生按钮。画布将 OKLCH 等 CSS 颜色转为 Electron 可接受的十六进制色。
 * 按钮底色保留 alpha：标题栏透明/半透明（壁纸模式）时原生按钮区一起透出壁纸，
 * 不再是一块实色。宿主窗口底色取画布色，必须不透明。
 *
 * Synchronize native controls with the rendered title bar. A canvas converts CSS
 * colors such as OKLCH into hex accepted by Electron, keeping the overlay alpha.
 */
export function useNativeWindowControls(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (window.electronAPI.env.platform !== 'win32') return;
    const header = ref.current;
    if (!header) return;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    const hex = (color: string, opaque: boolean): string => {
      context.clearRect(0, 0, 1, 1);
      // 不透明色先铺黑底：半透明图标色/画布色压成实色，而不是丢 alpha
      if (opaque) {
        context.fillStyle = '#000';
        context.fillRect(0, 0, 1, 1);
      }
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return toTitleBarHex(context.getImageData(0, 0, 1, 1).data);
    };
    let frame = 0;
    let previous = '';
    const sync = () => {
      frame = 0;
      const style = getComputedStyle(header);
      const canvasColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--color-canvas')
        .trim();
      const appearance: TitleBarAppearance = {
        color: hex(style.backgroundColor, false),
        symbolColor: hex(style.color, true),
        ...(canvasColor ? { surface: hex(canvasColor, true) } : {}),
      };
      const key = JSON.stringify(appearance);
      if (key === previous) return;
      previous = key;
      void window.electronAPI.window.setTitleBarAppearance(appearance).then(
        (result) => {
          if (!result.ok) console.error('[window] title bar appearance:', result.error);
        },
        (error: unknown) => console.error('[window] title bar appearance:', error)
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });
    observer.observe(header, { attributes: true, attributeFilter: ['class'] });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', schedule);
    schedule();
    return () => {
      observer.disconnect();
      media.removeEventListener('change', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref]);
}
