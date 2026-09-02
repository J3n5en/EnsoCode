/** 内嵌浏览器当前 tab 状态(main → renderer 推送) */
export interface BrowserTabState {
  /** 无 tab 时为 null */
  tabId: string | null;
  url: string;
  title: string;
  /** 当前页 favicon；没有或不可用为 null */
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** agent 正在操作(第 3 刀 lock);面板显示「接管」 */
  locked: boolean;
  /** 面板内嵌原生 Chrome DevTools */
  devtoolsOpen: boolean;
  /** 用户圈选 Design Mode */
  designMode: boolean;
}

export type BrowserClearKind = 'cookies' | 'cache' | 'all';

export type BrowserDesignModeEvent =
  | {
      type: 'picked';
      conversationId: string;
      tabId: string;
      payload: {
        label: string;
        path: string;
        text: string;
        tag?: string;
        id?: string;
        className?: string;
        rect?: { x: number; y: number; width: number; height: number };
        component?: string;
      };
      image?: { data: string; mimeType: string };
    }
  | { type: 'cancelled'; conversationId: string; tabId: string };
