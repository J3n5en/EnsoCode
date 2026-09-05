import { useLayoutEffect } from 'react';
import { acquireOverlayGuard, releaseOverlayGuard } from '@/lib/overlayGuard';

/**
 * 模态浮层挂载期间把原生 guest view 压到 workbench 之下。
 * 用 layout effect：在浏览器 paint 出弹窗之前就把 IPC 发出去，去掉「被网页挡一帧」的闪。
 */
export function useOverlayGuard(active = true): void {
  useLayoutEffect(() => {
    if (!active) return;
    acquireOverlayGuard();
    return () => releaseOverlayGuard();
  }, [active]);
}

/** Portal 子节点：Popup 外壳在关闭时仍挂载，guard 写在外壳上会把 guest 永远压住。 */
export function OverlayGuardHost(): null {
  useOverlayGuard();
  return null;
}
