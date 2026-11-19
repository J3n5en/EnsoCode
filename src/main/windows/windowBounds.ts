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

/** 恢复的窗口位置必须落在当前某块屏幕上（显示器拔掉后旧坐标会在屏幕外），否则回落主屏 */
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

  const area = workAreas.find((a) => isReachable(x, y, state.width, state.height, a));
  if (!area) {
    return {
      ...state,
      x: primary.x + FALLBACK_OFFSET,
      y: primary.y + FALLBACK_OFFSET,
      width: Math.min(state.width, primary.width - FALLBACK_OFFSET),
      height: Math.min(state.height, primary.height - FALLBACK_OFFSET),
    };
  }

  // 超出屏幕的那一维收窄到恰好铺满 workArea
  const fitsX = state.width <= area.width;
  const fitsY = state.height <= area.height;
  return {
    ...state,
    width: fitsX ? state.width : area.width,
    height: fitsY ? state.height : area.height,
    x: fitsX ? x : area.x,
    y: fitsY ? Math.max(y, area.y) : area.y,
  };
}
