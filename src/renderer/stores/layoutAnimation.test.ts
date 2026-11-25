import { beforeEach, describe, expect, it } from 'vitest';
import { isLayoutAnimating, setLayoutAnimating, useLayoutAnimationStore } from './layoutAnimation';

describe('layoutAnimation store', () => {
  beforeEach(() => {
    setLayoutAnimating(false, 'sidebar');
    setLayoutAnimating(false, 'sidepanel');
    setLayoutAnimating(false);
    useLayoutAnimationStore.setState({ active: false });
  });

  it('keeps backwards-compatible default source behavior', () => {
    expect(isLayoutAnimating()).toBe(false);
    setLayoutAnimating(true);
    expect(isLayoutAnimating()).toBe(true);
    setLayoutAnimating(false);
    expect(isLayoutAnimating()).toBe(false);
  });

  it('tracks concurrent sidebar and sidepanel animations independently', () => {
    setLayoutAnimating(true, 'sidebar');
    setLayoutAnimating(true, 'sidepanel');
    expect(isLayoutAnimating()).toBe(true);

    // First panel finishing must not clear the flag while the second is still animating.
    setLayoutAnimating(false, 'sidebar');
    expect(isLayoutAnimating()).toBe(true);

    setLayoutAnimating(false, 'sidepanel');
    expect(isLayoutAnimating()).toBe(false);
  });

  it('treats repeated false calls as idempotent', () => {
    setLayoutAnimating(false, 'sidebar');
    setLayoutAnimating(false, 'sidebar');
    expect(isLayoutAnimating()).toBe(false);
  });
});
