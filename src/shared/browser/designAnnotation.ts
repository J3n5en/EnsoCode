import { formatUiElementRefLine } from './designMode';

export interface DesignModeHue {
  name: 'blue' | 'purple' | 'green' | 'orange' | 'cyan' | 'magenta' | 'red' | 'yellow';
  rgb: readonly [number, number, number];
  cssVar: string;
}

export const DESIGN_MODE_HUES: readonly DesignModeHue[] = [
  { name: 'blue', rgb: [58, 150, 221], cssVar: '--cursor-blue' },
  { name: 'purple', rgb: [155, 89, 182], cssVar: '--cursor-purple' },
  { name: 'green', rgb: [39, 174, 96], cssVar: '--cursor-green' },
  { name: 'orange', rgb: [242, 153, 74], cssVar: '--cursor-orange' },
  { name: 'cyan', rgb: [0, 184, 169], cssVar: '--cursor-cyan' },
  { name: 'magenta', rgb: [219, 68, 134], cssVar: '--cursor-magenta' },
  { name: 'red', rgb: [235, 87, 87], cssVar: '--cursor-red' },
  { name: 'yellow', rgb: [170, 175, 18], cssVar: '--cursor-yellow' },
];

export const ANNOTATION_HUES = DESIGN_MODE_HUES.map((hue) => hue.name);

function rgba(rgb: readonly [number, number, number], alpha: number): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

export const ANNOTATION_CANVAS_PALETTE = DESIGN_MODE_HUES.map(({ rgb }) => ({
  fill: rgba(rgb, 0.04),
  stroke: rgba(rgb, 0.5),
  scribbleStroke: rgba(rgb, 0.92),
}));

export const PICKER_HUE_COLORS = DESIGN_MODE_HUES.map(({ rgb }) => ({
  border: rgba(rgb, 1),
  bg: rgba(rgb, 0.1),
  hoverBorder: rgba(rgb, 0.3),
  hoverBg: rgba(rgb, 0.02),
}));

export interface DesignTopLeftRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface DesignXyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignPoint {
  x: number;
  y: number;
  pressure?: number;
}

export interface BrowserElementAttribute {
  name: string;
  value: string;
}

export interface BrowserElementStyles {
  color: string;
  backgroundColor: string;
  fontSize: string;
  fontFamily: string;
  display: string;
  position: string;
}

export type BrowserComponentFramework = 'react' | 'vue' | 'svelte';

export interface BrowserElementSnapshot {
  tagName: string;
  id: string;
  uniqueId: string;
  className: string;
  innerText: string;
  path: string;
  attributes: BrowserElementAttribute[];
  rect: DesignTopLeftRect;
  styles: BrowserElementStyles;
  component?: string;
  componentStack?: string[];
  framework?: BrowserComponentFramework;
  componentPropsJson?: string;
  hueIndex?: number;
}

export interface BrowserPickedElementRef {
  tag: string;
  component: string;
  rect: DesignXyRect;
  uid: string;
  hueIndex: number;
}

const FRAMEWORKS: readonly BrowserComponentFramework[] = ['react', 'vue', 'svelte'];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTopLeftRect(value: unknown): DesignTopLeftRect | null {
  if (!isObject(value)) return null;
  const { top, left, width, height } = value;
  if (
    !isFiniteNumber(top) ||
    !isFiniteNumber(left) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height) ||
    width < 0 ||
    height < 0
  ) {
    return null;
  }
  return { top, left, width, height };
}

export function isValidElementSnapshot(value: unknown): value is BrowserElementSnapshot {
  if (!isObject(value)) return false;
  const boundedStr = (v: unknown, max: number): v is string =>
    typeof v === 'string' && v.length <= max;
  const styles = value.styles;
  if (!isObject(styles)) return false;
  const attributes = value.attributes;
  if (
    !Array.isArray(attributes) ||
    attributes.length > 100 ||
    !attributes.every(
      (attr) => isObject(attr) && boundedStr(attr.name, 512) && boundedStr(attr.value, 1e4)
    )
  ) {
    return false;
  }
  const stack = value.componentStack;
  if (
    stack !== undefined &&
    (!Array.isArray(stack) || stack.length > 64 || !stack.every((item) => boundedStr(item, 1e3)))
  ) {
    return false;
  }
  return (
    boundedStr(value.tagName, 128) &&
    boundedStr(value.id, 1e4) &&
    boundedStr(value.uniqueId, 1e3) &&
    boundedStr(value.className, 2e4) &&
    boundedStr(value.innerText, 1e5) &&
    boundedStr(value.path, 2e4) &&
    parseTopLeftRect(value.rect) !== null &&
    boundedStr(styles.color, 1e3) &&
    boundedStr(styles.backgroundColor, 1e3) &&
    boundedStr(styles.fontSize, 1e3) &&
    boundedStr(styles.fontFamily, 2e3) &&
    boundedStr(styles.display, 1e3) &&
    boundedStr(styles.position, 1e3) &&
    (value.component === undefined || boundedStr(value.component, 1e3)) &&
    (value.framework === undefined ||
      value.framework === 'react' ||
      value.framework === 'vue' ||
      value.framework === 'svelte') &&
    (value.componentPropsJson === undefined || boundedStr(value.componentPropsJson, 1e5)) &&
    (value.hueIndex === undefined || isFiniteNumber(value.hueIndex))
  );
}

export function parseBrowserElementSnapshot(value: unknown): BrowserElementSnapshot | null {
  if (!isValidElementSnapshot(value)) return null;
  const rect = parseTopLeftRect(value.rect);
  if (!rect) return null;
  const framework = FRAMEWORKS.find((f) => f === value.framework);
  return {
    tagName: value.tagName,
    id: value.id,
    uniqueId: value.uniqueId,
    className: value.className,
    innerText: value.innerText,
    path: value.path,
    attributes: value.attributes.map((a) => ({ name: a.name, value: a.value })),
    rect,
    styles: {
      color: value.styles.color,
      backgroundColor: value.styles.backgroundColor,
      fontSize: value.styles.fontSize,
      fontFamily: value.styles.fontFamily,
      display: value.styles.display,
      position: value.styles.position,
    },
    ...(typeof value.component === 'string' ? { component: value.component } : {}),
    ...(Array.isArray(value.componentStack)
      ? { componentStack: value.componentStack.filter((s): s is string => typeof s === 'string') }
      : {}),
    ...(framework ? { framework } : {}),
    ...(typeof value.componentPropsJson === 'string'
      ? { componentPropsJson: value.componentPropsJson }
      : {}),
    ...(typeof value.hueIndex === 'number' ? { hueIndex: value.hueIndex } : {}),
  };
}

export function elementLabelOf(element: {
  component?: string;
  tagName?: string;
  tag?: string;
}): string {
  if (element.component && element.component.trim().length > 0) {
    return element.component.trim();
  }
  return (element.tagName ?? element.tag ?? 'div').toLowerCase();
}

export function elementIdentityLabelOf(element: BrowserElementSnapshot): string {
  const tag = element.tagName.toLowerCase();
  if (element.component) return `${element.component} · ${tag}`;
  if (element.id) return `${tag}#${element.id}`;
  const firstClass = element.className.trim().split(/\s+/)[0];
  return firstClass ? `${tag}.${firstClass}` : tag;
}

export function elementSummaryLabelOf(
  element: BrowserElementSnapshot,
  options?: { maxTextLen?: number; maxTotalLen?: number }
): string {
  const maxTextLen = options?.maxTextLen ?? 30;
  const maxTotalLen = options?.maxTotalLen ?? 0;
  let out = elementIdentityLabelOf(element);
  const text = (element.innerText || '').replace(/\s+/g, ' ').trim();
  if (text.length > 0 && text.length <= maxTextLen) {
    out += ` "${text}"`;
  } else if (text.length > maxTextLen) {
    out += ` "${text.slice(0, maxTextLen - 3)}..."`;
  }
  if (maxTotalLen > 0 && out.length > maxTotalLen) {
    out = `${out.slice(0, maxTotalLen - 3)}...`;
  }
  return out;
}

const VISIBLE_TEXT_MAX = 400;
const ATTR_VALUE_MAX = 120;
const ATTR_COUNT_MAX = 18;
const ELEMENT_BLOCK_MAX = 48_000;
const BROWSER_ELEMENT_FENCE = 'browser_element';
const BROWSER_ELEMENT_HEADER = 'The user selected this node in the browser preview.';
const BROWSER_REGION_HEADER = 'The user selected this region in the browser preview.';

export interface BrowserAnnotationBlockContext {
  browserId?: string;
  pageUrl?: string;
}

