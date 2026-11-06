import { describe, expect, it } from 'vitest';
import { isZoomBannerVisible, readDismissedZoomPercent, zoomPercent } from './zoomBanner';

describe('zoom banner', () => {
  it('rounds the zoom factor to a whole percent', () => {
    expect(zoomPercent(1)).toBe(100);
    expect(zoomPercent(1.2)).toBe(120);
    expect(zoomPercent(0.8)).toBe(80);
    expect(zoomPercent(1.25)).toBe(125);
  });

  it('shows only while zoom is not 100% and not the percent the user dismissed', () => {
    expect(isZoomBannerVisible(100, null)).toBe(false);
    expect(isZoomBannerVisible(100, 125)).toBe(false);
    expect(isZoomBannerVisible(125, null)).toBe(true);
    expect(isZoomBannerVisible(125, 150)).toBe(true);
    expect(isZoomBannerVisible(125, 125)).toBe(false);
    expect(isZoomBannerVisible(110, 125)).toBe(true);
  });

  it('treats a missing or unreadable dismissed value as not dismissed', () => {
    expect(readDismissedZoomPercent(null)).toBeNull();
    expect(readDismissedZoomPercent('')).toBeNull();
    expect(readDismissedZoomPercent('nope')).toBeNull();
    expect(readDismissedZoomPercent('125')).toBe(125);
  });
});
