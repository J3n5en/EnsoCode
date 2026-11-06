import { describe, expect, it } from 'vitest';
import { backgroundAppearance } from './backgroundAppearance';

describe('global wallpaper appearance', () => {
  it.each([0, 0.16, 1])('applies visibility %s globally, never again on panels', (visibility) => {
    const result = backgroundAppearance(visibility);
    expect(result.wallpaperOpacity).toBe(visibility);
    expect(result.panelAlpha).toBe(0);
    expect(result.popoverAlpha).toBeGreaterThanOrEqual(0.92);
  });
  it('clamps visibility to the supported range', () => {
    expect(backgroundAppearance(-1).wallpaperOpacity).toBe(0);
    expect(backgroundAppearance(2).wallpaperOpacity).toBe(1);
  });
});
