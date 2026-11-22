import { useSyncExternalStore } from 'react';

/** 与 Tailwind `md` 断点一致；桌面主窗口 minWidth=800，故只有远程浏览器窄屏会命中。 */
export const MOBILE_MAX_WIDTH = 767;
/** 触屏横屏放宽到这个宽度仍用手机布局（手机横屏约 844–932，iPad 更宽走桌面） */
export const COARSE_MOBILE_MAX_WIDTH = 1024;

export const isMobileWidth = (width: number): boolean => width <= MOBILE_MAX_WIDTH;

/** 触屏按更宽的上限，鼠标按原断点 */
export const isMobileLayout = (width: number, coarsePointer: boolean): boolean =>
  width <= (coarsePointer ? COARSE_MOBILE_MAX_WIDTH : MOBILE_MAX_WIDTH);

const coarsePointer = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;

/** 非 React 场景（store 动作）用：当前是不是手机布局 */
export const isMobileViewport = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.innerWidth === 'number' &&
  isMobileLayout(window.innerWidth, coarsePointer());

const subscribe = (onChange: () => void) => {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
};

export function useViewportWidth(): number {
  return useSyncExternalStore(
    subscribe,
    () => window.innerWidth,
    () => 1024
  );
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isMobileLayout(window.innerWidth, coarsePointer()),
    () => false
  );
}
