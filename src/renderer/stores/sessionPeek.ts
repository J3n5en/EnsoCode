import { create } from 'zustand';

/** 已完成条目：弹窗多一个「结果」页，默认先看结果 */
export interface SessionPeekResult {
  /** 会话删了也能显示的标题快照 */
  title?: string;
  /** 没存下报告时（旧数据、手动标记完成）显示的看板正文 */
  fallback?: string;
}

export type SessionPeekTab = 'result' | 'session';

interface SessionPeekState {
  /** 弹窗里正在看的会话；null = 关闭 */
  conversationId: string | null;
  /** 有值才显示「结果 / 会话」切换 */
  result: SessionPeekResult | null;
  tab: SessionPeekTab;
  /** 发起查看的秘书会话；不在秘书会话里打开（侧栏悬停卡）时由入口给出 */
  from: string | null;
  open: (conversationId: string, result?: SessionPeekResult, from?: string) => void;
  setTab: (tab: SessionPeekTab) => void;
  close: () => void;
}

/** 秘书面板「看会话」弹窗：挂在 App 根上，开关不影响面板自己的展开与滚动 */
export const useSessionPeek = create<SessionPeekState>()((set) => ({
  conversationId: null,
  result: null,
  tab: 'session',
  from: null,
  open: (conversationId, result, from) =>
    set({
      conversationId,
      result: result ?? null,
      tab: result ? 'result' : 'session',
      from: from ?? null,
    }),
  setTab: (tab) => set({ tab }),
  close: () => set({ conversationId: null, result: null, tab: 'session', from: null }),
}));

export function openSessionPeek(
  conversationId: string,
  result?: SessionPeekResult,
  from?: string
): void {
  useSessionPeek.getState().open(conversationId, result, from);
}