function truncateWithEllipsis(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function appendBrowserContextLines(lines: string[], context?: BrowserAnnotationBlockContext): void {
  const tabId = context?.browserId?.trim();
  const pageUrl = context?.pageUrl?.trim();
  if (tabId) {
    lines.push(`browser_tab_id: ${tabId}`);
  }
  if (pageUrl) {
    lines.push(`page_url: ${pageUrl}`);
  }
  if (tabId) {
    lines.push(
      `inspect_hint: Built-in browser tab "${tabId}". Re-inspect or verify in the built-in browser via browser_tabs(action="select", tabId="${tabId}") then browser_snapshot or browser_screenshot.`
    );
  }
}

export function formatBrowserElementBlock(
  element: BrowserElementSnapshot,
  context?: BrowserAnnotationBlockContext
): string {
  const lines: string[] = [BROWSER_ELEMENT_HEADER, ''];
  appendBrowserContextLines(lines, context);
  lines.push(`tag: ${element.tagName.toLowerCase()}`, `dom_path: ${element.path}`);
  if (element.id) lines.push(`id: ${element.id}`);
  const cls = element.className.trim();
  if (cls.length > 0) lines.push(`class: ${cls}`);
  const visibleText = (element.innerText || '').replace(/\s+/g, ' ').trim();
  if (visibleText.length > 0) {
    lines.push(`visible_text: ${truncateWithEllipsis(visibleText, VISIBLE_TEXT_MAX)}`);
  }
  const { top, left, width, height } = element.rect;
  lines.push(
    `bounds_css_px: top=${Math.round(top)} left=${Math.round(left)} width=${Math.round(width)} height=${Math.round(height)}`
  );
  if (element.framework !== undefined) lines.push(`framework: ${element.framework}`);
  if (element.component !== undefined && element.component !== '') {
    lines.push(`component: ${element.component}`);
  }
  if (element.componentStack !== undefined && element.componentStack.length > 0) {
    lines.push(`component_stack: ${element.componentStack.join(' > ')}`);
  }
  const attrs = element.attributes.filter(
    (attr) =>
      attr.name.length > 0 &&
      !attr.name.startsWith('data-cursor-') &&
      !attr.name.startsWith('data-enso-')
  );
  if (attrs.length > 0) {
    lines.push('attributes:');
    for (const attr of attrs.slice(0, ATTR_COUNT_MAX)) {
      lines.push(`  ${attr.name}=${truncateWithEllipsis(attr.value, ATTR_VALUE_MAX)}`);
    }
    if (attrs.length > ATTR_COUNT_MAX) {
      lines.push(`  ... and ${attrs.length - ATTR_COUNT_MAX} more`);
    }
  }
  let body = lines.join('\n');
  if (body.length > ELEMENT_BLOCK_MAX) {
    body = `${body.slice(0, 47_960)}\n... ${BROWSER_ELEMENT_FENCE} body truncated ...`;
  }
  return `\n\`\`\`${BROWSER_ELEMENT_FENCE}\n${body}\n\`\`\`\n`;
}

export function formatBrowserRegionBlock(
  region: Extract<DesignAnnotation, { kind: 'region' }>['region'],
  context?: BrowserAnnotationBlockContext
): string {
  const lines: string[] = [BROWSER_REGION_HEADER, ''];
  appendBrowserContextLines(lines, context);
  const { top, left, width, height } = region.rect;
  lines.push(
    `region_bounds_css_px: top=${Math.round(top)} left=${Math.round(left)} width=${Math.round(width)} height=${Math.round(height)}`
  );
  const anchor = region.anchor;
  if (anchor?.tagName) {
    lines.push(`anchor_tag: ${anchor.tagName.toLowerCase()}`);
    if (anchor.path) lines.push(`anchor_dom_path: ${anchor.path}`);
    if (anchor.id) lines.push(`anchor_id: ${anchor.id}`);
    const cls = anchor.className?.trim();
    if (cls) lines.push(`anchor_class: ${cls}`);
    const visibleText = (anchor.innerText || '').replace(/\s+/g, ' ').trim();
    if (visibleText.length > 0) {
      lines.push(`anchor_visible_text: ${truncateWithEllipsis(visibleText, VISIBLE_TEXT_MAX)}`);
    }
  }
  let body = lines.join('\n');
  if (body.length > ELEMENT_BLOCK_MAX) {
    body = `${body.slice(0, 47_960)}\n... ${BROWSER_ELEMENT_FENCE} body truncated ...`;
  }
  return `\n\`\`\`${BROWSER_ELEMENT_FENCE}\n${body}\n\`\`\`\n`;
}

export const ELEMENT_CROP_PAD = 48;
export const ELEMENT_CROP_MIN = 120;

export function elementCropBounds(
  elements: readonly { rect: DesignTopLeftRect }[],
  cssToView: number,
  view: { width: number; height: number }
): DesignXyRect {
  if (elements.length === 0) {
    return { x: 0, y: 0, width: Math.max(1, view.width), height: Math.max(1, view.height) };
  }
  const lefts = elements.map((el) => el.rect.left * cssToView);
  const tops = elements.map((el) => el.rect.top * cssToView);
  const rights = elements.map((el) => (el.rect.left + el.rect.width) * cssToView);
  const bottoms = elements.map((el) => (el.rect.top + el.rect.height) * cssToView);
  let left = Math.min(...lefts) - ELEMENT_CROP_PAD;
  let right = Math.max(...rights) + ELEMENT_CROP_PAD;
  let top = Math.min(...tops) - ELEMENT_CROP_PAD;
  let bottom = Math.max(...bottoms) + ELEMENT_CROP_PAD;
  if (right - left < ELEMENT_CROP_MIN) {
    const mid = (left + right) / 2;
    left = mid - ELEMENT_CROP_MIN / 2;
    right = mid + ELEMENT_CROP_MIN / 2;
  }
  if (bottom - top < ELEMENT_CROP_MIN) {
    const mid = (top + bottom) / 2;
    top = mid - ELEMENT_CROP_MIN / 2;
    bottom = mid + ELEMENT_CROP_MIN / 2;
  }
  const x = Math.max(0, Math.floor(left));
  const y = Math.max(0, Math.floor(top));
  const maxX = Math.min(view.width, Math.ceil(right));
  const maxY = Math.min(view.height, Math.ceil(bottom));
  return {
    x,
    y,
    width: Math.max(1, maxX - x),
    height: Math.max(1, maxY - y),
  };
}

const HASH_ROUTE_RE = /^#!?\//;

export function designModePageKey(url: string): string {
  try {
    const parsed = new URL(url);
    if (!HASH_ROUTE_RE.test(parsed.hash)) {
      parsed.hash = '';
    } else {
      const secondHash = parsed.hash.indexOf('#', 1);
      if (secondHash !== -1) parsed.hash = parsed.hash.slice(0, secondHash);
    }
    return parsed.href;
  } catch {
    return url;
  }
}

export type RegionMarkupTool = 'pen' | 'ellipse' | 'rect' | 'arrow';

export type RegionMarkupShape =
  | { kind: 'pen'; points: { x: number; y: number }[] }
  | {
      kind: 'ellipse' | 'rect' | 'arrow';
      from: { x: number; y: number };
      to: { x: number; y: number };
    };

export const REGION_MARKUP_TOOLS: readonly {
  tool: RegionMarkupTool;
  label: string;
  icon: 'pencil' | 'circle' | 'square' | 'arrow-right-up';
}[] = [
  { tool: 'pen', label: 'Draw', icon: 'pencil' },
  { tool: 'ellipse', label: 'Ellipse', icon: 'circle' },
  { tool: 'rect', label: 'Rectangle', icon: 'square' },
  { tool: 'arrow', label: 'Arrow', icon: 'arrow-right-up' },
];

export interface DesignAnnotationImage {
  id: string;
  data: string;
  mimeType: string;
  name?: string;
  width?: number;
  height?: number;
}

export interface DesignRegionPayload {
  rect: DesignTopLeftRect;
  anchor: BrowserElementSnapshot;
  markup: RegionMarkupShape[];
}

export type DesignAnnotation =
  | {
      id: string;
      kind: 'element';
      number: number;
      comment: string;
      browserId: string;
      pageKey: string;
      images: DesignAnnotationImage[];
      elements: BrowserElementSnapshot[];
    }
  | {
      id: string;
      kind: 'region';
      number: number;
      comment: string;
      browserId: string;
      pageKey: string;
      images: DesignAnnotationImage[];
      region: DesignRegionPayload;
    }
  | {
      id: string;
      kind: 'text-edit';
      number: number;
      comment: string;
      browserId: string;
      pageKey: string;
      images: DesignAnnotationImage[];
      element: BrowserElementSnapshot;
    };

export type DesignAnnotationDraft =
  | Omit<Extract<DesignAnnotation, { kind: 'element' }>, 'number'>
  | Omit<Extract<DesignAnnotation, { kind: 'region' }>, 'number'>
  | Omit<Extract<DesignAnnotation, { kind: 'text-edit' }>, 'number'>;

export interface BrowserAnnotationPinElement {
  uid: string;
  tagName: string;
  id: string;
  className: string;
  innerText: string;
}

export interface BrowserAnnotationPinSpec {
  id: string;
  number: number;
  comment: string;
  label: string;
  elements: BrowserAnnotationPinElement[];
  region: DesignTopLeftRect | null;
}

export function annotationElementsOf(annotation: DesignAnnotation): BrowserElementSnapshot[] {
  switch (annotation.kind) {
    case 'element':
      return annotation.elements;
    case 'region':
      return [annotation.region.anchor];
    case 'text-edit':
      return [annotation.element];
  }
}

export function relativeRegionRect(region: DesignRegionPayload): DesignTopLeftRect {
  return {
    left: region.rect.left - region.anchor.rect.left,
    top: region.rect.top - region.anchor.rect.top,
    width: region.rect.width,
    height: region.rect.height,
  };
}

export function annotationPinSpecOf(annotation: DesignAnnotation): BrowserAnnotationPinSpec {
  const elements = annotationElementsOf(annotation);
  const first = elements[0];
  const label = first
    ? elements.length > 1
      ? `${elementSummaryLabelOf(first)} +${elements.length - 1}`
      : elementSummaryLabelOf(first)
    : annotation.kind === 'region'
      ? `Region ${Math.round(annotation.region.rect.width)} × ${Math.round(annotation.region.rect.height)}`
      : 'Element';
  return {
    id: annotation.id,
    number: annotation.number,
    comment: annotation.comment,
    label,
    elements: elements.map((el) => ({
      uid: el.uniqueId,
      tagName: el.tagName,
      id: el.id,
      className: el.className,
      innerText: el.innerText.slice(0, 200),
    })),
    region: annotation.kind === 'region' ? relativeRegionRect(annotation.region) : null,
  };
}

export function designAnnotationPinsFor(
  currentUrl: string,
  posted: { pageKey: string; pins: readonly BrowserAnnotationPinSpec[] }
): BrowserAnnotationPinSpec[] {
  return designModePageKey(currentUrl) === posted.pageKey ? [...posted.pins] : [];
}

export interface DesignAnnotationQueueState {
  items: DesignAnnotation[];
}

export type DesignAnnotationQueueAction =
  | { type: 'add'; draft: DesignAnnotationDraft }
  | { type: 'update'; id: string; comment: string; images?: DesignAnnotationImage[] }
  | { type: 'remove'; ids: Iterable<string> }
  | { type: 'clear' }
  | { type: 'restore'; items: readonly DesignAnnotation[] }
  | { type: 'append'; items: readonly DesignAnnotation[] };

const EMPTY_QUEUE: DesignAnnotationQueueState = { items: [] };

export function createAnnotationQueueReducer(
  pageKeyOf: (item: { browserId: string; pageKey: string }) => string | undefined = (item) =>
    item.pageKey
) {
  const sameScope = (
    a: { browserId: string; pageKey: string },
    b: { browserId: string; pageKey: string }
  ): boolean => {
    if (a.browserId !== b.browserId) return false;
    const ka = pageKeyOf(a);
    const kb = pageKeyOf(b);
    return ka === undefined || kb === undefined || ka === kb;
  };
  const nextNumber = (
    items: readonly DesignAnnotation[],
    target: { browserId: string; pageKey: string }
  ): number =>
    Math.max(0, ...items.filter((item) => sameScope(item, target)).map((item) => item.number)) + 1;

  return (
    state: DesignAnnotationQueueState = EMPTY_QUEUE,
    action: DesignAnnotationQueueAction
  ): DesignAnnotationQueueState => {
    switch (action.type) {
      case 'add': {
        const num = nextNumber(state.items, action.draft);
        return {
          items: [...state.items, { ...action.draft, number: num } as DesignAnnotation],
        };
      }
      case 'update':
        return {
          items: state.items.map((item) =>
            item.id === action.id
              ? {
                  ...item,
                  comment: action.comment,
                  ...(action.images !== undefined ? { images: action.images } : {}),
                }
              : item
          ),
        };
      case 'remove': {
        const drop = new Set(action.ids);
        const next = state.items.filter((item) => !drop.has(item.id));
        if (next.length === state.items.length) return state;
        return next.length === 0 ? EMPTY_QUEUE : { items: next };
      }
      case 'clear':
        return EMPTY_QUEUE;
      case 'restore': {
        const existingIds = new Set(state.items.map((item) => item.id));
        const restored = action.items.filter((item) => !existingIds.has(item.id));
        if (restored.length === 0) return state;
        const out = [...restored];
        const touched = [...restored];
        for (const item of state.items) {
          if (touched.some((r) => sameScope(r, item))) {
            const renumbered = { ...item, number: nextNumber(out, item) };
            out.push(renumbered);
            touched.push(renumbered);
          } else {
            out.push(item);
          }
        }
        return { items: out };
      }
      case 'append': {
        const existingIds = new Set(state.items.map((item) => item.id));
        const out = [...state.items];
        for (const item of action.items) {
          if (!existingIds.has(item.id)) {
            out.push({ ...item, number: nextNumber(out, item) });
          }
        }
        return out.length === state.items.length ? state : { items: out };
      }
    }
  };
}

const PERSISTENCE_VERSION = 1;

function parseMarkupPoint(value: unknown): { x: number; y: number } | null {
  if (!isObject(value)) return null;
  const { x, y } = value;
  return isFiniteNumber(x) && isFiniteNumber(y) ? { x, y } : null;
}

export function parseRegionMarkupShape(value: unknown): RegionMarkupShape | null {
  if (!isObject(value)) return null;
  const kind = value.kind;
  if (kind === 'pen') {
    if (!Array.isArray(value.points)) return null;
    const points = value.points.map(parseMarkupPoint);
    return points.every((p): p is { x: number; y: number } => p !== null)
      ? { kind: 'pen', points }
      : null;
  }
  if (kind !== 'ellipse' && kind !== 'rect' && kind !== 'arrow') return null;
  const from = parseMarkupPoint(value.from);
  const to = parseMarkupPoint(value.to);
  if (!from || !to) return null;
  return { kind, from, to };
}

function parsePersistedAnnotation(value: unknown): DesignAnnotation | null {
  if (!isObject(value)) return null;
  const { id, kind, number, comment, browserId, pageKey } = value;
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof number !== 'number' ||
    !Number.isFinite(number) ||
    typeof comment !== 'string' ||
    typeof browserId !== 'string' ||
    typeof pageKey !== 'string'
  ) {
    return null;
  }
  const base = {
    id,
    number,
    comment,
    browserId,
    pageKey,
    images: [] as DesignAnnotationImage[],
  };
  if (kind === 'element') {
    if (!Array.isArray(value.elements) || !value.elements.every(isValidElementSnapshot)) {
      return null;
    }
    return { ...base, kind: 'element', elements: value.elements };
  }
  if (kind === 'region') {
    const region = value.region;
    if (!isObject(region) || !isValidElementSnapshot(region.anchor)) return null;
    const rect = parseTopLeftRect(region.rect);
    if (!rect || !Array.isArray(region.markup)) return null;
    const markup = region.markup.map(parseRegionMarkupShape);
    if (!markup.every((m): m is RegionMarkupShape => m !== null)) return null;
    return {
      ...base,
      kind: 'region',
      region: { rect, anchor: region.anchor, markup },
    };
  }
  return null;
}

