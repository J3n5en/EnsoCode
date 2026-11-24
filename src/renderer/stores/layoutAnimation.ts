import { create } from 'zustand';

/** 右侧面板宽度动画进行中：聊天区逐帧重排，这期间的离底不是用户上滚，也不该被贴底纠正 */
export const useLayoutAnimationStore = create<{ active: boolean }>(() => ({ active: false }));

export const isLayoutAnimating = (): boolean => useLayoutAnimationStore.getState().active;

export function setLayoutAnimating(active: boolean): void {
  if (isLayoutAnimating() !== active) useLayoutAnimationStore.setState({ active });
}
