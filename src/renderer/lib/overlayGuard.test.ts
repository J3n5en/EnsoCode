import { beforeEach, describe, expect, it } from 'vitest';
import {
  acquireOverlayGuard,
  acquireWorkbenchCover,
  overlayGuardActive,
  releaseOverlayGuard,
  releaseWorkbenchCover,
  resetOverlayGuard,
  setOverlayGuardSink,
  syncOverlayGuard,
} from './overlayGuard';

let events: boolean[] = [];

beforeEach(() => {
  events = [];
  resetOverlayGuard();
  setOverlayGuardSink((active) => events.push(active));
});

describe('overlayGuard', () => {
  it('signals once when the first modal opens', () => {
    acquireOverlayGuard();
    expect(events).toEqual([true]);
  });

  it('does not re-signal for nested modals', () => {
    acquireOverlayGuard();
    acquireOverlayGuard();
    expect(events).toEqual([true]);
  });

  it('stays active until the last modal closes', () => {
    acquireOverlayGuard();
    acquireOverlayGuard();
    releaseOverlayGuard();
    expect(events).toEqual([true]);
    releaseOverlayGuard();
    expect(events).toEqual([true, false]);
  });

  it('tolerates an electronAPI without the browser bridge (PWA shim)', () => {
    const g = globalThis as { window?: unknown };
    const had = 'window' in g;
    g.window = { electronAPI: {} };
    setOverlayGuardSink();
    try {
      expect(() => acquireOverlayGuard()).not.toThrow();
    } finally {
      if (!had) delete g.window;
    }
  });

  it('resyncs the full state on mount so Main cannot hold a stale latch', () => {
    syncOverlayGuard();
    expect(events).toEqual([false]);
    acquireOverlayGuard();
    syncOverlayGuard();
    expect(events).toEqual([false, true, true]);
  });

  it('ignores unbalanced releases', () => {
    releaseOverlayGuard();
    expect(events).toEqual([]);
    acquireOverlayGuard();
    releaseOverlayGuard();
    releaseOverlayGuard();
    expect(events).toEqual([true, false]);
  });
});

describe('workbench cover', () => {
  it('沉下 guest，但不算会吃 Esc 的模态浮层', () => {
    acquireWorkbenchCover();
    expect(events).toEqual([true]);
    expect(overlayGuardActive()).toBe(false);
    releaseWorkbenchCover();
    expect(events).toEqual([true, false]);
  });

  it('遮盖期间弹窗开了又关：sink 保持 true 不闪动，模态判定随弹窗走', () => {
    acquireWorkbenchCover();
    acquireOverlayGuard();
    expect(overlayGuardActive()).toBe(true);
    releaseOverlayGuard();
    expect(events).toEqual([true]);
    expect(overlayGuardActive()).toBe(false);
    releaseWorkbenchCover();
    expect(events).toEqual([true, false]);
  });

  it('reset 同时清零遮盖计数', () => {
    acquireWorkbenchCover();
    resetOverlayGuard();
    setOverlayGuardSink((active) => events.push(active));
    events = [];
    acquireOverlayGuard();
    releaseOverlayGuard();
    expect(events).toEqual([true, false]);
  });
});
