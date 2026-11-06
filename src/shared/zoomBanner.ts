export const ZOOM_BANNER_DISMISSED_KEY = 'enso.zoomBanner.dismissedPercent';

export function zoomPercent(factor: number): number {
  return Math.round(factor * 100);
}

export function isZoomBannerVisible(percent: number, dismissedPercent: number | null): boolean {
  return percent !== 100 && percent !== dismissedPercent;
}

export function readDismissedZoomPercent(raw: string | null): number | null {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return value;
}
