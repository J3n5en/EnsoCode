export const UI_ELEMENT_LABEL_MAX = 80;
export const UI_ELEMENT_PATH_MAX = 300;
export const UI_ELEMENT_TEXT_MAX = 200;

export interface UiElementRefFields {
  label: string;
  path: string;
  text: string;
}

export interface UiElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UiElementPayload extends UiElementRefFields {
  tag?: string;
  id?: string;
  className?: string;
  rect?: UiElementRect;
  component?: string;
}

const HOSTILE = /["[\]\n]/g;

export function sanitizeUiElementField(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(HOSTILE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function formatUiElementRefLine(input: UiElementRefFields): string {
  const label = sanitizeUiElementField(input.label, UI_ELEMENT_LABEL_MAX);
  const path = sanitizeUiElementField(input.path, UI_ELEMENT_PATH_MAX);
  const text = sanitizeUiElementField(input.text, UI_ELEMENT_TEXT_MAX);
  return `[Selected UI element "${label}" — path: ${path}; text: ${text}]`;
}

const UI_ELEMENT_REF_LINE = /^\[Selected UI element "([^"]*)" — path: (.*); text: (.*)\]$/;

export function parseUiElementRefLine(line: string): UiElementRefFields | null {
  const match = UI_ELEMENT_REF_LINE.exec(line);
  if (!match) return null;
  return { label: match[1], path: match[2], text: match[3] };
}

function parseRect(value: unknown): UiElementRect | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rect = value as Record<string, unknown>;
  const x = rect.x;
  const y = rect.y;
  const width = rect.width;
  const height = rect.height;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return undefined;
  }
  return { x, y, width, height };
}

function optionalSanitized(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return sanitizeUiElementField(value, max);
}

export function sanitizeUiElementPayload(value: unknown): UiElementPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: UiElementPayload = {
    label: sanitizeUiElementField(raw.label, UI_ELEMENT_LABEL_MAX),
    path: sanitizeUiElementField(raw.path, UI_ELEMENT_PATH_MAX),
    text: sanitizeUiElementField(raw.text, UI_ELEMENT_TEXT_MAX),
  };
  const tag = optionalSanitized(raw.tag, 40);
  if (tag) out.tag = tag;
  const id = optionalSanitized(raw.id, 80);
  if (id) out.id = id;
  const className = optionalSanitized(raw.className, 120);
  if (className) out.className = className;
  const component = optionalSanitized(raw.component, UI_ELEMENT_LABEL_MAX);
  if (component) out.component = component;
  const rect = parseRect(raw.rect);
  if (rect) out.rect = rect;
  return out;
}

export function formatHoverTag(tag: unknown, className: unknown, max = 32): string {
  const rawTag = typeof tag === 'string' && tag.trim() ? tag.trim().toLowerCase() : 'div';
  const rawClass = typeof className === 'string' ? className : '';
  const parts = rawClass.split(/\s+/).filter((name) => /^[A-Za-z_][\w-]*$/.test(name));
  let out = rawTag;
  for (const name of parts) {
    const next = `${out}.${name}`;
    if (next.length <= max) {
      out = next;
      continue;
    }
    if (out.length <= max - 3) return `${out}...`;
    return `${out.slice(0, Math.max(1, max - 3))}...`;
  }
  return out.length > max ? `${out.slice(0, max - 3)}...` : out;
}

export const DESIGN_SCRIBBLE_HOLD_MS = 300;
export const DESIGN_SCRIBBLE_MOVE_PX = 5;
export const DESIGN_SCRIBBLE_POINTS_MAX = 2000;

export type ScribbleGesture = 'click' | 'annotate';

export function scribbleGesture(_heldMs: number, movePx: number): ScribbleGesture {
  if (Number.isFinite(movePx) && movePx > DESIGN_SCRIBBLE_MOVE_PX) return 'annotate';
  return 'click';
}

export interface ScribblePoint {
  x: number;
  y: number;
}

