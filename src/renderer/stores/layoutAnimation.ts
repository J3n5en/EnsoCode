import { create } from 'zustand';

/** 面板宽度动画进行中：聊天区逐帧重排，这期间的离底不是用户上滚，也不该被贴底纠正。
 *  侧栏与右侧面板可能同时动画，按来源计数，全部结束才算停。 */
export const useLayoutAnimationStore = create<{ active: boolean }>(() => ({ active: false }));

const activeSources = new Set<string>();

export const isLayoutAnimating = (): boolean => useLayoutAnimationStore.getState().active;

export function setLayoutAnimating(active: boolean, source = 'default'): void {
  if (active) {
    activeSources.add(source);
  } else {
    activeSources.delete(source);
  }
  const next = activeSources.size > 0;
  if (isLayoutAnimating() !== next) useLayoutAnimationStore.setState({ active: next });
}
