import { describe, expect, it } from 'vitest';
import {
  applyWindowsChromiumSwitches,
  attachPinnedWorkbenchBoundsSync,
  attachWindowsRestoreWake,
  pinnedWorkbenchBounds,
  showWindowIfRestoredHidden,
  windowsOcclusionDisableFeatures,
} from './win32Restore';

function fakeWindow(init: {
  destroyed?: boolean;
  minimized?: boolean;
  visible?: boolean;
  width?: number;
  height?: number;
}) {
  const listeners = new Map<string, Array<() => void>>();
  const win = {
    destroyed: init.destroyed ?? false,
    minimized: init.minimized ?? false,
    visible: init.visible ?? true,
    width: init.width ?? 1400,
    height: init.height ?? 900,
    showCalls: 0,
    isDestroyed() {
      return this.destroyed;
    },
    isMinimized() {
      return this.minimized;
    },
    isVisible() {
      return this.visible;
    },
    getContentBounds() {
      return { width: this.width, height: this.height };
    },
    on(event: string, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    show() {
      this.showCalls += 1;
      this.visible = true;
    },
  };
  return win;
}

describe('pinnedWorkbenchBounds', () => {
  it('returns content bounds for a visible window', () => {
    expect(pinnedWorkbenchBounds(fakeWindow({ width: 1400, height: 900 }))).toEqual({
      x: 0,
      y: 0,
      width: 1400,
      height: 900,
    });
  });

  it('does not collapse the workbench while minimized or when content bounds are empty', () => {
    expect(
      pinnedWorkbenchBounds(fakeWindow({ minimized: true, width: 1400, height: 900 }))
    ).toBeNull();
    expect(pinnedWorkbenchBounds(fakeWindow({ width: 0, height: 0 }))).toBeNull();
    expect(pinnedWorkbenchBounds(fakeWindow({ width: -32000, height: -32000 }))).toBeNull();
    expect(pinnedWorkbenchBounds(fakeWindow({ destroyed: true }))).toBeNull();
  });
});

describe('attachPinnedWorkbenchBoundsSync', () => {
  it('keeps last good bounds through minimize and re-syncs on restore', () => {
    const win = fakeWindow({ width: 1400, height: 900 });
    const view = {
      bounds: null as { x: number; y: number; width: number; height: number } | null,
      setBounds(bounds: { x: number; y: number; width: number; height: number }) {
        this.bounds = bounds;
      },
    };

    attachPinnedWorkbenchBoundsSync(win, view);
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1400, height: 900 });

    win.minimized = true;
    win.width = 0;
    win.height = 0;
    win.emit('resize');
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1400, height: 900 });

    view.bounds = { x: 0, y: 0, width: 0, height: 0 };
    win.minimized = false;
    win.width = 1400;
    win.height = 900;
    win.emit('restore');
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1400, height: 900 });
  });

  it('re-syncs after restore settles if the first tick was still minimized', async () => {
    const win = fakeWindow({ width: 1400, height: 900 });
    const view = {
      bounds: null as { x: number; y: number; width: number; height: number } | null,
      setBounds(bounds: { x: number; y: number; width: number; height: number }) {
        this.bounds = bounds;
      },
    };

    attachPinnedWorkbenchBoundsSync(win, view);
    view.bounds = { x: 0, y: 0, width: 0, height: 0 };
    win.minimized = true;
    win.width = 0;
    win.height = 0;
    win.emit('restore');
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });

    win.minimized = false;
    win.width = 1400;
    win.height = 900;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1400, height: 900 });
  });

  it('re-syncs on maximize and unmaximize', () => {
    const win = fakeWindow({ width: 1400, height: 900 });
    const view = {
      bounds: null as { x: number; y: number; width: number; height: number } | null,
      setBounds(bounds: { x: number; y: number; width: number; height: number }) {
        this.bounds = bounds;
      },
    };

    attachPinnedWorkbenchBoundsSync(win, view);
    win.width = 1920;
    win.height = 1080;
    win.emit('maximize');
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });

    win.width = 1400;
    win.height = 900;
    win.emit('unmaximize');
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1400, height: 900 });
  });
});

describe('showWindowIfRestoredHidden', () => {
  it('shows a restored window that never became visible', () => {
    const win = fakeWindow({ visible: false });
    showWindowIfRestoredHidden(win);
    expect(win.showCalls).toBe(1);
    expect(win.visible).toBe(true);
  });

  it('does not show a minimized or already visible window', () => {
    const minimized = fakeWindow({ minimized: true, visible: false });
    showWindowIfRestoredHidden(minimized);
    expect(minimized.showCalls).toBe(0);

    const visible = fakeWindow({ visible: true });
    showWindowIfRestoredHidden(visible);
    expect(visible.showCalls).toBe(0);
  });
});

describe('attachWindowsRestoreWake', () => {
  it('does not show on unmaximize restore', () => {
    const win = fakeWindow({ visible: false });
    attachWindowsRestoreWake(win);
    win.emit('restore');
    expect(win.showCalls).toBe(0);
  });

  it('shows after a minimize restore that is still hidden on the first tick', async () => {
    const win = fakeWindow({ visible: false, minimized: true });
    attachWindowsRestoreWake(win);
    win.emit('minimize');
    win.emit('restore');
    expect(win.showCalls).toBe(0);

    win.minimized = false;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(win.showCalls).toBe(1);
    expect(win.visible).toBe(true);
  });
});

describe('windowsOcclusionDisableFeatures', () => {
  it('disables native window occlusion on Windows only', () => {
    expect(windowsOcclusionDisableFeatures('win32')).toBe('CalculateNativeWinOcclusion');
    expect(windowsOcclusionDisableFeatures('darwin')).toBeNull();
    expect(windowsOcclusionDisableFeatures('linux')).toBeNull();
  });
});

describe('applyWindowsChromiumSwitches', () => {
  it('appends disable-features only on Windows', () => {
    const calls: Array<[string, string?]> = [];
    const commandLine = {
      appendSwitch(name: string, value?: string) {
        calls.push([name, value]);
      },
    };
    applyWindowsChromiumSwitches(commandLine, 'win32');
    expect(calls).toEqual([['disable-features', 'CalculateNativeWinOcclusion']]);
    calls.length = 0;
    applyWindowsChromiumSwitches(commandLine, 'darwin');
    expect(calls).toEqual([]);
  });

  it('merges into an existing disable-features list', () => {
    const calls: Array<[string, string?]> = [];
    const commandLine = {
      getSwitchValue(name: string) {
        return name === 'disable-features' ? 'SomeOtherFeature' : '';
      },
      appendSwitch(name: string, value?: string) {
        calls.push([name, value]);
      },
    };
    applyWindowsChromiumSwitches(commandLine, 'win32');
    expect(calls).toEqual([['disable-features', 'SomeOtherFeature,CalculateNativeWinOcclusion']]);
  });
});