export function serializePersistedAnnotations(input: {
  queues: ReadonlyMap<string, DesignAnnotationQueueState>;
  pages: ReadonlyMap<string, string>;
}): string {
  const queues = [...input.queues].slice(-20).map(([agent, queue]) => ({
    agent,
    items: queue.items.map(({ images: _images, ...rest }) => rest),
  }));
  const pages = [...input.pages].slice(-50).map(([browserId, pageKey]) => ({
    browserId,
    pageKey,
  }));
  return JSON.stringify({ v: PERSISTENCE_VERSION, queues, pages });
}

export function parsePersistedAnnotations(raw: string | null): {
  queues: Map<string, DesignAnnotationQueueState>;
  pages: Map<string, string>;
} {
  const empty = {
    queues: new Map<string, DesignAnnotationQueueState>(),
    pages: new Map<string, string>(),
  };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (!isObject(parsed) || parsed.v !== PERSISTENCE_VERSION) return empty;
    const queues = new Map<string, DesignAnnotationQueueState>();
    if (Array.isArray(parsed.queues)) {
      for (const entry of parsed.queues) {
        if (!isObject(entry) || typeof entry.agent !== 'string' || !Array.isArray(entry.items)) {
          continue;
        }
        const items = entry.items.flatMap((item) => {
          const valid = parsePersistedAnnotation(item);
          return valid ? [valid] : [];
        });
        if (items.length > 0) queues.set(entry.agent, { items });
      }
    }
    const pages = new Map<string, string>();
    if (Array.isArray(parsed.pages)) {
      for (const entry of parsed.pages) {
        if (
          isObject(entry) &&
          typeof entry.browserId === 'string' &&
          typeof entry.pageKey === 'string'
        ) {
          pages.set(entry.browserId, entry.pageKey);
        }
      }
    }
    return { queues, pages };
  } catch {
    return empty;
  }
}

// --- Marquee State Machine (Cursor electron-main/browser/browser-page/marquee.ts) ---

export const MARQUEE_DRAG_THRESHOLD = 5;
export const MARQUEE_AXIS_LOCK_THRESHOLD = 3;
export const MIN_REGION_PX = 12;

export interface MarqueeKeys {
  alt: boolean;
  shiftDown: boolean;
  shiftArmed: boolean;
  space: boolean;
}

export interface MarqueeShiftLock {
  pointer: { x: number; y: number };
  frozen: DesignXyRect;
  axis: 'x' | 'y' | null;
}

export type MarqueeState =
  | {
      kind: 'pressed';
      origin: { x: number; y: number };
      pointer: { x: number; y: number };
      keys: MarqueeKeys;
    }
  | {
      kind: 'dragging';
      origin: { x: number; y: number };
      pointer: { x: number; y: number };
      keys: MarqueeKeys;
      originShift: { x: number; y: number };
      shiftLock: MarqueeShiftLock | null;
      space: { pointer: { x: number; y: number }; rect: DesignXyRect } | null;
      rect: DesignXyRect;
    }
  | { kind: 'cancelled' };

export type MarqueeInput =
  | {
      type: 'move';
      point: { x: number; y: number };
      shiftKey: boolean;
      altKey: boolean;
    }
  | {
      type: 'key';
      key: 'Shift' | 'Alt' | 'Space' | 'Escape';
      down: boolean;
    };

function boxFromCorners(a: { x: number; y: number }, b: { x: number; y: number }): DesignXyRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function movedPoint(
  point: { x: number; y: number },
  delta: { x: number; y: number }
): { x: number; y: number } {
  return { x: point.x + delta.x, y: point.y + delta.y };
}

function movedXyRect(rect: DesignXyRect, delta: { x: number; y: number }): DesignXyRect {
  return { ...rect, x: rect.x + delta.x, y: rect.y + delta.y };
}

function lockAxis(from: { x: number; y: number }, to: { x: number; y: number }): 'x' | 'y' | null {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  if (dx < MARQUEE_AXIS_LOCK_THRESHOLD && dy < MARQUEE_AXIS_LOCK_THRESHOLD) return null;
  return dx >= dy ? 'x' : 'y';
}

function unconstrainedMarquee(
  anchor: { x: number; y: number },
  pointer: { x: number; y: number },
  alt: boolean
): DesignXyRect {
  if (!alt) return boxFromCorners(anchor, pointer);
  const dx = Math.abs(pointer.x - anchor.x);
  const dy = Math.abs(pointer.y - anchor.y);
  return { x: anchor.x - dx, y: anchor.y - dy, width: dx * 2, height: dy * 2 };
}

function sizedMarquee(
  anchor: { x: number; y: number },
  pointer: { x: number; y: number },
  keys: MarqueeKeys,
  previousLock: MarqueeShiftLock | null
): { rect: DesignXyRect; shiftLock: MarqueeShiftLock | null } {
  const free = unconstrainedMarquee(anchor, pointer, keys.alt);
  if (!keys.shiftArmed) {
    return { rect: free, shiftLock: null };
  }
  const armed = previousLock ?? { pointer, frozen: free, axis: null };
  const axis = armed.axis ?? lockAxis(armed.pointer, pointer);
  const shiftLock: MarqueeShiftLock = { ...armed, axis };
  if (axis === 'x') {
    return { rect: { ...free, y: armed.frozen.y, height: armed.frozen.height }, shiftLock };
  }
  if (axis === 'y') {
    return { rect: { ...free, x: armed.frozen.x, width: armed.frozen.width }, shiftLock };
  }
  return { rect: armed.frozen, shiftLock };
}

function draggingMarquee(
  origin: { x: number; y: number },
  pointer: { x: number; y: number },
  keys: MarqueeKeys,
  previous: {
    originShift: { x: number; y: number };
    shiftLock: MarqueeShiftLock | null;
    space: { pointer: { x: number; y: number }; rect: DesignXyRect } | null;
    rect: DesignXyRect | null;
  }
): Extract<MarqueeState, { kind: 'dragging' }> {
  let { originShift, shiftLock, space } = previous;
  if (!keys.space && space !== null) {
    const moved = { x: pointer.x - space.pointer.x, y: pointer.y - space.pointer.y };
    originShift = movedPoint(originShift, moved);
    shiftLock = shiftLock && {
      ...shiftLock,
      pointer: movedPoint(shiftLock.pointer, moved),
      frozen: movedXyRect(shiftLock.frozen, moved),
    };
    space = null;
  }
  if (keys.space) {
    space ??= {
      pointer,
      rect:
        previous.rect ??
        sizedMarquee(movedPoint(origin, originShift), pointer, keys, shiftLock).rect,
    };
    const rect = movedXyRect(space.rect, {
      x: pointer.x - space.pointer.x,
      y: pointer.y - space.pointer.y,
    });
    return {
      kind: 'dragging',
      origin,
      pointer,
      keys,
      originShift,
      shiftLock,
      space,
      rect,
    };
  }
  const sized = sizedMarquee(movedPoint(origin, originShift), pointer, keys, shiftLock);
  return {
    kind: 'dragging',
    origin,
    pointer,
    keys,
    originShift,
    shiftLock: sized.shiftLock,
    space: null,
    rect: sized.rect,
  };
}

export function reduceMarquee(state: MarqueeState, input: MarqueeInput): MarqueeState {
  if (state.kind === 'cancelled') return state;
  if (input.type === 'key' && input.key === 'Escape') {
    return input.down ? { kind: 'cancelled' } : state;
  }
  const was = state.keys;
  let keys: MarqueeKeys;
  if (input.type === 'move') {
    keys = {
      alt: input.altKey,
      shiftDown: input.shiftKey,
      shiftArmed: input.shiftKey && (was.shiftArmed || !was.shiftDown),
      space: was.space,
    };
  } else if (input.key === 'Shift') {
    keys = {
      ...was,
      shiftDown: input.down,
      shiftArmed: input.down && (was.shiftArmed || !was.shiftDown),
    };
  } else if (input.key === 'Alt') {
    keys = { ...was, alt: input.down };
  } else {
    keys = { ...was, space: input.down };
  }
  const pointer = input.type === 'move' ? input.point : state.pointer;
  if (state.kind === 'pressed') {
    if (
      Math.hypot(pointer.x - state.origin.x, pointer.y - state.origin.y) < MARQUEE_DRAG_THRESHOLD
    ) {
      return { ...state, pointer, keys };
    }
    return draggingMarquee(state.origin, pointer, keys, {
      originShift: { x: 0, y: 0 },
      shiftLock: null,
      space: null,
      rect: null,
    });
  }
  return draggingMarquee(state.origin, pointer, keys, state);
}

export function finishMarquee(
  state: MarqueeState,
  input: MarqueeInput,
  bounds: { width: number; height: number }
): { kind: 'dropped' } | { kind: 'click' } | { kind: 'region'; rect: DesignXyRect } {
  const final = reduceMarquee(state, input);
  if (final.kind === 'cancelled') return { kind: 'dropped' };
  if (final.kind === 'pressed') return { kind: 'click' };
  const x = Math.max(final.rect.x, 0);
  const y = Math.max(final.rect.y, 0);
  const width = Math.max(0, Math.min(final.rect.x + final.rect.width, bounds.width) - x);
  const height = Math.max(0, Math.min(final.rect.y + final.rect.height, bounds.height) - y);
  return width < MIN_REGION_PX || height < MIN_REGION_PX
    ? { kind: 'dropped' }
    : { kind: 'region', rect: { x, y, width, height } };
}

// --- Region 8-Way Resize & Move Geometry (Cursor browser-element-QNt1jeWe.js) ---

export type RegionResizeHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'sw' | 'nw' | 'se';

