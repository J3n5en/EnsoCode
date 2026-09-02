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

/**
 * 浮层（菜单 / Select / Dialog / Toast）全部 portal 到 body；
 * 收集 #root 之外所有 body 直接子元素的可见盒子。
 */
export function overlayBoxes(doc: Document, root: Element | null): Box[] {
  const out: Box[] = [];
  for (const child of Array.from(doc.body.children)) {
    if (child === root || !(child instanceof HTMLElement)) continue;
    for (const el of [child, ...Array.from(child.querySelectorAll<HTMLElement>('*'))]) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
        break;
      }
    }
  }
  return out;
}
