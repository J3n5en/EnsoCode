import { create } from 'zustand';

export interface SessionPeekBack {
  /** 跳转前所在的秘书会话 */
  from: string;
  /** 从弹窗跳进的会话 */
  to: string;
}

interface SessionPeekState {
  /** 弹窗里正在看的会话；null = 关闭 */
  conversationId: string | null;
  /** 从弹窗跳进会话后，在 to 会话里给「返回秘书」 */
  back: SessionPeekBack | null;
  open: (conversationId: string) => void;
  close: () => void;
  setBack: (back: SessionPeekBack | null) => void;
}

/** 秘书面板「看会话」弹窗：挂在 App 根上，开关不影响面板自己的展开与滚动 */
export const useSessionPeek = create<SessionPeekState>()((set) => ({
  conversationId: null,
  back: null,
  open: (conversationId) => set({ conversationId }),
  close: () => set({ conversationId: null }),
  setBack: (back) => set({ back }),
}));

export function openSessionPeek(conversationId: string): void {
  useSessionPeek.getState().open(conversationId);
}
