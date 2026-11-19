export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

/** 标题栏至少露出这么宽、这么高，用户才能抓住拖动 */
const GRAB_WIDTH = 80;
const TITLE_BAR_HEIGHT = 44;
const FALLBACK_OFFSET = 60;

function isReachable(x: number, y: number, width: number, height: number, area: Rect): boolean {
  return (
    x + width > area.x + GRAB_WIDTH &&
    x < area.x + area.width - GRAB_WIDTH &&
    y + height > area.y + TITLE_BAR_HEIGHT &&
    y < area.y + area.height - TITLE_BAR_HEIGHT
  );
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 一维钳制：伸出 [lo, hi] 的部分收回，宽度不超过 hi - lo；某侧为无穷表示该侧伸到了别的屏上，不动 */
function clampAxis(start: number, size: number, lo: number, hi: number): [number, number] {
  const len = Math.min(size, hi - lo);
  return [Math.min(Math.max(start, lo), hi - len), len];
}

/**
 * 恢复的窗口位置必须落在当前某块屏幕上（显示器拔掉后旧坐标会在屏幕外），否则回落主屏。
 * 归属屏取重叠面积最大的那块（相同时取标题栏所在的屏）；只收回伸进无屏区域的边，
 * 伸到其他屏上的部分视为跨屏，保留位置和尺寸。
 */
export function fitWindowBounds<T extends WindowBounds>(
  state: T,
  workAreas: Rect[],
  primary: Rect
): T {
  const { x, y } = state;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === undefined || y === undefined) {
    return {
      ...state,
      x: undefined,
      y: undefined,
      width: Math.min(state.width, primary.width),
      height: Math.min(state.height, primary.height),
    };
  }

  const win: Rect = { x, y, width: state.width, height: state.height };
  const titleBar: Rect = {
    x,
    y,
    width: state.width,
    height: Math.min(TITLE_BAR_HEIGHT, state.height),
  };
  let area: Rect | undefined;
  let best = [0, 0];
  for (const a of workAreas) {
    if (!isReachable(x, y, state.width, state.height, a)) continue;
    const score = [overlapArea(win, a), overlapArea(titleBar, a)];
    if (!area || score[0] > best[0] || (score[0] === best[0] && score[1] > best[1])) {
      area = a;
      best = score;
    }
  }
  if (!area) {
    return {
      ...state,
      x: primary.x + FALLBACK_OFFSET,
      y: primary.y + FALLBACK_OFFSET,
      width: Math.min(state.width, primary.width - FALLBACK_OFFSET),
      height: Math.min(state.height, primary.height - FALLBACK_OFFSET),
    };
  }

  const home = area;
  const right = x + state.width;
  const bottom = y + state.height;
  const onOther = (strip: Rect) => workAreas.some((a) => a !== home && overlapArea(strip, a) > 0);
  const coveredLeft = x < home.x && onOther({ x, y, width: home.x - x, height: state.height });
  const coveredRight =
    right > home.x + home.width &&
    onOther({
      x: home.x + home.width,
      y,
      width: right - home.x - home.width,
      height: state.height,
    });
  const coveredTop = y < home.y && onOther({ x, y, width: state.width, height: home.y - y });
  const coveredBottom =
    bottom > home.y + home.height &&
    onOther({
      x,
      y: home.y + home.height,
      width: state.width,
      height: bottom - home.y - home.height,
    });

  const [nx, width] = clampAxis(
    x,
    state.width,
    coveredLeft ? -Infinity : home.x,
    coveredRight ? Infinity : home.x + home.width
  );
  const [ny, height] = clampAxis(
    y,
    state.height,
    coveredTop ? -Infinity : home.y,
    coveredBottom ? Infinity : home.y + home.height
  );
  return { ...state, x: nx, y: ny, width, height };
}
