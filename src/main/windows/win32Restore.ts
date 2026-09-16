/**
 * Windows 透明主窗口最小化后唤不回的防御：不把 0×0 写进 workbench，
 * restore 后再同步一次，并合并 CalculateNativeWinOcclusion。根因未在真机二分。
 */

export interface WorkbenchHostWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  getContentBounds(): { width: number; height: number };
  on(event: 'resize' | 'restore' | 'show' | 'maximize' | 'unmaximize', listener: () => void): void;
}

export interface WorkbenchView {
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
}

export function pinnedWorkbenchBounds(win: WorkbenchHostWindow): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  if (win.isDestroyed() || win.isMinimized()) return null;
  const { width, height } = win.getContentBounds();
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { x: 0, y: 0, width, height };
}

export function attachPinnedWorkbenchBoundsSync(
  win: WorkbenchHostWindow,
  view: WorkbenchView
): { resync: () => void } {
  const sync = (): void => {
    const bounds = pinnedWorkbenchBounds(win);
    if (bounds) view.setBounds(bounds);
  };
  const syncSoon = (): void => {
    sync();
    setImmediate(sync);
  };
  win.on('resize', sync);
  win.on('restore', syncSoon);
  win.on('show', syncSoon);
  win.on('maximize', syncSoon);
  win.on('unmaximize', syncSoon);
  sync();
  return { resync: syncSoon };
}

export function showWindowIfRestoredHidden(win: {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  show(): void;
}): void {
  if (win.isDestroyed() || win.isMinimized() || win.isVisible()) return;
  win.show();
}

export function attachWindowsRestoreWake(win: {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  show(): void;
  on(event: 'minimize' | 'restore', listener: () => void): void;
}): void {
  let fromMinimize = false;
  win.on('minimize', () => {
    fromMinimize = true;
  });
  win.on('restore', () => {
    if (!fromMinimize) return;
    showWindowIfRestoredHidden(win);
    setImmediate(() => {
      showWindowIfRestoredHidden(win);
      if (!win.isMinimized()) fromMinimize = false;
    });
  });
}

export function windowsOcclusionDisableFeatures(platform: string): string | null {
  return platform === 'win32' ? 'CalculateNativeWinOcclusion' : null;
}

export function applyWindowsChromiumSwitches(
  commandLine: {
    appendSwitch(switchName: string, value?: string): void;
    getSwitchValue?: (switchName: string) => string;
  },
  platform: string = process.platform
): void {
  const features = windowsOcclusionDisableFeatures(platform);
  if (!features) return;
  const existing = commandLine.getSwitchValue?.('disable-features') ?? '';
  const parts = existing
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.includes(features)) parts.push(features);
  commandLine.appendSwitch('disable-features', parts.join(','));
}