const REGION_HANDLE_CURSORS: Record<RegionResizeHandle, string> = {
  move: 'grab',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

function clampNum(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sameTopLeftRect(a: DesignTopLeftRect, b: DesignTopLeftRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function intersectTopLeftRect(input: {
  rect: DesignTopLeftRect;
  bounds: DesignTopLeftRect;
}): DesignTopLeftRect {
  const { rect, bounds } = input;
  const left = Math.max(rect.left, bounds.left);
  const top = Math.max(rect.top, bounds.top);
  const right = Math.min(rect.left + rect.width, bounds.left + bounds.width);
  const bottom = Math.min(rect.top + rect.height, bounds.top + bounds.height);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function ensureMinRegionSize(rect: DesignTopLeftRect): DesignTopLeftRect {
  const width = Math.max(rect.width, MIN_REGION_PX);
  const height = Math.max(rect.height, MIN_REGION_PX);
  if (width === rect.width && height === rect.height) return rect;
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
  };
}

export function clampRegionToViewport(input: {
  rect: DesignTopLeftRect;
  viewport: { width: number; height: number };
}): DesignTopLeftRect {
  const sized = ensureMinRegionSize(input.rect);
  const clipped = intersectTopLeftRect({
    rect: sized,
    bounds: { left: 0, top: 0, width: input.viewport.width, height: input.viewport.height },
  });
  if (sameTopLeftRect(clipped, sized)) return sized;
  if (clipped.width >= MIN_REGION_PX && clipped.height >= MIN_REGION_PX) return clipped;
  const width = Math.min(sized.width, input.viewport.width);
  const height = Math.min(sized.height, input.viewport.height);
  return {
    left: Math.min(Math.max(sized.left, 0), Math.max(0, input.viewport.width - width)),
    top: Math.min(Math.max(sized.top, 0), Math.max(0, input.viewport.height - height)),
    width,
    height,
  };
}

export function regionHandleAt(
  localPoint: { x: number; y: number },
  size: { width: number; height: number }
): RegionResizeHandle {
  const hitX = Math.min(8, size.width / 3);
  const hitY = Math.min(8, size.height / 3);
  const west = localPoint.x <= hitX;
  const east = localPoint.x >= size.width - hitX;
  const north = localPoint.y <= hitY;
  const south = localPoint.y >= size.height - hitY;
  if (north && west) return 'nw';
  if (north && east) return 'ne';
  if (south && west) return 'sw';
  if (south && east) return 'se';
  if (north) return 'n';
  if (south) return 's';
  if (west) return 'w';
  if (east) return 'e';
  return 'move';
}

export function regionHandleCursor(handle: RegionResizeHandle, active: boolean): string {
  return handle === 'move' ? (active ? 'grabbing' : 'grab') : REGION_HANDLE_CURSORS[handle];
}

function moveRegionWithinBounds(input: {
  start: DesignTopLeftRect;
  dx: number;
  dy: number;
  bounds: DesignTopLeftRect;
}): DesignTopLeftRect {
  const { start, dx, dy, bounds } = input;
  const maxRight = bounds.left + bounds.width;
  const maxBottom = bounds.top + bounds.height;
  return {
    left: clampNum(start.left + dx, bounds.left, Math.max(bounds.left, maxRight - start.width)),
    top: clampNum(start.top + dy, bounds.top, Math.max(bounds.top, maxBottom - start.height)),
    width: start.width,
    height: start.height,
  };
}

export function resizeDesignRegion(input: {
  start: DesignTopLeftRect;
  handle: RegionResizeHandle;
  dx: number;
  dy: number;
  bounds: DesignTopLeftRect;
  modifiers: { option: boolean; shift: boolean; moveAxis: 'x' | 'y' | null };
}): DesignTopLeftRect {
  const { handle, dx, dy, bounds, modifiers } = input;
  if (handle === 'move') {
    const move = (mx: number, my: number) =>
      intersectTopLeftRect({
        rect: moveRegionWithinBounds({ start: input.start, dx: mx, dy: my, bounds }),
        bounds,
      });
    if (!modifiers.shift) return move(dx, dy);
    if (modifiers.moveAxis === 'x') return move(dx, 0);
    if (modifiers.moveAxis === 'y') return move(0, dy);
    return input.start;
  }
  const start = intersectTopLeftRect({ rect: input.start, bounds });
  if (start.width < MIN_REGION_PX || start.height < MIN_REGION_PX) return input.start;
  const boundsRight = bounds.left + bounds.width;
  const boundsBottom = bounds.top + bounds.height;
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');
  const startRight = start.left + start.width;
  const startBottom = start.top + start.height;
  const centerX = start.left + start.width / 2;
  const centerY = start.top + start.height / 2;
  const factor = modifiers.option ? 2 : 1;
  const deltaW = (east ? dx : west ? -dx : 0) * factor;
  const deltaH = (south ? dy : north ? -dy : 0) * factor;
  const symmetricX = modifiers.option || !(west || east);
  const symmetricY = modifiers.option || !(north || south);
  const maxW = symmetricX
    ? 2 * Math.min(centerX - bounds.left, boundsRight - centerX)
    : west
      ? startRight - bounds.left
      : boundsRight - start.left;
  const maxH = symmetricY
    ? 2 * Math.min(centerY - bounds.top, boundsBottom - centerY)
    : north
      ? startBottom - bounds.top
      : boundsBottom - start.top;
  let width: number;
  let height: number;
  if (modifiers.shift && start.width > 0 && start.height > 0) {
    const rawScale =
      Math.abs(deltaW) >= Math.abs(deltaH)
        ? (start.width + deltaW) / start.width
        : (start.height + deltaH) / start.height;
    const minScale = Math.max(MIN_REGION_PX / start.width, MIN_REGION_PX / start.height);
    const maxScale = Math.min(maxW / start.width, maxH / start.height);
    const scale = clampNum(rawScale, minScale, Math.max(minScale, maxScale));
    width = start.width * scale;
    height = start.height * scale;
  } else {
    width = clampNum(start.width + deltaW, MIN_REGION_PX, Math.max(MIN_REGION_PX, maxW));
    height = clampNum(start.height + deltaH, MIN_REGION_PX, Math.max(MIN_REGION_PX, maxH));
  }
  return intersectTopLeftRect({
    rect: {
      left: symmetricX ? centerX - width / 2 : west ? startRight - width : start.left,
      top: symmetricY ? centerY - height / 2 : north ? startBottom - height : start.top,
      width,
      height,
    },
    bounds,
  });
}

export interface RegionDragState {
  handle: RegionResizeHandle;
  origin: { x: number; y: number };
  start: DesignTopLeftRect;
  pointer: { x: number; y: number };
  option: boolean;
  shift: boolean;
  shiftPointer: { x: number; y: number } | null;
  moveAxis: 'x' | 'y' | null;
  space: { pointer: { x: number; y: number }; rect: DesignTopLeftRect } | null;
  rect: DesignTopLeftRect;
}

export function beginRegionDrag(input: {
  handle: RegionResizeHandle;
  point: { x: number; y: number };
  rect: DesignTopLeftRect;
  modifiers: { altKey: boolean; shiftKey: boolean };
}): RegionDragState {
  return {
    handle: input.handle,
    origin: input.point,
    start: input.rect,
    pointer: input.point,
    option: input.modifiers.altKey,
    shift: input.modifiers.shiftKey,
    shiftPointer: null,
    moveAxis: null,
    space: null,
    rect: input.rect,
  };
}

export function stepRegionDrag(
  state: RegionDragState,
  input:
    | { type: 'move'; point: { x: number; y: number }; altKey: boolean; shiftKey: boolean }
    | { type: 'key'; key: 'Shift' | 'Alt' | 'Space' | 'Escape'; down: boolean },
  bounds: DesignTopLeftRect
): RegionDragState {
  let next = state;
  if (input.type === 'move') {
    next = {
      ...state,
      pointer: input.point,
      option: input.altKey,
      shift: input.shiftKey,
    };
  } else {
    switch (input.key) {
      case 'Shift':
        next = { ...state, shift: input.down };
        break;
      case 'Alt':
        next = { ...state, option: input.down };
        break;
      case 'Space':
        if (input.down && !state.space) {
          next = { ...state, space: { pointer: state.pointer, rect: state.rect } };
        } else if (!input.down && state.space) {
          next = {
            ...state,
            space: null,
            start: state.rect,
            origin: state.pointer,
            shiftPointer: null,
            moveAxis: null,
          };
        }
        break;
      case 'Escape':
        return state;
    }
  }
  const { pointer } = next;
  if (next.space) {
    const rect = resizeDesignRegion({
      start: next.space.rect,
      handle: 'move',
      dx: pointer.x - next.space.pointer.x,
      dy: pointer.y - next.space.pointer.y,
      bounds,
      modifiers: { option: false, shift: false, moveAxis: null },
    });
    return { ...next, rect };
  }
  let { shiftPointer, moveAxis } = next;
  if (next.shift && next.handle === 'move') {
    shiftPointer ??= pointer;
    moveAxis ??= lockAxis(shiftPointer, pointer);
  } else {
    shiftPointer = null;
    moveAxis = null;
  }
  const rect = resizeDesignRegion({
    start: next.start,
    handle: next.handle,
    dx: pointer.x - next.origin.x,
    dy: pointer.y - next.origin.y,
    bounds,
    modifiers: { option: next.option, shift: next.shift, moveAxis },
  });
  return { ...next, shiftPointer, moveAxis, rect };
}

export function translateRegionMarkup(input: {
  markup: readonly RegionMarkupShape[];
  from: DesignTopLeftRect;
  to: DesignTopLeftRect;
  markupScale: number;
}): RegionMarkupShape[] {
  const dx = (input.from.left - input.to.left) * input.markupScale;
  const dy = (input.from.top - input.to.top) * input.markupScale;
  if (input.markup.length === 0 || (dx === 0 && dy === 0)) return [...input.markup];
  const shift = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy });
  return input.markup.map((shape) =>
    shape.kind === 'pen'
      ? { kind: 'pen', points: shape.points.map(shift) }
      : { kind: shape.kind, from: shift(shape.from), to: shift(shape.to) }
  );
}

// --- Freehand Stroke (perfect-freehand port) & Vector Shapes ---

const { PI } = Math;
const FIXED_PI = PI + 1e-4;
const DEFAULT_PRESSURE = 0.5;
const UNIT_VEC: [number, number] = [1, 1];

function getStrokeRadius(
  size: number,
  thinning: number,
  pressure: number,
  easing: (t: number) => number = (t) => t
): number {
  return size * easing(0.5 - thinning * (0.5 - pressure));
}

function simulatePressure(prevPressure: number, distance: number, size: number): number {
  const sp = Math.min(1, distance / size);
  return Math.min(1, prevPressure + (Math.min(1, 1 - sp) - prevPressure) * (sp * 0.275));
}

function negVec(a: readonly [number, number]): [number, number] {
  return [-a[0], -a[1]];
}

function addVec(a: readonly [number, number], b: readonly [number, number]): [number, number] {
  return [a[0] + b[0], a[1] + b[1]];
}

function subVec(a: readonly [number, number], b: readonly [number, number]): [number, number] {
  return [a[0] - b[0], a[1] - b[1]];
}

function mulVec(a: readonly [number, number], s: number): [number, number] {
  return [a[0] * s, a[1] * s];
}

function divVec(a: readonly [number, number], s: number): [number, number] {
  return [a[0] / s, a[1] / s];
}

function perVec(a: readonly [number, number]): [number, number] {
  return [a[1], -a[0]];
}

function dotVec(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] * b[0] + a[1] * b[1];
}

function eqVec(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function lenVec(a: readonly [number, number]): number {
  return Math.hypot(a[0], a[1]);
}

function distSqVec(a: readonly [number, number], b: readonly [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function uniVec(a: readonly [number, number]): [number, number] {
  const l = lenVec(a);
  return l === 0 ? [0, 0] : divVec(a, l);
}

function distVec(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[1] - b[1], a[0] - b[0]);
}

function rotAround(
  a: readonly [number, number],
  center: readonly [number, number],
  angle: number
): [number, number] {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  const px = a[0] - center[0];
  const py = a[1] - center[1];
  return [px * c - py * s + center[0], px * s + py * c + center[1]];
}

function lrpVec(
  a: readonly [number, number],
  b: readonly [number, number],
  t: number
): [number, number] {
  return addVec(a, mulVec(subVec(b, a), t));
}

function prjVec(
  a: readonly [number, number],
  dir: readonly [number, number],
  dist: number
): [number, number] {
  return addVec(a, mulVec(dir, dist));
}

export interface FreehandOptions {
  size?: number;
  smoothing?: number;
  thinning?: number;
  streamline?: number;
  simulatePressure?: boolean;
  easing?: (t: number) => number;
  start?: { taper?: number | boolean; cap?: boolean; easing?: (t: number) => number };
  end?: { taper?: number | boolean; cap?: boolean; easing?: (t: number) => number };
  last?: boolean;
}

interface StrokePoint {
  point: [number, number];
  pressure: number;
  vector: [number, number];
  distance: number;
  runningLength: number;
}

export function getStrokePoints(
  rawInput: readonly (
    | { x: number; y: number; pressure?: number }
    | readonly [number, number, number?]
  )[],
  options: FreehandOptions = {}
): StrokePoint[] {
  const { streamline = 0.5, size = 16, last = false } = options;
  if (rawInput.length === 0) return [];
  const t = 0.15 + (1 - streamline) * 0.85;
  let pts: [number, number, number][] = rawInput.map((item) =>
    Array.isArray(item)
      ? [item[0], item[1], item[2] ?? DEFAULT_PRESSURE]
      : [
          (item as { x: number; y: number; pressure?: number }).x,
          (item as { x: number; y: number; pressure?: number }).y,
          (item as { x: number; y: number; pressure?: number }).pressure ?? DEFAULT_PRESSURE,
        ]
  );
  if (pts.length === 2) {
    const second = pts[1]!;
    pts = pts.slice(0, -1);
    for (let i = 1; i < 5; i++) {
      const lerped = lrpVec([pts[0]![0], pts[0]![1]], [second[0], second[1]], i / 4);
      pts.push([lerped[0], lerped[1], DEFAULT_PRESSURE]);
    }
  }
  if (pts.length === 1) {
    const first = pts[0]!;
    const shifted = addVec([first[0], first[1]], UNIT_VEC);
    pts = [...pts, [shifted[0], shifted[1], first[2]]];
  }
  const strokePoints: StrokePoint[] = [
    {
      point: [pts[0]![0], pts[0]![1]],
      pressure: pts[0]![2] >= 0 ? pts[0]![2] : 0.25,
      vector: [...UNIT_VEC],
      distance: 0,
      runningLength: 0,
    },
  ];
  let hasReachedMinLen = false;
  let runningLength = 0;
  let prev = strokePoints[0]!;
  const maxIdx = pts.length - 1;
  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i]!;
    const point: [number, number] =
      last && i === maxIdx ? [cur[0], cur[1]] : lrpVec(prev.point, [cur[0], cur[1]], t);
    if (eqVec(prev.point, point)) continue;
    const distance = distVec(point, prev.point);
    runningLength += distance;
    if (i < maxIdx && !hasReachedMinLen) {
      if (runningLength < size) continue;
      hasReachedMinLen = true;
    }
    prev = {
      point,
      pressure: cur[2] >= 0 ? cur[2] : DEFAULT_PRESSURE,
      vector: uniVec(subVec(prev.point, point)),
      distance,
      runningLength,
    };
    strokePoints.push(prev);
  }
  strokePoints[0]!.vector = strokePoints[1]?.vector ?? [0, 0];
  return strokePoints;
}

