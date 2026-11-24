export interface HistoryWindow {
  history: {
    readonly state: unknown;
    pushState(state: unknown, unused: string): void;
    go(delta?: number): void;
  };
  addEventListener(type: 'popstate', listener: (event: { state: unknown }) => void): void;
  removeEventListener(type: 'popstate', listener: (event: { state: unknown }) => void): void;
}

const KEY = 'ensoSettingsDepth';

const depthOf = (state: unknown): number => {
  const value = (state as Record<string, unknown> | null)?.[KEY];
  return typeof value === 'number' ? value : 0;
};

/**
 * 远程浏览器（/desk）里设置页的层级同步到浏览器历史：后退 / 手势返回先退出分区详情，再回到工作区，
 * 不会直接离开页面。界面按钮返回时把自己压的历史退掉，那次 popstate 不当成用户后退。
 */
export function bindSettingsHistory(
  win: HistoryWindow,
  view: {
    depth: () => number;
    apply: (depth: number) => void;
    subscribe: (listener: () => void) => () => void;
  }
): () => void {
  let depth = depthOf(win.history.state);
  let popping = false;

  const reconcile = () => {
    if (popping) return;
    const target = view.depth();
    while (depth < target) {
      depth += 1;
      win.history.pushState({ [KEY]: depth }, '');
    }
    if (depth > target) {
      popping = true;
      win.history.go(target - depth);
    }
  };

  const onPopState = (event: { state: unknown }) => {
    depth = depthOf(event.state);
    if (popping) {
      popping = false;
      reconcile();
      return;
    }
    if (view.depth() !== depth) view.apply(depth);
  };

  win.addEventListener('popstate', onPopState);
  const unsubscribe = view.subscribe(reconcile);
  reconcile();
  return () => {
    unsubscribe();
    win.removeEventListener('popstate', onPopState);
  };
}
