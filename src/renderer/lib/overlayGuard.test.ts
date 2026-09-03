import { beforeEach, describe, expect, it } from 'vitest';
import {
  acquireOverlayGuard,
  releaseOverlayGuard,
  resetOverlayGuard,
  setOverlayGuardSink,
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

  it('ignores unbalanced releases', () => {
    releaseOverlayGuard();
    expect(events).toEqual([]);
    acquireOverlayGuard();
    releaseOverlayGuard();
    releaseOverlayGuard();
    expect(events).toEqual([true, false]);
  });
});