function resolveTaper(taper: number | boolean | undefined, size: number, totalLen: number): number {
  if (taper === false || taper === undefined) return 0;
  if (taper === true) return Math.max(size, totalLen);
  return taper;
}

export function getStrokeOutlinePoints(
  strokePoints: readonly StrokePoint[],
  options: FreehandOptions = {}
): [number, number][] {
  const {
    size = 16,
    smoothing = 0.5,
    thinning = 0.5,
    simulatePressure: simPressure = true,
    easing = (t) => t,
    start = {},
    end = {},
    last = false,
  } = options;
  const { cap: capStart = true, easing: taperStartEase = (t) => t * (2 - t) } = start;
  const { cap: capEnd = true, easing: taperEndEase = (t) => --t * t * t + 1 } = end;
  if (strokePoints.length === 0 || size <= 0) return [];
  const totalLength = strokePoints[strokePoints.length - 1]!.runningLength;
  const taperStart = resolveTaper(start.taper, size, totalLength);
  const taperEnd = resolveTaper(end.taper, size, totalLength);
  const minDist = (size * smoothing) ** 2;
  const leftPts: [number, number][] = [];
  const rightPts: [number, number][] = [];
  let prevPressure = strokePoints.slice(0, 10).reduce((acc, sp) => {
    let p = sp.pressure;
    if (simPressure) p = simulatePressure(acc, sp.distance, size);
    return (acc + p) / 2;
  }, strokePoints[0]!.pressure);

  let radius = getStrokeRadius(
    size,
    thinning,
    strokePoints[strokePoints.length - 1]!.pressure,
    easing
  );
  let firstRadius: number | undefined;
  let prevVector = strokePoints[0]!.vector;
  let prevLeft = strokePoints[0]!.point;
  let prevRight = prevLeft;
  let tempLeft = prevLeft;
  let tempRight = prevRight;
  let isPrevSharp = false;

  for (let i = 0; i < strokePoints.length; i++) {
    const sp = strokePoints[i]!;
    let { pressure } = sp;
    const { point, vector, distance, runningLength } = sp;
    const isLast = i === strokePoints.length - 1;
    if (!isLast && totalLength - runningLength < 3) continue;
    if (thinning) {
      if (simPressure) pressure = simulatePressure(prevPressure, distance, size);
      radius = getStrokeRadius(size, thinning, pressure, easing);
    } else {
      radius = size / 2;
    }
    if (firstRadius === undefined) firstRadius = radius;
    const ts = runningLength < taperStart ? taperStartEase(runningLength / taperStart) : 1;
    const te =
      totalLength - runningLength < taperEnd
        ? taperEndEase((totalLength - runningLength) / taperEnd)
        : 1;
    radius = Math.max(0.01, radius * Math.min(ts, te));

    const nextVector = (isLast ? strokePoints[i]! : strokePoints[i + 1]!).vector;
    const nextDpr = isLast ? 1 : dotVec(vector, nextVector);
    const prevDpr = dotVec(vector, prevVector);
    const isPathSharpCorner = prevDpr < 0 && !isPrevSharp;
    const isNextSharpCorner = nextDpr < 0;
    if (isPathSharpCorner || isNextSharpCorner) {
      const offset = mulVec(perVec(prevVector), radius);
      for (let step = 0; step <= 1; step += 1 / 13) {
        tempLeft = rotAround(subVec(point, offset), point, FIXED_PI * step);
        leftPts.push(tempLeft);
        tempRight = rotAround(addVec(point, offset), point, FIXED_PI * -step);
        rightPts.push(tempRight);
      }
      prevLeft = tempLeft;
      prevRight = tempRight;
      if (isNextSharpCorner) isPrevSharp = true;
      continue;
    }
    isPrevSharp = false;
    if (isLast) {
      const offset = mulVec(perVec(vector), radius);
      leftPts.push(subVec(point, offset));
      rightPts.push(addVec(point, offset));
    } else {
      const offset = mulVec(perVec(lrpVec(nextVector, vector, nextDpr)), radius);
      tempLeft = subVec(point, offset);
      if (i <= 1 || distSqVec(prevLeft, tempLeft) > minDist) {
        leftPts.push(tempLeft);
        prevLeft = tempLeft;
      }
      tempRight = addVec(point, offset);
      if (i <= 1 || distSqVec(prevRight, tempRight) > minDist) {
        rightPts.push(tempRight);
        prevRight = tempRight;
      }
      prevPressure = pressure;
      prevVector = vector;
    }
  }

  const firstPoint: [number, number] = [strokePoints[0]!.point[0], strokePoints[0]!.point[1]];
  const lastPoint: [number, number] =
    strokePoints.length > 1
      ? [
          strokePoints[strokePoints.length - 1]!.point[0],
          strokePoints[strokePoints.length - 1]!.point[1],
        ]
      : addVec(strokePoints[0]!.point, [1, 1]);

  const startCap: [number, number][] = [];
  const endCap: [number, number][] = [];

  if (strokePoints.length === 1) {
    if (!(taperStart || taperEnd) || last) {
      const r = firstRadius || radius;
      const startPt = prjVec(
        firstPoint,
        uniVec(perVec(subVec(firstPoint, addVec(firstPoint, [1, 1])))),
        -r
      );
      const dotPts: [number, number][] = [];
      for (let step = 1 / 13; step <= 1; step += 1 / 13) {
        dotPts.push(rotAround(startPt, firstPoint, FIXED_PI * 2 * step));
      }
      return dotPts;
    }
  } else {
    if (!taperStart && !(taperEnd && strokePoints.length === 1)) {
      if (capStart && rightPts[0]) {
        for (let step = 1 / 13; step <= 1; step += 1 / 13) {
          startCap.push(rotAround(rightPts[0], firstPoint, FIXED_PI * step));
        }
      } else if (leftPts[0] && rightPts[0]) {
        const corners = subVec(leftPts[0], rightPts[0]);
        const o0 = mulVec(corners, 0.5);
        const o1 = mulVec(corners, 0.51);
        startCap.push(
          subVec(firstPoint, o0),
          subVec(firstPoint, o1),
          addVec(firstPoint, o1),
          addVec(firstPoint, o0)
        );
      }
    }
    const direction = perVec(negVec(strokePoints[strokePoints.length - 1]!.vector));
    if (taperEnd || (taperStart && strokePoints.length === 1)) {
      endCap.push(lastPoint);
    } else if (capEnd) {
      const startPt = prjVec(lastPoint, direction, radius);
      for (let step = 1 / 29; step < 1; step += 1 / 29) {
        endCap.push(rotAround(startPt, lastPoint, FIXED_PI * 3 * step));
      }
    } else {
      endCap.push(
        addVec(lastPoint, mulVec(direction, radius)),
        addVec(lastPoint, mulVec(direction, radius * 0.99)),
        subVec(lastPoint, mulVec(direction, radius * 0.99)),
        subVec(lastPoint, mulVec(direction, radius))
      );
    }
  }
  return leftPts.concat(endCap, rightPts.reverse(), startCap);
}

export const CURSOR_PEN_STROKE_OPTIONS: FreehandOptions = {
  size: 3,
  thinning: -0.99,
  streamline: 0.99,
  smoothing: 0.99,
  easing: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  simulatePressure: true,
  start: { taper: 79, easing: (t) => Math.sin((t * Math.PI) / 2), cap: true },
  end: { taper: 0, cap: true },
};

export const REGION_MARKUP_COLOR = '#ff3b30';
export const REGION_MARKUP_STROKE_WIDTH = 3;
const ARROW_HEAD_LENGTH = 14;
const ARROW_HEAD_HALF_WIDTH = 6;
const MIN_SAMPLE_DIST = 0.5;

export function getFreehandStroke(
  points: readonly (
    | { x: number; y: number; pressure?: number }
    | readonly [number, number, number?]
  )[],
  options: FreehandOptions = CURSOR_PEN_STROKE_OPTIONS
): [number, number][] {
  return getStrokeOutlinePoints(getStrokePoints(points, options), options);
}

function fmtCoord(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function svgPathFromStroke(points: readonly (readonly [number, number])[]): string {
  if (points.length < 2) return '';
  const first = points[0]!;
  const parts = [`M${fmtCoord(first[0])} ${fmtCoord(first[1])}`];
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % points.length]!;
    parts.push(
      `Q${fmtCoord(x0)} ${fmtCoord(y0)} ${fmtCoord((x0 + x1) / 2)} ${fmtCoord((y0 + y1) / 2)}`
    );
  }
  parts.push('Z');
  return parts.join(' ');
}

export function appendSampledPoint(
  points: readonly { x: number; y: number }[],
  next: { x: number; y: number }
): { x: number; y: number }[] {
  const last = points.at(-1);
  if (last && Math.hypot(next.x - last.x, next.y - last.y) < MIN_SAMPLE_DIST) {
    return [...points];
  }
  return [...points, next];
}

export function snapMarkupPoint(input: {
  kind: 'ellipse' | 'rect' | 'arrow';
  from: { x: number; y: number };
  to: { x: number; y: number };
}): { x: number; y: number } {
  const dx = input.to.x - input.from.x;
  const dy = input.to.y - input.from.y;
  if (input.kind === 'arrow') {
    const len = Math.hypot(dx, dy);
    const snappedAngle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return {
      x: input.from.x + Math.cos(snappedAngle) * len,
      y: input.from.y + Math.sin(snappedAngle) * len,
    };
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return {
    x: input.from.x + Math.sign(dx || 1) * side,
    y: input.from.y + Math.sign(dy || 1) * side,
  };
}

function pointsBox(points: readonly { x: number; y: number }[]): DesignTopLeftRect {
  const first = points[0];
  if (!first) return { left: 0, top: 0, width: 0, height: 0 };
  let left = first.x;
  let right = first.x;
  let top = first.y;
  let bottom = first.y;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    left = Math.min(left, p.x);
    right = Math.max(right, p.x);
    top = Math.min(top, p.y);
    bottom = Math.max(bottom, p.y);
  }
  return { left, top, width: right - left, height: bottom - top };
}

export function isSignificantMark(shape: RegionMarkupShape): boolean {
  if (shape.kind === 'pen') {
    if (shape.points.length < 2) return false;
    const { width, height } = pointsBox(shape.points);
    return Math.hypot(width, height) >= REGION_MARKUP_STROKE_WIDTH;
  }
  const dx = Math.abs(shape.to.x - shape.from.x);
  const dy = Math.abs(shape.to.y - shape.from.y);
  return shape.kind === 'arrow'
    ? Math.hypot(dx, dy) >= REGION_MARKUP_STROKE_WIDTH
    : dx >= REGION_MARKUP_STROKE_WIDTH && dy >= REGION_MARKUP_STROKE_WIDTH;
}

export function appendSignificantMark(
  markup: readonly RegionMarkupShape[],
  next: RegionMarkupShape
): RegionMarkupShape[] {
  return isSignificantMark(next) ? [...markup, next] : [...markup];
}

export function ownsMarkupUndo(input: {
  markCount: number;
  toolHeld: boolean;
  noteOwnsUndo: boolean;
}): boolean {
  return input.markCount > 0 && (input.toolHeld || !input.noteOwnsUndo);
}

export interface ShapeSvgPath {
  d: string;
  paint: 'fill' | 'stroke';
}

