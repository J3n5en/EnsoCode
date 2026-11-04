export interface BrowserViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 面板是圆角卡片且网页贴着卡片底边时的圆角，原生视图否则会露出直角 */
  radius?: number;
}

const MAX_DIMENSION = 16384;
const MAX_RADIUS = 64;
const KEYS = ['x', 'y', 'width', 'height'] as const;

const inRange = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;

/** 渲染层报的面板矩形（CSS px / DIP）；脏值整体拒绝。 */
export function parseBrowserViewport(raw: unknown): BrowserViewport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const allowed: readonly string[] = [...KEYS, 'radius'];
  if (!Object.keys(record).every((key) => allowed.includes(key))) return null;
  const out = {} as BrowserViewport;
  for (const key of KEYS) {
    const value = record[key];
    if (!inRange(value, MAX_DIMENSION)) return null;
    out[key] = Math.round(value);
  }
  if (out.width <= 0 || out.height <= 0) return null;
  if (record.radius !== undefined) {
    if (!inRange(record.radius, MAX_RADIUS)) return null;
    out.radius = Math.round(record.radius);
  }
  return out;
}
