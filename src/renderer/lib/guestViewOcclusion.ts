export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const area = (r: ScreenRect) => Math.max(0, r.width) * Math.max(0, r.height);

export function rectsOverlap(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function cropAway(guest: ScreenRect, float: ScreenRect): ScreenRect | null {
  const options: ScreenRect[] = [
    {
      x: guest.x,
      y: float.y + float.height,
      width: guest.width,
      height: guest.y + guest.height - (float.y + float.height),
    },
    { x: guest.x, y: guest.y, width: guest.width, height: float.y - guest.y },
    {
      x: float.x + float.width,
      y: guest.y,
      width: guest.x + guest.width - (float.x + float.width),
      height: guest.height,
    },
    { x: guest.x, y: guest.y, width: float.x - guest.x, height: guest.height },
  ];
  let best: ScreenRect | null = null;
  let bestArea = 0;
  for (const option of options) {
    if (option.width < 1 || option.height < 1) continue;
    const clipped = {
      x: Math.max(option.x, guest.x),
      y: Math.max(option.y, guest.y),
      width: 0,
      height: 0,
    };
    const right = Math.min(option.x + option.width, guest.x + guest.width);
    const bottom = Math.min(option.y + option.height, guest.y + guest.height);
    clipped.width = right - clipped.x;
    clipped.height = bottom - clipped.y;
    const size = area(clipped);
    if (size > bestArea) {
      best = clipped;
      bestArea = size;
    }
  }
  return best;
}

/**
 * 弹出层盖不住 WebContentsView。不能整页 setVisible(false)（白屏）。
 * 忽略全屏 backdrop，只按实际 popup 矩形从 guest 上裁掉一条，页面其余继续画。
 */
export function clipGuestRect(
  guest: ScreenRect,
  floats: readonly ScreenRect[],
  windowSize?: { width: number; height: number }
): ScreenRect | null {
  const windowArea = windowSize ? windowSize.width * windowSize.height : Number.POSITIVE_INFINITY;
  let current: ScreenRect | null = guest;
  for (const float of floats) {
    if (!current || float.width < 1 || float.height < 1) continue;
    if (windowArea < Number.POSITIVE_INFINITY && area(float) >= windowArea * 0.45) continue;
    if (!rectsOverlap(current, float)) continue;
    current = cropAway(current, float);
  }
  return current && current.width >= 1 && current.height >= 1 ? current : null;
}

const FLOAT_SELECTOR = '[data-enso-float], [data-slot$="-popup"], [data-slot$="-positioner"]';

export function collectFloatingRects(
  root: ParentNode = document,
  windowSize = { width: window.innerWidth, height: window.innerHeight }
): ScreenRect[] {
  const out: ScreenRect[] = [];
  const windowArea = windowSize.width * windowSize.height;
  for (const node of root.querySelectorAll(FLOAT_SELECTOR)) {
    if (!(node instanceof HTMLElement)) continue;
    const box = node.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    if (box.width * box.height >= windowArea * 0.45) continue;
    out.push({ x: box.left, y: box.top, width: box.width, height: box.height });
  }
  return out;
}
