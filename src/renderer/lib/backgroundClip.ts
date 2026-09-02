import type { ScreenRect } from './guestViewOcclusion';

/**
 * 壁纸层挖孔：用 evenodd polygon 把原生 guest view 的矩形从壁纸上抠掉，
 * 其余区域（含侧栏 header/工具栏）继续铺壁纸。矩形为 viewport 坐标，
 * 壁纸层锚在窗口左上角，二者坐标系一致。
 *
 * polygon() 只有一条折线：外框闭合回 0 0 后再走到孔的起点画孔、回孔起点、
 * 再回 0 0——往返连线完全重叠，evenodd 下零面积，不会把图形切成蝴蝶结。
 */
export function holesClipPath(holes: readonly ScreenRect[]): string | undefined {
  if (holes.length === 0) return undefined;
  const outer = '0 0, 100% 0, 100% 100%, 0 100%, 0 0';
  const inner = holes.map(({ x, y, width, height }) => {
    const r = x + width;
    const b = y + height;
    return `${x}px ${y}px, ${r}px ${y}px, ${r}px ${b}px, ${x}px ${b}px, ${x}px ${y}px, 0 0`;
  });
  return `polygon(evenodd, ${[outer, ...inner].join(', ')})`;
}