export function shapePaths(
  shape: RegionMarkupShape,
  phase: 'active' | 'complete' = 'complete'
): ShapeSvgPath[] {
  switch (shape.kind) {
    case 'pen': {
      const d = svgPathFromStroke(
        getFreehandStroke(
          shape.points.map((p) => [p.x, p.y] as const),
          { ...CURSOR_PEN_STROKE_OPTIONS, last: phase === 'complete' }
        )
      );
      return d ? [{ d, paint: 'fill' }] : [];
    }
    case 'rect': {
      const left = Math.min(shape.from.x, shape.to.x);
      const top = Math.min(shape.from.y, shape.to.y);
      const width = Math.abs(shape.to.x - shape.from.x);
      const height = Math.abs(shape.to.y - shape.from.y);
      return [
        {
          d: `M${fmtCoord(left)} ${fmtCoord(top)} h${fmtCoord(width)} v${fmtCoord(height)} h${fmtCoord(-width)} Z`,
          paint: 'stroke',
        },
      ];
    }
    case 'ellipse': {
      const left = Math.min(shape.from.x, shape.to.x);
      const top = Math.min(shape.from.y, shape.to.y);
      const width = Math.abs(shape.to.x - shape.from.x);
      const height = Math.abs(shape.to.y - shape.from.y);
      const rx = width / 2;
      const ry = height / 2;
      const cy = top + ry;
      return [
        {
          d: `M${fmtCoord(left)} ${fmtCoord(cy)} a${fmtCoord(rx)} ${fmtCoord(ry)} 0 1 0 ${fmtCoord(rx * 2)} 0 a${fmtCoord(rx)} ${fmtCoord(ry)} 0 1 0 ${fmtCoord(-rx * 2)} 0 Z`,
          paint: 'stroke',
        },
      ];
    }
    case 'arrow': {
      const dx = shape.to.x - shape.from.x;
      const dy = shape.to.y - shape.from.y;
      const dist = Math.hypot(dx, dy);
      if (dist === 0) return [];
      const ux = dx / dist;
      const uy = dy / dist;
      const headLen = Math.min(ARROW_HEAD_LENGTH, dist * 0.6);
      const headHalfW = (ARROW_HEAD_HALF_WIDTH * headLen) / ARROW_HEAD_LENGTH;
      const baseX = shape.to.x - ux * headLen;
      const baseY = shape.to.y - uy * headLen;
      return [
        {
          d: `M${fmtCoord(shape.from.x)} ${fmtCoord(shape.from.y)} L${fmtCoord(baseX)} ${fmtCoord(baseY)}`,
          paint: 'stroke',
        },
        {
          d: `M${fmtCoord(shape.to.x)} ${fmtCoord(shape.to.y)} L${fmtCoord(baseX - uy * headHalfW)} ${fmtCoord(baseY + ux * headHalfW)} L${fmtCoord(baseX + uy * headHalfW)} ${fmtCoord(baseY - ux * headHalfW)} Z`,
          paint: 'fill',
        },
      ];
    }
  }
}

// --- Pin Geometry & Card Placement ---

export type OffscreenEdge = 'top' | 'bottom' | 'left' | 'right';

export interface PinBadgePlacement {
  top: number;
  left: number;
  corner: 'top-left' | 'top-right';
}

export function pinGeometry() {
  const BADGE_SIZE = 22;
  const BADGE_GAP = 4;
  const GUTTER_INSET = 8;
  const PILL_INSET = 8;
  const PILL_HEIGHT = 20;
  const PILL_MIN_WIDTH = 40;
  const PILL_DIGIT_WIDTH = 7;
  const PILL_BADGE_GAP = 4;

  const placePinBadge = (
    rect: DesignTopLeftRect,
    viewportWidth: number,
    inset: number
  ): PinBadgePlacement => {
    const top = rect.top >= 0 && rect.top < inset ? inset : rect.top;
    const rightLeft = rect.left + rect.width + BADGE_GAP;
    if (rightLeft + BADGE_SIZE <= viewportWidth - BADGE_GAP) {
      return { top, left: rightLeft, corner: 'top-left' };
    }
    return {
      top,
      left: Math.max(inset + BADGE_GAP, rect.left - BADGE_GAP - BADGE_SIZE),
      corner: 'top-right',
    };
  };

  const placeDetachedPinBadge = (
    index: number,
    viewportWidth: number,
    inset: number
  ): PinBadgePlacement => ({
    top: Math.max(GUTTER_INSET, inset + BADGE_GAP) + index * (BADGE_SIZE + BADGE_GAP),
    left: viewportWidth - BADGE_SIZE - GUTTER_INSET,
    corner: 'top-right',
  });

  const badgeBox = (placement: { top: number; left: number }): DesignTopLeftRect => ({
    top: placement.top,
    left: placement.left,
    width: BADGE_SIZE,
    height: BADGE_SIZE,
  });

  const offscreenEdge = (
    rect: DesignTopLeftRect,
    width: number,
    height: number
  ): OffscreenEdge | null => {
    if (rect.top + rect.height <= 0) return 'top';
    if (rect.top >= height) return 'bottom';
    if (rect.left + rect.width <= 0) return 'left';
    if (rect.left >= width) return 'right';
    if (rect.top < 0) return 'top';
    if (rect.top + rect.height > height) return 'bottom';
    if (rect.left < 0) return 'left';
    if (rect.left + rect.width > width) return 'right';
    return null;
  };

  const edgeDistance = (
    rect: DesignTopLeftRect,
    edge: OffscreenEdge,
    width: number,
    height: number
  ): number => {
    if (edge === 'top') return -(rect.top + rect.height);
    if (edge === 'bottom') return rect.top - height;
    if (edge === 'left') return -(rect.left + rect.width);
    return rect.left - width;
  };

  const clampPill = (value: number, min: number, max: number): number =>
    min > max ? (min + max) / 2 : Math.min(Math.max(value, min), max);

  const clearOfBadges = (
    center: number,
    half: number,
    min: number,
    max: number,
    rowTop: number,
    drawn: readonly DesignTopLeftRect[]
  ): number => {
    const inRow = drawn.filter(
      (badge) =>
        badge.top < rowTop + PILL_HEIGHT + PILL_BADGE_GAP &&
        badge.top + badge.height > rowTop - PILL_BADGE_GAP
    );
    const reach = half + PILL_BADGE_GAP;
    const covers = (at: number) =>
      inRow.some((badge) => at - reach < badge.left + badge.width && at + reach > badge.left);
    const clear = [
      center,
      ...inRow.flatMap((badge) => [badge.left - reach, badge.left + badge.width + reach]),
    ]
      .filter((at) => at >= min && at <= max && !covers(at))
      .sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    return clear[0] ?? center;
  };

  const pillCenter = (
    rect: DesignTopLeftRect,
    edge: OffscreenEdge,
    count: number,
    drawn: readonly DesignTopLeftRect[],
    width: number,
    height: number
  ): number => {
    if (edge === 'top' || edge === 'bottom') {
      const digits = Math.max(0, String(Math.max(1, count)).length - 1);
      const half = (PILL_MIN_WIDTH + digits * PILL_DIGIT_WIDTH) / 2;
      const min = PILL_INSET + half;
      const max = width - PILL_INSET - half;
      return clearOfBadges(
        clampPill(rect.left + rect.width / 2, min, max),
        half,
        min,
        max,
        edge === 'top' ? PILL_INSET : height - PILL_INSET - PILL_HEIGHT,
        drawn
      );
    }
    const half = PILL_HEIGHT / 2;
    const corner = PILL_INSET + PILL_HEIGHT;
    return clampPill(
      rect.top + rect.height / 2,
      corner + PILL_INSET + half,
      height - corner - PILL_INSET - half
    );
  };

  return {
    BADGE_SIZE,
    BADGE_GAP,
    PILL_INSET,
    PILL_HEIGHT,
    PILL_MIN_WIDTH,
    placePinBadge,
    placeDetachedPinBadge,
    badgeBox,
    offscreenEdge,
    edgeDistance,
    clampPill,
    clearOfBadges,
    pillCenter,
  };
}

const PIN_BADGE_SIZE = 22;
const PIN_EDITOR_MARGIN = 4;
const PIN_EDITOR_OFFSET = 6;
const FLOATING_CARD_MARGIN = 8;
const FLOATING_CARD_GAP = 8;

export function placePinEditor(
  badge: { top: number; left: number; detached: boolean; rulerInset: number },
  viewport: { width: number; height: number },
  cardSize: { width: number; height: number }
): { x: number; y: number } {
  const minEdge = badge.rulerInset + PIN_EDITOR_MARGIN;
  const maxTop = viewport.height - PIN_EDITOR_MARGIN - cardSize.height;
  if (badge.detached) {
    return {
      x: Math.max(minEdge, badge.left - PIN_EDITOR_MARGIN - cardSize.width),
      y: Math.max(minEdge, Math.min(badge.top, maxTop)),
    };
  }
  const below = badge.top + PIN_BADGE_SIZE + PIN_EDITOR_OFFSET;
  const y =
    below >= minEdge && below <= maxTop ? below : badge.top - PIN_EDITOR_OFFSET - cardSize.height;
  return {
    x: Math.max(minEdge, Math.min(badge.left, viewport.width - PIN_EDITOR_MARGIN - cardSize.width)),
    y: Math.max(minEdge, Math.min(y, maxTop)),
  };
}

export function placeFloatingNoteCard(
  anchor: DesignXyRect | null,
  viewport: { width: number; height: number },
  cardWidth: number,
  cardHeight: number
): { x: number; y: number } {
  if (anchor === null) {
    return {
      x: Math.max(FLOATING_CARD_MARGIN, (viewport.width - cardWidth) / 2),
      y: FLOATING_CARD_MARGIN,
    };
  }
  const right = anchor.x + anchor.width;
  const bottom = anchor.y + anchor.height;
  let x = Math.min(right, viewport.width - FLOATING_CARD_MARGIN) - cardWidth;
  let y = bottom + FLOATING_CARD_GAP;
  const maxY = viewport.height - cardHeight - FLOATING_CARD_MARGIN;
  if (y > maxY) {
    const above = anchor.y - FLOATING_CARD_GAP - cardHeight;
    if (above >= FLOATING_CARD_MARGIN) y = above;
  }
  x = Math.max(
    FLOATING_CARD_MARGIN,
    Math.min(x, viewport.width - cardWidth - FLOATING_CARD_MARGIN)
  );
  y = Math.max(FLOATING_CARD_MARGIN, Math.min(y, Math.max(FLOATING_CARD_MARGIN, maxY)));
  return { x, y };
}

// --- 27 Design CSS Properties, Scrubbing, Staging & Comment Serialization ---

export interface DesignCssScrubRule {
  min: number;
  max: number;
  step?: number;
  fraction?: boolean;
}

export type DesignCssGroup = 'type' | 'fill' | 'spacing' | 'layout' | 'size' | 'position';
export type DesignCssShownFor = 'text' | 'flex' | 'grid' | 'flex-or-grid' | 'positioned';

export interface DesignCssPropertySpec {
  name: string;
  group: DesignCssGroup;
  shownFor?: DesignCssShownFor;
  scrub?: DesignCssScrubRule;
  dashWhenUnauthored?: boolean;
  box?: boolean;
  presets?: readonly string[];
}

const SCRUB_FREE: DesignCssScrubRule = { min: -Infinity, max: Infinity };
const SCRUB_NON_NEGATIVE: DesignCssScrubRule = { min: 0, max: Infinity };

