import type { ScreenRect } from './guestViewOcclusion';

/**
 * 壁纸层挖孔：用 evenodd polygon 把原生 guest view 的矩形从壁纸上抠掉，
 * 其余区域（含侧栏 header/工具栏）继续铺壁纸。矩形为 viewport 坐标，
 * 壁纸层锚在窗口左上角，二者坐标系一致。
 *
 * polygon() 只有一条折线：外框闭合回 0 0 后再走到孔的起点画孔、回孔起点、
 * 再回 0 0——往返连线完全重叠，evenodd 下零面积，不会把图形切成蝴蝶结。
 * 带圆角的孔用折线逼近圆弧，原生视图切掉的圆角处仍由本层铺底。
 */
export function holesClipPath(holes: readonly ScreenRect[]): string | undefined {
  if (holes.length === 0) return undefined;
  const outer = '0 0, 100% 0, 100% 100%, 0 100%, 0 0';
  const inner = holes.map(
    (hole) =>
      `${holePoints(hole)
        .map(([px, py]) => `${round(px)}px ${round(py)}px`)
        .join(', ')}, 0 0`
  );
  return `polygon(evenodd, ${[outer, ...inner].join(', ')})`;
}

const ARC_STEPS = 6;
const round = (n: number) => Math.round(n * 100) / 100;

function holePoints({ x, y, width, height, radius = 0 }: ScreenRect): [number, number][] {
  const right = x + width;
  const bottom = y + height;
  const r = Math.min(radius, width / 2, height / 2);
  if (r <= 0) {
    return [
      [x, y],
      [right, y],
      [right, bottom],
      [x, bottom],
      [x, y],
    ];
  }
  const corners: [number, number, number][] = [
    [right - r, y + r, -90],
    [right - r, bottom - r, 0],
    [x + r, bottom - r, 90],
    [x + r, y + r, 180],
  ];
  const points = corners.flatMap(([cx, cy, start]) =>
    Array.from({ length: ARC_STEPS + 1 }, (_, i): [number, number] => {
      const angle = ((start + (90 * i) / ARC_STEPS) * Math.PI) / 180;
      return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
    })
  );
  return [...points, points[0]];
}
