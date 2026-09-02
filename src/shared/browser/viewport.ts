export interface BrowserViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAX_DIMENSION = 16384;
const KEYS = ['x', 'y', 'width', 'height'] as const;

/** 渲染层报的面板矩形（CSS px / DIP）；脏值整体拒绝。 */
export function parseBrowserViewport(raw: unknown): BrowserViewport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!Object.keys(record).every((key) => (KEYS as readonly string[]).includes(key))) return null;
  const out = {} as BrowserViewport;
  for (const key of KEYS) {
    const value = record[key];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > MAX_DIMENSION
    ) {
      return null;
    }
    out[key] = Math.round(value);
  }
  if (out.width <= 0 || out.height <= 0) return null;
  return out;
}
