import type {
  BrowserAnnotationPinSpec,
  BrowserElementSnapshot,
  BrowserPickedElementRef,
  DesignCssSnapshot,
  DesignTopLeftRect,
  DesignXyRect,
} from '../browser/designAnnotation';

/** 内嵌浏览器当前 tab 状态(main → renderer 推送) */
export interface BrowserTabHolder {
  conversationId: string;
  name: string;
}

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
  /** 共享浏览器里正在操作该 tab 的成员会话 */
  holder: BrowserTabHolder | null;
}

export type BrowserClearKind = 'cookies' | 'cache' | 'all';

export type BrowserDesignMoveDirection = 'parent' | 'child' | 'next' | 'previous';

export interface BrowserSelectionDescription {
  elements: BrowserElementSnapshot[];
  regionAnchor?: BrowserElementSnapshot;
  image: {
    data: string;
    mimeType: string;
    name: 'design-element.png' | 'design-annotation.png';
    width: number;
    height: number;
  } | null;
  frame?: { data: string; mimeType: string };
}

export interface BrowserOpenPinResult {
  top: number;
  left: number;
  detached: boolean;
  rulerInset: number;
  viewportWidth: number;
}

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
  | {
      type: 'annotated';
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
  | { type: 'cancelled'; conversationId: string; tabId: string }
  | {
      type: 'select';
      conversationId: string;
      tabId: string;
      elements: BrowserPickedElementRef[];
      region: DesignXyRect | null;
      addToChat: boolean;
      viewportWidth: number;
      description: BrowserSelectionDescription;
    }
  | {
      type: 'drawing';
      conversationId: string;
      tabId: string;
      drawing: boolean;
    }
  | {
      type: 'pin-click';
      conversationId: string;
      tabId: string;
      id: string;
      pin: BrowserOpenPinResult | null;
    }
  | {
      type: 'pins';
      conversationId: string;
      tabId: string;
      ids: string[];
    };

export type {
  BrowserAnnotationPinSpec,
  BrowserElementSnapshot,
  BrowserPickedElementRef,
  DesignCssSnapshot,
  DesignTopLeftRect,
  DesignXyRect,
};
