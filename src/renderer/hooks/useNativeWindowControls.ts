import type { TitleBarAppearance } from '@shared/windowControls';
import { type RefObject, useEffect } from 'react';

/**
 * 用实际标题栏配色同步原生按钮。画布将 OKLCH 等 CSS 颜色转为 Electron 可接受的 RGB。
 *
 * Synchronize native controls with the rendered title bar. A canvas converts CSS
 * colors such as OKLCH into RGB values accepted by Electron.
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
    const rgb = (color: string): string => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    };
    let frame = 0;
    let previous = '';
    const sync = () => {
      frame = 0;
      const style = getComputedStyle(header);
      const appearance: TitleBarAppearance = {
        color: rgb(style.backgroundColor),
        symbolColor: rgb(style.color),
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