export const DESIGN_CSS_PROPERTIES: readonly DesignCssPropertySpec[] = [
  {
    name: 'font-size',
    scrub: { min: 1, max: Infinity },
    group: 'type',
    shownFor: 'text',
    presets: ['10px', '12px', '14px', '16px', '18px', '20px', '24px', '32px', '48px', '64px'],
  },
  {
    name: 'font-weight',
    group: 'type',
    shownFor: 'text',
    presets: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
  },
  {
    name: 'line-height',
    scrub: SCRUB_NON_NEGATIVE,
    dashWhenUnauthored: true,
    group: 'type',
    shownFor: 'text',
    presets: ['1', '1.15', '1.25', '1.333', '1.5', '1.6', '2'],
  },
  {
    name: 'letter-spacing',
    dashWhenUnauthored: true,
    scrub: SCRUB_FREE,
    group: 'type',
    shownFor: 'text',
    presets: ['-1px', '-0.5px', '0px', '0.25px', '0.5px', '1px'],
  },
  {
    name: 'text-align',
    group: 'type',
    shownFor: 'text',
    presets: ['left', 'center', 'right', 'justify'],
  },
  { name: 'color', group: 'fill', shownFor: 'text' },
  { name: 'background-color', dashWhenUnauthored: true, group: 'fill' },
  { name: 'border-color', dashWhenUnauthored: true, group: 'fill' },
  {
    name: 'border-width',
    scrub: SCRUB_NON_NEGATIVE,
    dashWhenUnauthored: true,
    group: 'fill',
    presets: ['0', '1px', '2px', '3px', '4px'],
  },
  {
    name: 'border-style',
    dashWhenUnauthored: true,
    group: 'fill',
    presets: ['solid', 'dashed', 'dotted', 'double', 'none'],
  },
  {
    name: 'border-radius',
    scrub: SCRUB_NON_NEGATIVE,
    dashWhenUnauthored: true,
    group: 'fill',
    presets: ['0', '2px', '4px', '6px', '8px', '12px', '16px', '9999px'],
  },
  {
    name: 'opacity',
    scrub: { min: 0, max: 1, fraction: true },
    group: 'fill',
    presets: ['0', '0.1', '0.25', '0.5', '0.75', '0.9', '1'],
  },
  {
    name: 'margin',
    scrub: SCRUB_FREE,
    group: 'spacing',
    box: true,
    presets: ['0', '2px', '4px', '8px', '12px', '16px', '24px', '32px', 'auto'],
  },
  {
    name: 'padding',
    scrub: SCRUB_NON_NEGATIVE,
    group: 'spacing',
    box: true,
    presets: ['0', '2px', '4px', '6px', '8px', '12px', '16px', '20px', '24px', '32px'],
  },
  {
    name: 'gap',
    scrub: SCRUB_NON_NEGATIVE,
    dashWhenUnauthored: true,
    group: 'spacing',
    shownFor: 'flex-or-grid',
    presets: ['0', '2px', '4px', '6px', '8px', '12px', '16px', '24px'],
  },
  {
    name: 'display',
    group: 'layout',
    presets: ['block', 'inline-block', 'inline', 'flex', 'grid', 'none'],
  },
  {
    name: 'flex-direction',
    group: 'layout',
    shownFor: 'flex',
    presets: ['row', 'row-reverse', 'column', 'column-reverse'],
  },
  {
    name: 'flex-wrap',
    group: 'layout',
    shownFor: 'flex',
    presets: ['nowrap', 'wrap', 'wrap-reverse'],
  },
  {
    name: 'justify-content',
    group: 'layout',
    shownFor: 'flex-or-grid',
    presets: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'],
  },
  {
    name: 'align-items',
    group: 'layout',
    shownFor: 'flex-or-grid',
    presets: ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'],
  },
  {
    name: 'grid-template-columns',
    group: 'layout',
    shownFor: 'grid',
    presets: ['1fr', 'repeat(2, 1fr)', 'repeat(3, 1fr)', 'repeat(4, 1fr)', 'auto 1fr', '1fr auto'],
  },
  {
    name: 'grid-template-rows',
    group: 'layout',
    shownFor: 'grid',
    presets: ['auto', 'repeat(2, auto)', '1fr', 'repeat(2, 1fr)'],
  },
  {
    name: 'width',
    scrub: SCRUB_NON_NEGATIVE,
    dashWhenUnauthored: true,
    group: 'size',
    presets: ['auto', '100%', '50%', 'fit-content', 'min-content', 'max-content'],
  },
  {
    name: 'height',
    scrub: SCRUB_NON_NEGATIVE,
    dashWhenUnauthored: true,
    group: 'size',
    presets: ['auto', '100%', '50%', 'fit-content', 'min-content', 'max-content'],
  },
  {
    name: 'position',
    group: 'position',
    presets: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
  },
  {
    name: 'inset',
    scrub: SCRUB_FREE,
    group: 'position',
    shownFor: 'positioned',
    box: true,
    presets: ['0', '4px', '8px', '16px', 'auto'],
  },
  {
    name: 'z-index',
    scrub: { ...SCRUB_FREE, step: 1 },
    group: 'position',
    shownFor: 'positioned',
    presets: ['0', '1', '2', '5', '10', '100'],
  },
];

export const DESIGN_CSS_TARGET_ATTRIBUTE = 'data-cursor-css-target';
export const CSS_EDITS_PREFIX = 'CSS edits — ';
const CSS_LINE_RE = new RegExp(`^${CSS_EDITS_PREFIX}.*$`, 'm');
const CSS_LINE_PREFIX_GLOBAL = new RegExp(`^${CSS_EDITS_PREFIX}`, 'gm');

export interface DesignCssVariable {
  name: string;
  value: string;
}

export interface DesignCssSnapshot {
  rendersText: boolean;
  values: Record<string, string>;
  authored: string[];
  variables: {
    colors: DesignCssVariable[];
    lengths: DesignCssVariable[];
  };
  rect: DesignTopLeftRect;
}

export function isCssPropertyShown(
  spec: DesignCssPropertySpec,
  context: { rendersText: boolean; values: Record<string, string> }
): boolean {
  if (spec.shownFor === undefined) return true;
  const display = context.values.display ?? '';
  switch (spec.shownFor) {
    case 'text':
      return context.rendersText;
    case 'flex':
      return display.includes('flex');
    case 'grid':
      return display.includes('grid');
    case 'flex-or-grid':
      return display.includes('flex') || display.includes('grid');
    case 'positioned':
      return !['', 'static'].includes(context.values.position ?? '');
  }
}

const LENGTH_ONLY_PROPERTIES = new Set([
  'font-size',
  'letter-spacing',
  'border-width',
  'border-radius',
  'margin',
  'padding',
  'gap',
  'width',
  'height',
  'inset',
]);

function takesLengthOnly(property: string): boolean {
  if (typeof globalThis.CSS?.supports === 'function') {
    return !globalThis.CSS.supports(property, '1') && globalThis.CSS.supports(property, '1px');
  }
  return LENGTH_ONLY_PROPERTIES.has(property);
}

const UNIT_STEPS: Record<string, number> = { rem: 0.0625, em: 0.0625 };
const NUMERIC_TOKEN_RE = /^-?(?:\d+\.?\d*|\.\d+)[a-z%]*$/;

export function scrubCssLengthValue(
  rawValue: string,
  delta: number,
  spec: DesignCssPropertySpec
): string | null {
  if (!spec.scrub) return null;
  const match =
    /^(-?[\d.]+)([a-z%]*)$/.exec(rawValue) ??
    (/^[a-z-]+$/.test(rawValue)
      ? [rawValue, '0', spec.scrub.step === undefined ? 'px' : '']
      : null);
  if (!match) return null;
  const [, digits, rawUnit] = match;
  const unit = rawUnit === '' && takesLengthOnly(spec.name) ? 'px' : (rawUnit ?? '');
  const step = unit === '' ? (spec.scrub.step ?? 0.01) : (UNIT_STEPS[unit] ?? 1);
  const scale = unit === '%' && spec.scrub.fraction ? 100 : unit === '' ? 1 : step;
  const clamped = Math.min(
    spec.scrub.max * scale,
    Math.max(spec.scrub.min * scale, Number(digits) + delta * step)
  );
  return `${Math.round(clamped * 1e4) / 1e4}${unit}`;
}

export function stepCssValue(
  currentValue: string,
  direction: 1 | -1,
  shiftKey: boolean,
  spec: DesignCssPropertySpec
): string | null {
  const presets = spec.presets ?? [];
  if (NUMERIC_TOKEN_RE.test(currentValue)) {
    const scrubbed = scrubCssLengthValue(currentValue, direction * (shiftKey ? 10 : 1), spec);
    if (scrubbed !== null) return scrubbed === currentValue ? null : scrubbed;
    if (presets.every((p) => NUMERIC_TOKEN_RE.test(p))) {
      const num = Number.parseFloat(currentValue);
      const candidates = presets.filter((p) => (Number.parseFloat(p) - num) * direction > 0);
      return (direction === 1 ? candidates[0] : candidates.at(-1)) ?? null;
    }
  }
  const idx = presets.indexOf(currentValue);
  return idx === -1 ? null : (presets[idx - direction] ?? null);
}

export interface CssEditChange {
  from: string;
  to: string | null;
}

function findCssEditsLine(comment: string): { start: number; end: number } | null {
  const match = CSS_LINE_RE.exec(comment);
  return match === null ? null : { start: match.index, end: match.index + match[0].length };
}

export function parseCssEditsComment(comment: string): Map<string, CssEditChange> {
  const span = findCssEditsLine(comment);
  if (span === null) return new Map();
  const body = comment.slice(span.start + CSS_EDITS_PREFIX.length, span.end);
  const out = new Map<string, CssEditChange>();
  for (const part of body.split('; ')) {
    const match = /^([a-z-]+): (?:removed \(was (.*)\)|(.*) \u2192 (.+))$/.exec(part);
    if (!match) continue;
    const prop = match[1]!;
    if (match[2] !== undefined) {
      out.set(prop, { from: match[2], to: null });
    } else {
      out.set(prop, { from: match[3] ?? '', to: match[4] ?? '' });
    }
  }
  return out;
}

export function formatCssEditsSummary(changes: ReadonlyMap<string, CssEditChange>): string {
  const parts = [...changes].map(([prop, { from, to }]) =>
    to === null ? `${prop}: removed (was ${from})` : `${prop}: ${from} \u2192 ${to}`
  );
  return parts.length > 0 ? `${CSS_EDITS_PREFIX}${parts.join('; ')}` : '';
}

export function mergeCommentCssBlock(
  comment: string,
  changes: ReadonlyMap<string, CssEditChange> | null
): string {
  if (changes === null) return comment;
  const summary = formatCssEditsSummary(changes);
  const span = findCssEditsLine(comment);
  const chunks =
    span === null
      ? [comment, summary]
      : [comment.slice(0, span.start), summary, comment.slice(span.end)];
  return chunks
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function splitCommentCssBlock(comment: string): {
  prose: string;
  css: Map<string, CssEditChange>;
} {
  const parsed = parseCssEditsComment(comment);
  if (parsed.size > 0 && mergeCommentCssBlock(comment, parsed) === comment) {
    return {
      prose: mergeCommentCssBlock(comment, new Map()),
      css: parsed,
    };
  }
  return { prose: comment.replace(CSS_LINE_PREFIX_GLOBAL, ''), css: new Map() };
}

const BARE_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

export function normalizeCssInputValue(property: string, value: string | null): string | null {
  if (value === null) return null;
  if (value.includes('(') || !takesLengthOnly(property)) return value;
  return value
    .split(/(\s+)/)
    .map((token) => (BARE_NUMBER_RE.test(token) ? `${token}px` : token))
    .join('');
}

export interface CssStageState {
  baseline: DesignCssSnapshot;
  committedEdits: Map<string, string | null>;
  committedSummary: string;
  edits: Map<string, string | null>;
  parked: Map<string, string>;
  staged: Map<string, CssEditChange> | null;
}

function computeCssChanges(
  baseline: DesignCssSnapshot,
  edits: ReadonlyMap<string, string | null>
): Map<string, CssEditChange> {
  const out = new Map<string, CssEditChange>();
  for (const [prop, val] of edits) {
    const orig = baseline.values[prop] ?? '';
    if (val !== orig) out.set(prop, { from: orig, to: val });
  }
  return out;
}

function validEditsOf(stage: {
  committedEdits: ReadonlyMap<string, string | null>;
  edits: ReadonlyMap<string, string | null>;
}): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [prop, raw] of stage.edits) {
    const fallback = stage.committedEdits.get(prop);
    const normalized = raw === '' ? '' : normalizeCssInputValue(prop, raw);
    const supported =
      normalized === null ||
      (normalized !== '' &&
        (typeof globalThis.CSS?.supports === 'function'
          ? globalThis.CSS.supports(prop, normalized)
          : true));
    if (supported) {
      out.set(prop, normalized);
    } else if (fallback !== undefined) {
      out.set(prop, fallback);
    }
  }
  return out;
}

export function createCssStage(
  snapshot: DesignCssSnapshot,
  initialCss: ReadonlyMap<string, CssEditChange>
): CssStageState {
  const baseline: DesignCssSnapshot = {
    ...snapshot,
    values: {
      ...snapshot.values,
      ...Object.fromEntries([...initialCss].map(([prop, { from }]) => [prop, from])),
    },
  };
  const committedEdits = new Map([...initialCss].map(([prop, { to }]) => [prop, to]));
  const committedChanges = computeCssChanges(baseline, committedEdits);
  return {
    baseline,
    committedEdits,
    committedSummary: formatCssEditsSummary(committedChanges),
    edits: new Map(committedEdits),
    parked: new Map(),
    staged: null,
  };
}

export type CssStageAction =
  | { kind: 'edit'; property: string; value: string }
  | { kind: 'disable'; property: string }
  | { kind: 'enable'; property: string }
  | { kind: 'reset'; property: string }
  | { kind: 'resetAll' };

