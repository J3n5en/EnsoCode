/** 内嵌浏览器当前 tab 状态(main → renderer 推送) */
export interface BrowserTabState {
  /** 无 tab 时为 null */
  tabId: string | null;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** agent 正在操作(第 3 刀 lock);面板显示「接管」 */
  locked: boolean;
}

export type BrowserClearKind = 'cookies' | 'cache' | 'all';
