export type Box = { x: number; y: number; width: number; height: number };

export const intersects = (a: Box, b: Box): boolean =>
  a.width > 0 &&
  a.height > 0 &&
  b.width > 0 &&
  b.height > 0 &&
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

export const isCoveredBy = (host: Box, overlays: Box[]): boolean =>
  overlays.some((box) => intersects(host, box));

const OVERLAY_SLOTS = new Set([
  'dialog-popup',
  'dialog-viewport',
  'dialog-backdrop',
  'alert-dialog-popup',
  'alert-dialog-viewport',
  'alert-dialog-backdrop',
]);

/** Dialog / 菜单等浮层标记；#root 里外都算，避免 WebContentsView 盖住弹窗。 */
export function isOverlayNode(el: { getAttribute(name: string): string | null }): boolean {
  if (el.getAttribute('data-enso-float') !== null) return true;
  const slot = el.getAttribute('data-slot');
  if (!slot) return false;
  return OVERLAY_SLOTS.has(slot) || slot.endsWith('-popup') || slot.endsWith('-positioner');
}

/**
 * 浮层（菜单 / Select / Dialog / Toast）不一定 portal 出 #root；
 * 按标记收集可见盒子，让 guest 能沉到 workbench 下。
 */
export function overlayBoxes(doc: Document, _root?: Element | null): Box[] {
  const out: Box[] = [];
  for (const node of Array.from(doc.querySelectorAll<HTMLElement>('*'))) {
    if (!isOverlayNode(node)) continue;
    const r = node.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
    }
  }
  return out;
}
