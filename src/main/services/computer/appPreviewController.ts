export interface PreviewTarget {
  owner: string;
  windowId: string;
  pid: number;
  app: string;
  path: string;
  size: () => Promise<{ width: number; height: number } | undefined>;
}

export interface PreviewView {
  show(input: {
    windowId: string;
    app: string;
    path: string;
    size: { width: number; height: number } | undefined;
  }): void;
  hide(): void;
  dispose(): void;
  /** 在画面里标出点击位置（相对窗口的比例） */
  pointer(fx: number, fy: number): void;
}

/**
 * 后台操作的画中画预览：跟随最近被操作的窗口，所有 run 结束后延时收起。
 * 用户手动关掉后，同一窗口在这一轮操作里不再弹出。
 */
export class PreviewController {
  private readonly active = new Set<string>();
  private closed: string | undefined;
  private shown: string | undefined;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private view: PreviewView | undefined;

  constructor(
    private readonly deps: {
      enabled: () => boolean;
      view: () => PreviewView;
      hideDelayMs: number;
    }
  ) {}

  async activity(target: PreviewTarget): Promise<void> {
    if (!this.deps.enabled()) return;
    this.active.add(target.owner);
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    if (this.closed === target.windowId) return;
    const size = await target.size().catch(() => undefined);
    if (!this.active.has(target.owner) || this.closed === target.windowId) return;
    this.view ??= this.deps.view();
    this.view.show({ windowId: target.windowId, app: target.app, path: target.path, size });
    this.shown = target.windowId;
  }

  /** 正在显示这个窗口时把指针画进画中画；返回是否画了 */
  pointer(windowId: string, fx: number, fy: number): boolean {
    if (!this.view || this.shown !== windowId) return false;
    this.view.pointer(fx, fy);
    return true;
  }

  runEnd(owner: string): void {
    if (!this.active.delete(owner) || this.active.size > 0) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = undefined;
      this.closed = undefined;
      this.shown = undefined;
      this.view?.hide();
    }, this.deps.hideDelayMs);
  }

  userClosed(windowId: string): void {
    this.closed = windowId;
    this.shown = undefined;
    this.view?.hide();
  }

  dispose(): void {
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    this.active.clear();
    this.closed = undefined;
    this.shown = undefined;
    this.view?.dispose();
    this.view = undefined;
  }
}
