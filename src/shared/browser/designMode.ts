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

export function unbindImages<T extends { id?: string }>(
  images: readonly T[],
  imageIds: readonly string[]
): T[] {
  if (imageIds.length === 0) return [...images];
  const drop = new Set(imageIds);
  return images.filter((image) => !image.id || !drop.has(image.id));
}
