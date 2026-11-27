import { useLayoutEffect } from 'react';
import { setWorkbenchCovered } from '@/stores/appView';
import { acquireWorkbenchCover, releaseWorkbenchCover } from './overlayGuard';

/**
 * 设置页盖住工作区：标记 workbench 被盖住（原生视图与面板快捷键据此让位），
 * 同时借浮层守卫在 React 提交阶段就让 guest 沉到 workbench 之下。
 * 只靠 guest 自己的 rAF 推矩形，头几帧仍会叠在设置页上吃掉点击。
 */
export function useWorkspaceCovered(covered: boolean): void {
  useLayoutEffect(() => {
    setWorkbenchCovered(covered);
    if (!covered) return;
    acquireWorkbenchCover();
    return releaseWorkbenchCover;
  }, [covered]);
}
