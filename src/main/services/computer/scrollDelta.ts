/**
 * 单次滚动量上限（像素）。工具说明建议每步几百像素；更大的数在 Windows 会按 120 拆出海量滚轮事件，
 * 在 macOS 会超出 CGEvent 的 int32 滚动量。收敛后的值随结果回给模型，不是静默改写。
 */
const MAX_SCROLL_PIXELS = 10_000;

export function normalizeScrollDelta(raw: Record<string, unknown>): { dx: number; dy: number } {
  const num = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(MAX_SCROLL_PIXELS, Math.max(-MAX_SCROLL_PIXELS, n)) : 0;
  };
  return {
    dx: num(raw.dx ?? raw.deltaX ?? raw.delta_x),
    dy: num(raw.dy ?? raw.deltaY ?? raw.delta_y ?? raw.amount),
  };
}