export interface ScribbleBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function scribbleBounds(points: readonly ScribblePoint[]): ScribbleBounds | null {
  if (points.length === 0) return null;
  let left = points[0].x;
  let right = points[0].x;
  let top = points[0].y;
  let bottom = points[0].y;
  for (const point of points) {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function boundsCenter(bounds: ScribbleBounds): ScribblePoint {
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
}

export const DESIGN_SCRIBBLE_CROP_PAD = 48;
export const DESIGN_SCRIBBLE_CROP_MIN = 120;

export function expandScribbleCrop(
  bounds: ScribbleBounds,
  viewport: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  let left = bounds.left - DESIGN_SCRIBBLE_CROP_PAD;
  let right = bounds.right + DESIGN_SCRIBBLE_CROP_PAD;
  let top = bounds.top - DESIGN_SCRIBBLE_CROP_PAD;
  let bottom = bounds.bottom + DESIGN_SCRIBBLE_CROP_PAD;
  const extraW = DESIGN_SCRIBBLE_CROP_MIN - (right - left);
  if (extraW > 0) {
    left -= extraW / 2;
    right += extraW / 2;
  }
  const extraH = DESIGN_SCRIBBLE_CROP_MIN - (bottom - top);
  if (extraH > 0) {
    top -= extraH / 2;
    bottom += extraH / 2;
  }
  const x = Math.max(0, Math.floor(left));
  const y = Math.max(0, Math.floor(top));
  const maxX = Math.min(viewport.width, Math.ceil(right));
  const maxY = Math.min(viewport.height, Math.ceil(bottom));
  return { x, y, width: Math.max(1, maxX - x), height: Math.max(1, maxY - y) };
}

export const DESIGN_SCRIBBLE_CROP_HANDLE_MIN = 48;

export type ScribbleCropHandle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

export function resizeScribbleCrop(
  box: { x: number; y: number; width: number; height: number },
  handle: ScribbleCropHandle,
  dx: number,
  dy: number,
  viewport: { width: number; height: number },
  min = DESIGN_SCRIBBLE_CROP_HANDLE_MIN
): { x: number; y: number; width: number; height: number } {
  let left = box.x;
  let top = box.y;
  let right = box.x + box.width;
  let bottom = box.y + box.height;
  if (handle === 'move') {
    left += dx;
    right += dx;
    top += dy;
    bottom += dy;
  } else {
    if (handle.includes('w')) left += dx;
    if (handle.includes('e')) right += dx;
    if (handle.includes('n')) top += dy;
    if (handle.includes('s')) bottom += dy;
  }
  if (right - left < min) {
    if (handle === 'move' || handle.includes('e')) right = left + min;
    else left = right - min;
  }
  if (bottom - top < min) {
    if (handle === 'move' || handle.includes('s')) bottom = top + min;
    else top = bottom - min;
  }
  if (left < 0) {
    right -= left;
    left = 0;
  }
  if (top < 0) {
    bottom -= top;
    top = 0;
  }
  if (right > viewport.width) {
    left -= right - viewport.width;
    right = viewport.width;
  }
  if (bottom > viewport.height) {
    top -= bottom - viewport.height;
    bottom = viewport.height;
  }
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(viewport.width, right);
  bottom = Math.min(viewport.height, bottom);
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top)),
  };
}

export function cssToImageRect(
  css: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  image: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const sx = viewport.width > 0 ? image.width / viewport.width : 1;
  const sy = viewport.height > 0 ? image.height / viewport.height : 1;
  const x = Math.max(0, Math.round(css.x * sx));
  const y = Math.max(0, Math.round(css.y * sy));
  return {
    x,
    y,
    width: Math.max(1, Math.round(css.width * sx)),
    height: Math.max(1, Math.round(css.height * sy)),
  };
}

function asPoint(value: unknown): ScribblePoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.x !== 'number' || typeof raw.y !== 'number') return null;
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null;
  return { x: raw.x, y: raw.y };
}

export function sanitizeScribblePoints(value: unknown): ScribblePoint[] {
  if (!Array.isArray(value)) return [];
  const out: ScribblePoint[] = [];
  for (const item of value) {
    if (out.length >= DESIGN_SCRIBBLE_POINTS_MAX) break;
    const point = asPoint(item);
    if (point) out.push(point);
  }
  return out.length < 2 ? [] : out;
}

export type DesignBindingMessage =
  | { type: 'cancelled' }
  | { type: 'freeze-request' }
  | { type: 'picked'; payload: unknown }
  | { type: 'annotated'; points: ScribblePoint[] };

export function parseDesignBinding(value: unknown): DesignBindingMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = (value as { type?: unknown }).type;
  if (type === 'cancelled' || type === 'freeze-request') return { type };
  if (type === 'picked') return { type, payload: (value as { payload?: unknown }).payload };
  if (type === 'annotated') {
    const points = sanitizeScribblePoints((value as { points?: unknown }).points);
    return points.length >= 2 ? { type, points } : null;
  }
  return null;
}

export function unbindImages<T extends { id?: string }>(
  images: readonly T[],
  imageIds: readonly string[]
): T[] {
  if (imageIds.length === 0) return [...images];
  const drop = new Set(imageIds);
  return images.filter((image) => !image.id || !drop.has(image.id));
}