export function reduceCssStage(
  stage: CssStageState,
  action: CssStageAction
): {
  staging: CssStageState;
  filed: Record<string, string | null>;
  changes: Map<string, CssEditChange>;
} {
  const baseValues = stage.baseline.values;
  const setEdit = (prop: string, val: string | null | undefined) => {
    const next = new Map(stage.edits);
    if (val === undefined) next.delete(prop);
    else next.set(prop, val);
    return next;
  };
  const dropParked = (prop: string) => {
    const next = new Map(stage.parked);
    next.delete(prop);
    return next;
  };
  let edits = stage.edits;
  let parked = stage.parked;
  switch (action.kind) {
    case 'edit':
      edits = setEdit(action.property, action.value);
      break;
    case 'disable': {
      const prev = stage.edits.get(action.property);
      edits = setEdit(action.property, null);
      if (prev) parked = new Map(stage.parked).set(action.property, prev);
      break;
    }
    case 'enable': {
      const committed = stage.committedEdits.get(action.property);
      const fallback =
        committed === undefined ? undefined : (committed ?? baseValues[action.property]);
      edits = setEdit(action.property, stage.parked.get(action.property) ?? fallback);
      parked = dropParked(action.property);
      break;
    }
    case 'reset':
      edits = setEdit(
        action.property,
        stage.committedEdits.has(action.property) ? baseValues[action.property] : undefined
      );
      parked = dropParked(action.property);
      break;
    case 'resetAll':
      edits = new Map([...stage.committedEdits.keys()].map((p) => [p, baseValues[p] ?? '']));
      parked = new Map();
      break;
  }
  const updated = { ...stage, edits, parked };
  const valid = validEditsOf(updated);
  const changes = computeCssChanges(stage.baseline, valid);
  return {
    staging: { ...updated, staged: changes },
    filed: Object.fromEntries(valid),
    changes,
  };
}

export function describeCssStage(stage: CssStageState): {
  changes: Map<string, CssEditChange>;
  canReset: boolean;
  isDirty: boolean;
  isAuthored: (property: string) => boolean;
  isEdited: (property: string) => boolean;
} {
  const changes = stage.staged ?? computeCssChanges(stage.baseline, validEditsOf(stage));
  const summary = formatCssEditsSummary(changes);
  return {
    changes,
    canReset: summary !== '',
    isDirty: summary !== stage.committedSummary,
    isAuthored: (prop) => stage.baseline.authored.includes(prop) || stage.committedEdits.has(prop),
    isEdited: (prop) => {
      const val = stage.edits.get(prop);
      return (
        val !== undefined &&
        normalizeCssInputValue(prop, val) !== (stage.baseline.values[prop] ?? '')
      );
    },
  };
}

export function queuedCssEditsOf(
  annotations: readonly DesignAnnotation[]
): Record<string, Record<string, string | null>> {
  const out: Record<string, Record<string, string | null>> = {};
  for (const item of annotations) {
    if (item.kind !== 'element' || item.elements.length !== 1) continue;
    const uid = item.elements[0]!.uniqueId;
    for (const [prop, { to }] of parseCssEditsComment(item.comment)) {
      const bucket = out[uid] ?? {};
      bucket[prop] = to;
      out[uid] = bucket;
    }
  }
  return out;
}

// --- Hint Phase, Escape Hierarchy, Familiarity, Frame Ring, Prompt Builder ---

export type DesignHintPhase =
  | 'idle'
  | 'region-drawing'
  | 'region-selected'
  | 'region-markup'
  | 'element-selected'
  | 'annotation-open';

export type DesignHintToken = string | { key: string };

export function designHintsForPlatform(isMac: boolean): Record<DesignHintPhase, DesignHintToken[]> {
  const escCancel: DesignHintToken[] = [{ key: 'Esc' }, ' to cancel'];
  return {
    idle: [
      { key: 'Click' },
      ' to select or ',
      { key: 'drag' },
      ' to create an area · ',
      { key: '↑↓' },
      ' to adjust',
    ],
    'region-drawing': escCancel,
    'region-selected': escCancel,
    'region-markup': [{ key: isMac ? '⌘Z' : 'Ctrl+Z' }, ' to undo · ', { key: 'Esc' }, ' to stop'],
    'element-selected': escCancel,
    'annotation-open': [{ key: 'Return' }, ' to save · ', { key: 'Esc' }, ' to close'],
  };
}

export function resolveDesignHintPhase(input: {
  drawing: boolean;
  pick: { region: DesignTopLeftRect | null } | null;
  markupToolHeld: boolean;
  editorOpen: boolean;
}): DesignHintPhase {
  if (input.drawing) return 'region-drawing';
  if (input.pick === null) return input.editorOpen ? 'annotation-open' : 'idle';
  if (input.pick.region === null) return 'element-selected';
  return input.markupToolHeld ? 'region-markup' : 'region-selected';
}

export type DesignEscapeAction =
  | 'pass-through'
  | 'cancel-stroke'
  | 'put-down-tool'
  | 'dismiss-warning'
  | 'cancel-draft'
  | 'close-editor'
  | 'exit';

export function resolveDesignEscapeAction(input: {
  queueOwnsEscape: boolean;
  targetOwnsEscape: boolean;
  targetIsInput: boolean;
  markupStrokeActive: boolean;
  markupToolHeld: boolean;
  warningShown: boolean;
  draftOpen: boolean;
  editorOpen: boolean;
}): DesignEscapeAction {
  if (input.queueOwnsEscape || input.targetOwnsEscape) return 'pass-through';
  if (input.markupStrokeActive) return 'cancel-stroke';
  if (input.markupToolHeld) return 'put-down-tool';
  if (input.warningShown && (input.draftOpen || input.editorOpen)) return 'dismiss-warning';
  if (input.draftOpen) return 'cancel-draft';
  if (input.editorOpen) return 'close-editor';
  if (input.targetIsInput) return 'pass-through';
  return 'exit';
}

export type NoteSubmitAction = 'add-to-stack' | 'save-note' | 'send-note';

export const NOTE_SUBMIT_LABELS: Record<NoteSubmitAction, { note: string; css: string }> = {
  'add-to-stack': { note: 'Add to stack', css: 'Add CSS edits to stack' },
  'save-note': { note: 'Save note', css: 'Save CSS edits' },
  'send-note': { note: 'Send note', css: 'Send CSS edits' },
};

export function resolveNoteSubmitAction(input: {
  sendImmediately: boolean;
  isOnStack: boolean;
}): NoteSubmitAction {
  return input.sendImmediately ? 'send-note' : input.isOnStack ? 'save-note' : 'add-to-stack';
}

export type AnnotateFamiliarity = 'never' | 'few' | 'many';
const FAMILIARITY_FEW_MAX = 5;

export function annotateFamiliarityOf(entered: boolean, useCount: number): AnnotateFamiliarity {
  if (useCount === 0) return entered ? 'few' : 'never';
  return useCount <= FAMILIARITY_FEW_MAX ? 'few' : 'many';
}

export function frameRingPaths(
  width: number,
  height: number,
  radii: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number }
): { right: string; left: string } {
  const halfStroke = 1;
  const left = halfStroke;
  const top = halfStroke;
  const right = width - halfStroke;
  const bottom = height - halfStroke;
  const midX = (left + right) / 2;
  const maxR = Math.max(0, Math.min(right - left, bottom - top) / 2);
  const clampR = (r: number) => Math.max(0, Math.min(r, maxR));
  const tl = clampR(radii.topLeft);
  const tr = clampR(radii.topRight);
  const br = clampR(radii.bottomRight);
  const bl = clampR(radii.bottomLeft);
  return {
    right: [
      `M ${midX} ${top}`,
      `H ${right - tr}`,
      `A ${tr} ${tr} 0 0 1 ${right} ${top + tr}`,
      `V ${bottom - br}`,
      `A ${br} ${br} 0 0 1 ${right - br} ${bottom}`,
      `H ${midX}`,
    ].join(' '),
    left: [
      `M ${midX} ${top}`,
      `H ${left + tl}`,
      `A ${tl} ${tl} 0 0 0 ${left} ${top + tl}`,
      `V ${bottom - bl}`,
      `A ${bl} ${bl} 0 0 0 ${left + bl} ${bottom}`,
      `H ${midX}`,
    ].join(' '),
  };
}

const PROMPT_TEXT_SNIPPET_MAX = 80;

function groupAnnotationsByPage(
  annotations: readonly DesignAnnotation[],
  pageKeyOf: (a: DesignAnnotation) => string | undefined = (a) => a.pageKey
): { pageKey: string | undefined; annotations: DesignAnnotation[] }[] {
  const defaultByBrowser = new Map<string, string>();
  for (const item of annotations) {
    const pk = pageKeyOf(item);
    if (pk !== undefined && !defaultByBrowser.has(item.browserId)) {
      defaultByBrowser.set(item.browserId, `${item.browserId} ${pk}`);
    }
  }
  const grouped = new Map<string, DesignAnnotation[]>();
  for (const item of annotations) {
    const pk = pageKeyOf(item);
    const key =
      (pk === undefined ? defaultByBrowser.get(item.browserId) : undefined) ??
      `${item.browserId} ${pk ?? ''}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return [...grouped.values()].map((list) => ({
    pageKey: list.map(pageKeyOf).find((pk) => pk !== undefined),
    annotations: [...list].sort((a, b) => a.number - b.number),
  }));
}

function formatAnnotationLineSegments(annotation: DesignAnnotation): string {
  if (annotation.kind === 'region') {
    const { width, height } = annotation.region.rect;
    const shortLabel = `Region ${Math.round(width)} × ${Math.round(height)}`;
    const fullLabel = `Screenshot region ${Math.round(width)} × ${Math.round(height)}`;
    const anchor = annotation.region.anchor;
    const anchorPath =
      anchor?.tagName && anchor.tagName !== 'HTML' && anchor.tagName !== 'BODY'
        ? anchor.path || anchor.tagName.toLowerCase()
        : 'region';
    return formatUiElementRefLine({
      label: shortLabel,
      path: anchorPath,
      text: fullLabel,
    });
  }
  const elements = annotation.kind === 'element' ? annotation.elements : [annotation.element];
  return elements
    .map((el) => {
      const snippet = (el.innerText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, PROMPT_TEXT_SNIPPET_MAX);
      const label = elementLabelOf(el);
      return formatUiElementRefLine({
        label,
        path: el.path || el.tagName.toLowerCase(),
        text: snippet || label,
      });
    })
    .join(' ');
}

const BROWSER_ELEMENT_FENCED_BLOCK_RE = /\n*```browser_element\n[\s\S]*?```(?=\n|$)/g;

export function stripBrowserElementBlocks(text: string): string {
  return text.replace(BROWSER_ELEMENT_FENCED_BLOCK_RE, '').trimEnd();
}

export function buildAnnotationsPrompt(
  annotations: readonly DesignAnnotation[],
  pageKeyOf: (a: DesignAnnotation) => string | undefined = (a) => a.pageKey
): {
  ordered: DesignAnnotation[];
  text: string;
  images: { data: string; mimeType: string }[];
} {
  const groups = groupAnnotationsByPage(annotations, pageKeyOf);
  const ordered = groups.flatMap((g) => g.annotations);
  const single = ordered.length === 1;
  const lines: string[] = [];
  let index = 0;
  groups.forEach((group, groupIdx) => {
    if (groupIdx > 0) lines.push('');
    if (groups.length > 1) {
      lines.push(`On ${group.pageKey ?? 'a page with no address'}:`);
    }
    for (const item of group.annotations) {
      index += 1;
      const prefix = single ? '' : `${index}. `;
      const segs = formatAnnotationLineSegments(item);
      const commentSuffix = item.comment.trim() ? ` ${item.comment.trim()}` : '';
      lines.push(`${prefix}${segs}${commentSuffix}`);
    }
  });
  const seenUids = new Set<string>();
  const elementBlocks: string[] = [];
  for (const item of ordered) {
    const context: BrowserAnnotationBlockContext = {
      browserId: item.browserId,
      pageUrl: pageKeyOf(item) ?? item.pageKey,
    };
    if (item.kind === 'region') {
      elementBlocks.push(formatBrowserRegionBlock(item.region, context).trim());
      continue;
    }
    for (const el of annotationElementsOf(item)) {
      const key = `${item.browserId}:${el.uniqueId || `${el.tagName}:${el.path}`}`;
      if (seenUids.has(key)) continue;
      seenUids.add(key);
      elementBlocks.push(formatBrowserElementBlock(el, context).trim());
    }
  }
  const text =
    elementBlocks.length > 0
      ? `${lines.join('\n')}\n\n${elementBlocks.join('\n\n')}`
      : lines.join('\n');
  const images = ordered.flatMap((item) =>
    item.images.map((img) => ({ data: img.data, mimeType: img.mimeType }))
  );
  return { ordered, text, images };
}
