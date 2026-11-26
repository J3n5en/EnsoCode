const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const ROOT_SVG_TAG = /<svg\b(?:[^>"']|"[^"]*"|'[^']*')*>/i;

/** Chromium canvas 单边与面积上限，超出后 toDataURL 只会得到空图 */
export const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_AREA = MAX_CANVAS_SIDE * MAX_CANVAS_SIDE;
const PREFERRED_PNG_SCALE = 2;

function attrPattern(name: string): RegExp {
  return new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, 'i');
}

function readAttr(tag: string, name: string): string | null {
  const m = tag.match(attrPattern(name));
  return m ? m[0].replace(/^[^=]*=\s*/, '').replace(/^["']|["']$/g, '') : null;
}

function writeAttr(tag: string, name: string, value: string): string {
  const attr = ` ${name}="${value}"`;
  const pattern = attrPattern(name);
  return pattern.test(tag)
    ? tag.replace(pattern, attr)
    : tag.replace(/\s*\/?>$/, (end) => `${attr}${end}`);
}

export function svgViewBoxSize(markup: string): { width: number; height: number } | null {
  const tag = markup.match(ROOT_SVG_TAG)?.[0];
  const viewBox = tag ? readAttr(tag, 'viewBox') : null;
  if (!viewBox) return null;
  const parts = viewBox
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4) return null;
  const [, , width, height] = parts;
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

/** 补齐命名空间，宽高固定为 viewBox 尺寸（不受预览缩放 / useMaxWidth 影响） */
export function normalizeSvgMarkup(markup: string): string {
  const match = markup.match(ROOT_SVG_TAG);
  if (!match) return markup;
  let tag = match[0];
  if (!readAttr(tag, 'xmlns')) tag = writeAttr(tag, 'xmlns', SVG_NS);
  if (markup.includes('xlink:') && !readAttr(tag, 'xmlns:xlink')) {
    tag = writeAttr(tag, 'xmlns:xlink', XLINK_NS);
  }
  const size = svgViewBoxSize(markup);
  if (size) {
    tag = writeAttr(tag, 'width', String(size.width));
    tag = writeAttr(tag, 'height', String(size.height));
    const style = readAttr(tag, 'style');
    if (style !== null) {
      const rest = style
        .split(';')
        .filter((decl) => decl.trim() && !/^\s*max-width\s*:/i.test(decl))
        .join(';')
        .trim();
      tag = rest ? writeAttr(tag, 'style', rest) : tag.replace(attrPattern('style'), '');
    }
  }
  return markup.replace(match[0], () => tag);
}

export function mermaidExportFileName(ext: 'svg' | 'png', now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `mermaid-${date}-${time}.${ext}`;
}

/** 优先 2x；长图收缩到上限内，1x 都放不下返回 null */
export function pngExportScale(width: number, height: number): number | null {
  const scale = Math.min(
    PREFERRED_PNG_SCALE,
    MAX_CANVAS_SIDE / width,
    MAX_CANVAS_SIDE / height,
    Math.sqrt(MAX_CANVAS_AREA / (width * height))
  );
  return scale >= 1 ? scale : null;
}

export function svgBlob(markup: string): Blob {
  return new Blob([normalizeSvgMarkup(markup)], { type: 'image/svg+xml' });
}

/** 序列化真实 DOM 节点（含 decorate 后的属性），产出合法 XML */
export function serializeSvgElement(svg: Element): string {
  return normalizeSvgMarkup(new XMLSerializer().serializeToString(svg));
}

/** mermaid 输出是 HTML 序列化，放进惰性文档再按 XML 序列化，避免 <br> 等让 Image 解析失败 */
export function svgMarkupToXml(markup: string): string {
  const svg = new DOMParser().parseFromString(markup, 'text/html').querySelector('svg');
  if (!svg) throw new Error('No svg in markup');
  return serializeSvgElement(svg);
}

/** ImageIO / Quick Look 不吃 <style>，这些呈现属性必须写在元素上 */
export const PRESENTATION_PROPS = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'marker-start',
  'marker-mid',
  'marker-end',
  'color',
] as const;

const MARKER_PAINT_PROPS = ['marker-start', 'marker-mid', 'marker-end'] as const;
const CONTEXT_FALLBACK = '#333333';

/** SVG/CSS 初始值。写进去只涨体积，ImageIO 缺省也是这些 */
const DEFAULT_PRESENTATION: Record<string, readonly string[]> = {
  fill: ['rgb(0, 0, 0)', 'rgba(0, 0, 0, 1)', '#000', '#000000', 'black'],
  'fill-opacity': ['1'],
  'fill-rule': ['nonzero'],
  stroke: ['none'],
  'stroke-width': ['1', '1px'],
  'stroke-opacity': ['1'],
  'stroke-dasharray': ['none', '0', '0px'],
  'stroke-linecap': ['butt'],
  'stroke-linejoin': ['miter'],
  opacity: ['1'],
  'font-weight': ['400', 'normal'],
  'font-style': ['normal'],
  'text-anchor': ['start'],
  'dominant-baseline': ['auto'],
  'marker-start': ['none'],
  'marker-mid': ['none'],
  'marker-end': ['none'],
  color: ['rgb(0, 0, 0)', 'rgba(0, 0, 0, 1)', '#000', '#000000', 'black'],
};

export type PresentationReader = (el: Element) => Partial<Record<string, string>>;

function canonPaint(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function isDefaultPresentation(prop: string, value: string): boolean {
  const defaults = DEFAULT_PRESENTATION[prop];
  return defaults?.some((item) => canonPaint(item) === canonPaint(value)) ?? false;
}

function hasContextPaint(value: string | null | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return lower.includes('context-stroke') || lower.includes('context-fill');
}

function replaceContext(value: string, stroke: string, fill: string): string {
  return value.replace(/context-stroke/gi, stroke).replace(/context-fill/gi, fill);
}

/** getComputedStyle 会把 url(#id) 解析成绝对地址，导回文件后必须仍是片段引用 */
function markerIdFromPaint(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /url\(\s*["']?[^)"']*#([^)"']+)["']?\s*\)/i.exec(value);
  return match?.[1] ?? null;
}

function presentationValue(
  prop: string,
  raw: string | undefined,
  computed: Partial<Record<string, string>>
): string | null {
  if (raw == null) return null;
  let value = raw.trim();
  if (!value) return null;
  if (canonPaint(value) === 'currentcolor') {
    const color = computed.color?.trim();
    if (color && canonPaint(color) !== 'currentcolor') value = color;
  }
  if (prop === 'marker-start' || prop === 'marker-mid' || prop === 'marker-end') {
    const id = markerIdFromPaint(value);
    if (id) value = `url(#${id})`;
  }
  if (isDefaultPresentation(prop, value)) return null;
  return value;
}

function allElements(root: Element): Element[] {
  return [root, ...root.querySelectorAll('*')];
}

function isSkippable(el: Element): boolean {
  const name = el.localName;
  return name === 'style' || name === 'script' || name === 'title' || name === 'desc';
}

export function inlinePresentationAttrs(root: Element, read: PresentationReader): void {
  for (const el of allElements(root)) {
    if (isSkippable(el)) continue;
    const computed = read(el);
    for (const prop of PRESENTATION_PROPS) {
      const next = presentationValue(prop, computed[prop], computed);
      if (next == null) continue;
      el.setAttribute(prop, next);
    }
  }
}

export function removeSvgStyleElements(root: Element): void {
  for (const el of root.querySelectorAll('style')) el.remove();
}

function referencedMarkerIds(el: Element, read: PresentationReader): string[] {
  const computed = read(el);
  const ids: string[] = [];
  for (const attr of MARKER_PAINT_PROPS) {
    const id = markerIdFromPaint(el.getAttribute(attr)) ?? markerIdFromPaint(computed[attr]);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function concretePaint(
  el: Element,
  read: PresentationReader,
  kind: 'stroke' | 'fill'
): string | null {
  const computed = read(el);
  for (const value of [el.getAttribute(kind), computed[kind]]) {
    const paint = value?.trim();
    if (paint && paint !== 'none' && !hasContextPaint(paint)) return paint;
  }
  return null;
}

function contextSubst(
  user: Element | undefined,
  read: PresentationReader
): { stroke: string; fill: string } {
  return {
    stroke: (user && concretePaint(user, read, 'stroke')) || CONTEXT_FALLBACK,
    fill: (user && concretePaint(user, read, 'fill')) || CONTEXT_FALLBACK,
  };
}

function applyContextSubst(
  el: Element,
  read: PresentationReader,
  stroke: string,
  fill: string
): void {
  const computed = read(el);
  for (const prop of ['fill', 'stroke'] as const) {
    const attr = el.getAttribute(prop);
    const source = hasContextPaint(attr)
      ? attr
      : hasContextPaint(computed[prop])
        ? computed[prop]
        : null;
    if (source) el.setAttribute(prop, replaceContext(source, stroke, fill));
  }
  const style = el.getAttribute('style');
  if (hasContextPaint(style) && style)
    el.setAttribute('style', replaceContext(style, stroke, fill));
}

function markerHasContext(marker: Element, read: PresentationReader): boolean {
  for (const el of [marker, ...marker.querySelectorAll('*')]) {
    if (hasContextPaint(el.getAttribute('fill')) || hasContextPaint(el.getAttribute('stroke')))
      return true;
    if (hasContextPaint(el.getAttribute('style'))) return true;
    const computed = read(el);
    if (hasContextPaint(computed.fill) || hasContextPaint(computed.stroke)) return true;
  }
  return false;
}

function suffixIds(el: Element, suffix: string): void {
  if (el.hasAttribute('id')) el.setAttribute('id', `${el.getAttribute('id')}${suffix}`);
  for (const child of el.querySelectorAll('[id]')) {
    child.setAttribute('id', `${child.getAttribute('id')}${suffix}`);
  }
}

function retargetMarker(user: Element, fromId: string, toId: string): void {
  for (const attr of MARKER_PAINT_PROPS) {
    const value = user.getAttribute(attr);
    if (value && markerIdFromPaint(value) === fromId) user.setAttribute(attr, `url(#${toId})`);
  }
}

function resolveMarker(marker: Element, users: readonly Element[], read: PresentationReader): void {
  if (!markerHasContext(marker, read)) return;
  const nodesOf = (node: Element) => [node, ...node.querySelectorAll('*')];
  if (users.length === 0) {
    const subst = contextSubst(undefined, read);
    for (const el of nodesOf(marker)) applyContextSubst(el, read, subst.stroke, subst.fill);
    return;
  }

  const groups = new Map<string, Element[]>();
  for (const user of users) {
    const subst = contextSubst(user, read);
    const key = `${subst.stroke}\0${subst.fill}`;
    const group = groups.get(key);
    if (group) group.push(user);
    else groups.set(key, [user]);
  }

  const originalId = marker.getAttribute('id') ?? '';
  const template = marker.cloneNode(true) as Element;
  let index = 0;
  for (const group of groups.values()) {
    const target = index === 0 ? marker : (template.cloneNode(true) as Element);
    if (index > 0) {
      const suffix = `-${index}`;
      suffixIds(target, suffix);
      marker.parentNode?.insertBefore(target, marker.nextSibling);
      for (const user of group) retargetMarker(user, originalId, `${originalId}${suffix}`);
    }
    const subst = contextSubst(group[0], read);
    for (const el of nodesOf(target)) applyContextSubst(el, read, subst.stroke, subst.fill);
    index += 1;
  }
}

/** marker 里的 context-stroke / context-fill 随引用它的图元上色；解析不到用 #333333 */
export function resolveContextPaints(root: Element, read: PresentationReader): void {
  const usersByMarker = new Map<string, Element[]>();
  for (const el of allElements(root)) {
    for (const id of referencedMarkerIds(el, read)) {
      const users = usersByMarker.get(id);
      if (users) {
        if (!users.includes(el)) users.push(el);
      } else {
        usersByMarker.set(id, [el]);
      }
    }
  }

  for (const marker of [...root.querySelectorAll('marker')]) {
    const id = marker.getAttribute('id');
    resolveMarker(marker, id ? (usersByMarker.get(id) ?? []) : [], read);
  }

  for (const el of allElements(root)) {
    if (el.localName === 'marker' || el.closest('marker')) continue;
    applyContextSubst(el, read, CONTEXT_FALLBACK, CONTEXT_FALLBACK);
  }
}

const TEXT_OFFSET_ATTRS = ['x', 'y', 'dx', 'dy'] as const;

export interface MarkerPlacement {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export type MarkerPlacementReader = (el: Element, which: 'start' | 'end') => MarkerPlacement | null;

interface MarkerMetrics {
  sx: number;
  sy: number;
  refX: number;
  refY: number;
}

function hasEm(value: string | null): boolean {
  return !!value && /em/i.test(value);
}

function elementHasEmOffset(el: Element): boolean {
  return TEXT_OFFSET_ATTRS.some((attr) => hasEm(el.getAttribute(attr)));
}

function fontSizePx(el: Element): number {
  let node: Element | null = el;
  while (node) {
    const raw = node.getAttribute('font-size')?.trim() ?? '';
    const match = /^(-?(?:\d+\.?\d*|\.\d+))(?:px)?$/i.exec(raw);
    if (match) {
      const size = Number(match[1]);
      if (size > 0) return size;
    }
    node = node.parentElement;
  }
  return 16;
}

function lengthPx(value: string | null, fontSize: number): number | null {
  if (value == null) return null;
  const token = value.trim().split(/[\s,]+/)[0] ?? '';
  if (!token) return null;
  const em = /^(-?(?:\d+\.?\d*|\.\d+))em$/i.exec(token);
  if (em) return Number(em[1]) * fontSize;
  const px = /^(-?(?:\d+\.?\d*|\.\d+))(?:px)?$/i.exec(token);
  return px ? Number(px[1]) : null;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function resolveAxis(el: Element, axis: 'x' | 'y', fallback: number, fontSize: number): number {
  const deltaName = axis === 'x' ? 'dx' : 'dy';
  const baseRaw = el.getAttribute(axis);
  const deltaRaw = el.getAttribute(deltaName);
  let pos = fallback;
  const base = lengthPx(baseRaw, fontSize);
  if (baseRaw != null && baseRaw.trim() !== '' && base != null) pos = base;
  const delta = lengthPx(deltaRaw, fontSize);
  if (deltaRaw != null && deltaRaw.trim() !== '' && delta != null) pos += delta;
  return pos;
}

function foldOwnEm(el: Element): void {
  if (!elementHasEmOffset(el)) return;
  const fontSize = fontSizePx(el);
  for (const axis of ['x', 'y'] as const) {
    const deltaName = axis === 'x' ? 'dx' : 'dy';
    if (!hasEm(el.getAttribute(axis)) && !hasEm(el.getAttribute(deltaName))) continue;
    el.setAttribute(axis, fmt(resolveAxis(el, axis, 0, fontSize)));
    el.removeAttribute(deltaName);
  }
}

/** CoreSVG 忽略 tspan 的 x/y/dx/dy，只认父 text 的绝对 px。em 折进去后 Chrome 仍对齐。 */
export function absolutizeEmTextPositions(root: Element): void {
  for (const text of root.querySelectorAll('text')) {
    const tspans = [...text.querySelectorAll('tspan')];
    if (!elementHasEmOffset(text) && !tspans.some(elementHasEmOffset)) continue;
    foldOwnEm(text);
    const fontSize = fontSizePx(text);
    let cursorX = lengthPx(text.getAttribute('x'), fontSize) ?? 0;
    let cursorY = lengthPx(text.getAttribute('y'), fontSize) ?? 0;
    let textX: string | null = null;
    let textY: string | null = null;
    for (const tspan of tspans) {
      const size = fontSizePx(tspan);
      const em = elementHasEmOffset(tspan);
      const hasX = tspan.hasAttribute('x') || tspan.hasAttribute('dx');
      const hasY = tspan.hasAttribute('y') || tspan.hasAttribute('dy');
      if (hasX) {
        cursorX = resolveAxis(tspan, 'x', cursorX, size);
        if (em && (hasEm(tspan.getAttribute('x')) || hasEm(tspan.getAttribute('dx')))) {
          tspan.setAttribute('x', fmt(cursorX));
          tspan.removeAttribute('dx');
        }
        if (textX == null) textX = fmt(cursorX);
      }
      if (hasY) {
        cursorY = resolveAxis(tspan, 'y', cursorY, size);
        if (em && (hasEm(tspan.getAttribute('y')) || hasEm(tspan.getAttribute('dy')))) {
          tspan.setAttribute('y', fmt(cursorY));
          tspan.removeAttribute('dy');
        }
        if (textY == null) textY = fmt(cursorY);
      }
    }
    if (textX != null) text.setAttribute('x', textX);
    if (textY != null) text.setAttribute('y', textY);
  }
}

function markerById(root: Element, id: string): Element | null {
  for (const marker of root.querySelectorAll('marker')) {
    if (marker.getAttribute('id') === id) return marker;
  }
  return null;
}

function readUserLength(value: string | null): number | null {
  const raw = value?.trim() ?? '';
  if (!raw || raw.endsWith('%')) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function readMarkerMetrics(marker: Element, host: Element): MarkerMetrics {
  const vb = (marker.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const vbW = vb.length === 4 && vb[2] > 0 ? vb[2] : 0;
  const vbH = vb.length === 4 && vb[3] > 0 ? vb[3] : 0;
  const markerWidth = readUserLength(marker.getAttribute('markerWidth'));
  const markerHeight = readUserLength(marker.getAttribute('markerHeight'));
  let sx = vbW > 0 && markerWidth != null ? markerWidth / vbW : 1;
  let sy = vbH > 0 && markerHeight != null ? markerHeight / vbH : 1;
  if ((marker.getAttribute('markerUnits') || 'strokeWidth').trim() === 'strokeWidth') {
    const width = parseFloat(host.getAttribute('stroke-width') || '1');
    const strokeWidth = Number.isFinite(width) && width > 0 ? width : 1;
    sx *= strokeWidth;
    sy *= strokeWidth;
  }
  return {
    sx,
    sy,
    refX: readUserLength(marker.getAttribute('refX')) ?? 0,
    refY: readUserLength(marker.getAttribute('refY')) ?? 0,
  };
}

function directionOf(
  marker: Element,
  which: 'start' | 'end',
  at: MarkerPlacement
): { dx: number; dy: number } {
  const orient = (marker.getAttribute('orient') || 'auto').trim();
  if (orient === 'auto' || orient === 'auto-start-reverse') {
    let dx = at.dx;
    let dy = at.dy;
    if (orient === 'auto-start-reverse' && which === 'start') {
      dx = -dx;
      dy = -dy;
    }
    const mag = Math.hypot(dx, dy);
    return mag < 1e-6 ? { dx: 1, dy: 0 } : { dx: dx / mag, dy: dy / mag };
  }
  const deg = Number(orient);
  if (!Number.isFinite(deg)) return { dx: 1, dy: 0 };
  const rad = (deg * Math.PI) / 180;
  return { dx: Math.cos(rad), dy: Math.sin(rad) };
}

function mapMarkerPoint(
  x: number,
  y: number,
  metrics: MarkerMetrics,
  dir: { dx: number; dy: number },
  at: MarkerPlacement
): { x: number; y: number } {
  const lx = (x - metrics.refX) * metrics.sx;
  const ly = (y - metrics.refY) * metrics.sy;
  return {
    x: at.x + lx * dir.dx - ly * dir.dy,
    y: at.y + lx * dir.dy + ly * dir.dx,
  };
}

function edgePaint(el: Element): string {
  for (const name of ['stroke', 'fill']) {
    const value = el.getAttribute(name)?.trim();
    if (value && value !== 'none' && !/context-/i.test(value)) return value;
  }
  return CONTEXT_FALLBACK;
}

function ownPaint(value: string | null, fallback: string): string {
  const paint = value?.trim();
  if (paint && paint !== 'none' && !/context-/i.test(paint)) return paint;
  return fallback;
}

function markerShapes(marker: Element): Element[] {
  return [...marker.children].filter((el) => {
    const name = el.localName;
    return name !== 'title' && name !== 'desc' && name !== 'defs' && name !== 'script';
  });
}

function tokenizePath(d: string): string[] {
  return d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
}

function bakePath(
  d: string,
  map: (x: number, y: number) => { x: number; y: number }
): string | null {
  const tokens = tokenizePath(d);
  if (tokens.length === 0) return null;
  let index = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const parts: string[] = [];
  const isCmd = (token: string | undefined) => !!token && /[a-zA-Z]/.test(token);
  const read = (): number => Number(tokens[index++]);
  while (index < tokens.length) {
    if (isCmd(tokens[index])) cmd = tokens[index++] ?? '';
    const rel = cmd === cmd.toLowerCase();
    const op = cmd.toUpperCase();
    if (op === 'Z') {
      parts.push('z');
      cx = sx;
      cy = sy;
      continue;
    }
    if (op === 'H' || op === 'V') {
      while (index < tokens.length && !isCmd(tokens[index])) {
        const n = read();
        if (!Number.isFinite(n)) return null;
        const x = op === 'H' ? (rel ? cx + n : n) : cx;
        const y = op === 'V' ? (rel ? cy + n : n) : cy;
        const point = map(x, y);
        parts.push(`L ${fmt(point.x)} ${fmt(point.y)}`);
        cx = x;
        cy = y;
      }
      continue;
    }
    if (op !== 'M' && op !== 'L') return null;
    let first = true;
    while (index < tokens.length && !isCmd(tokens[index])) {
      const x = read();
      const y = read();
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const ax = rel ? cx + x : x;
      const ay = rel ? cy + y : y;
      const point = map(ax, ay);
      parts.push(`${op === 'M' && first ? 'M' : 'L'} ${fmt(point.x)} ${fmt(point.y)}`);
      if (op === 'M' && first) {
        sx = ax;
        sy = ay;
      }
      cx = ax;
      cy = ay;
      first = false;
    }
    if (first) return null;
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

function polygonPath(points: string): string | null {
  const nums = points
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (nums.length < 4 || nums.length % 2 !== 0 || nums.some((n) => !Number.isFinite(n)))
    return null;
  let d = `M ${nums[0]} ${nums[1]}`;
  for (let i = 2; i < nums.length; i += 2) d += ` L ${nums[i]} ${nums[i + 1]}`;
  return `${d} z`;
}

function pinTransform(host: Element, node: Element): void {
  const transform = host.getAttribute('transform');
  if (transform) node.setAttribute('transform', transform);
}

function bakeShape(
  doc: Document,
  shape: Element,
  map: (x: number, y: number) => { x: number; y: number },
  metrics: MarkerMetrics,
  paint: string,
  host: Element
): Element | null {
  const name = shape.localName;
  if (name === 'circle') {
    const cx = Number(shape.getAttribute('cx') ?? '0');
    const cy = Number(shape.getAttribute('cy') ?? '0');
    const r = Number(shape.getAttribute('r'));
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r) || r <= 0) return null;
    const center = map(cx, cy);
    const rx = Math.abs(r * metrics.sx);
    const ry = Math.abs(r * metrics.sy);
    const node =
      Math.abs(rx - ry) < 0.001
        ? doc.createElementNS(SVG_NS, 'circle')
        : doc.createElementNS(SVG_NS, 'ellipse');
    node.setAttribute('cx', fmt(center.x));
    node.setAttribute('cy', fmt(center.y));
    if (node.localName === 'circle') node.setAttribute('r', fmt(rx));
    else {
      node.setAttribute('rx', fmt(rx));
      node.setAttribute('ry', fmt(ry));
    }
    node.setAttribute('fill', ownPaint(shape.getAttribute('fill'), paint));
    pinTransform(host, node);
    return node;
  }
  const d =
    name === 'polygon' ? polygonPath(shape.getAttribute('points') ?? '') : shape.getAttribute('d');
  if (!d || (name !== 'path' && name !== 'polygon')) return null;
  const baked = bakePath(d, map);
  if (!baked) return null;
  const node = doc.createElementNS(SVG_NS, 'path');
  node.setAttribute('d', baked);
  if (/z/i.test(d)) {
    node.setAttribute('fill', ownPaint(shape.getAttribute('fill'), paint));
    node.setAttribute('stroke', 'none');
  } else {
    const width = parseFloat(shape.getAttribute('stroke-width') || '1');
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', ownPaint(shape.getAttribute('stroke'), paint));
    node.setAttribute(
      'stroke-width',
      fmt((Number.isFinite(width) ? width : 1) * Math.abs(metrics.sx))
    );
  }
  pinTransform(host, node);
  return node;
}

function fallbackMarker(
  doc: Document,
  marker: Element,
  host: Element,
  at: MarkerPlacement,
  metrics: MarkerMetrics,
  dir: { dx: number; dy: number },
  paint: string
): Element | null {
  const shapes = markerShapes(marker);
  if (shapes.length === 0) return null;
  const g = doc.createElementNS(SVG_NS, 'g');
  const deg = (Math.atan2(dir.dy, dir.dx) * 180) / Math.PI;
  g.setAttribute(
    'transform',
    [
      host.getAttribute('transform'),
      `translate(${fmt(at.x)} ${fmt(at.y)})`,
      `rotate(${fmt(deg)})`,
      `scale(${fmt(metrics.sx)} ${fmt(metrics.sy)})`,
      `translate(${fmt(-metrics.refX)} ${fmt(-metrics.refY)})`,
    ]
      .filter(Boolean)
      .join(' ')
  );
  for (const shape of shapes) {
    const clone = shape.cloneNode(true) as Element;
    if (clone.hasAttribute('id')) clone.removeAttribute('id');
    for (const named of clone.querySelectorAll('[id]')) named.removeAttribute('id');
    if (clone.localName === 'path' && !/z/i.test(clone.getAttribute('d') ?? '')) {
      clone.setAttribute('fill', 'none');
      clone.setAttribute('stroke', ownPaint(clone.getAttribute('stroke'), paint));
    } else if (!ownPaint(clone.getAttribute('fill'), '').trim()) {
      clone.setAttribute('fill', paint);
    }
    g.appendChild(clone);
  }
  return g;
}

function instantiateMarker(
  doc: Document,
  marker: Element,
  host: Element,
  at: MarkerPlacement,
  which: 'start' | 'end'
): Element[] {
  const metrics = readMarkerMetrics(marker, host);
  const dir = directionOf(marker, which, at);
  const paint = edgePaint(host);
  const map = (x: number, y: number) => mapMarkerPoint(x, y, metrics, dir, at);
  const baked: Element[] = [];
  for (const shape of markerShapes(marker)) {
    const node = bakeShape(doc, shape, map, metrics, paint, host);
    if (!node) {
      const group = fallbackMarker(doc, marker, host, at, metrics, dir, paint);
      return group ? [group] : [];
    }
    baked.push(node);
  }
  return baked;
}

/** CoreSVG 不画任何 marker。导出前按端点切线把箭头烘焙成真实几何。 */
export function materializeMarkers(root: Element, place: MarkerPlacementReader): void {
  const doc = root.ownerDocument;
  if (!doc) return;
  const hosts = [...root.querySelectorAll('*')].filter((el) => !el.closest('marker'));
  for (const el of hosts) {
    for (const attr of ['marker-end', 'marker-start'] as const) {
      const id = markerIdFromPaint(el.getAttribute(attr));
      if (!id) continue;
      const marker = markerById(root, id);
      const at = place(el, attr === 'marker-start' ? 'start' : 'end');
      if (!marker || !at) continue;
      const nodes = instantiateMarker(
        doc,
        marker,
        el,
        at,
        attr === 'marker-start' ? 'start' : 'end'
      );
      const parent = el.parentNode;
      if (nodes.length === 0 || !parent) continue;
      el.removeAttribute(attr);
      let after: ChildNode | null = el.nextSibling;
      for (const node of nodes) {
        parent.insertBefore(node, after);
        after = node.nextSibling;
      }
    }
  }
}

export function downloadFile(data: Blob | string, fileName: string): void {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function rasterizeSvg(
  markup: string,
  width: number,
  height: number,
  scale: number,
  background: string
): Promise<string> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/png');
  if (!url.startsWith('data:image/png')) throw new Error('Canvas export failed');
  return url;
}

export type PngExportResult =
  | { kind: 'png' }
  | { kind: 'svg'; reason: 'rerender-failed' | 'too-large' | 'draw-failed' }
  | { kind: 'failed' };

export type SvgExportResult = { kind: 'svg'; source: 'rerender' | 'live' } | { kind: 'failed' };

export interface PngExportDeps {
  /** 当前预览中的 SVG（已序列化） */
  currentSvg: () => string | null;
  /** 以 htmlLabels:false 重新渲染，避免 foreignObject 画不进 canvas */
  rerender: () => Promise<string>;
  rasterize: (markup: string, width: number, height: number, scale: number) => Promise<string>;
  download: (data: Blob | string, fileName: string) => void;
}

/** fail-open：任何一步失败都降级为导出当前 SVG，绝不抛出 */
export async function exportMermaidPng(deps: PngExportDeps): Promise<PngExportResult> {
  const fallback = (reason: 'rerender-failed' | 'too-large' | 'draw-failed'): PngExportResult => {
    try {
      const svg = deps.currentSvg();
      if (!svg) return { kind: 'failed' };
      deps.download(svgBlob(svg), mermaidExportFileName('svg'));
      return { kind: 'svg', reason };
    } catch {
      return { kind: 'failed' };
    }
  };

  let markup: string;
  try {
    markup = normalizeSvgMarkup(await deps.rerender());
  } catch {
    return fallback('rerender-failed');
  }
  if (/<foreignObject\b/i.test(markup)) return fallback('rerender-failed');

  const size = svgViewBoxSize(markup);
  if (!size) return fallback('draw-failed');
  const scale = pngExportScale(size.width, size.height);
  if (scale === null) return fallback('too-large');

  try {
    const dataUrl = await deps.rasterize(markup, size.width, size.height, scale);
    deps.download(dataUrl, mermaidExportFileName('png'));
    return { kind: 'png' };
  } catch {
    return fallback('draw-failed');
  }
}

export interface SvgExportDeps {
  /** 以 htmlLabels:false 重新渲染，避免 foreignObject */
  rerender: () => Promise<string>;
  /** 当前预览中的 SVG（已序列化）；重渲染失败或仍含 foreignObject 时使用 */
  currentSvg: () => string | null;
  download: (data: Blob | string, fileName: string) => void;
}

/** 优先导出无 foreignObject 的重渲染；失败则回退当前预览，绝不抛出 */
export async function exportMermaidSvg(deps: SvgExportDeps): Promise<SvgExportResult> {
  const live = (): SvgExportResult => {
    try {
      const svg = deps.currentSvg();
      if (!svg) return { kind: 'failed' };
      deps.download(svgBlob(svg), mermaidExportFileName('svg'));
      return { kind: 'svg', source: 'live' };
    } catch {
      return { kind: 'failed' };
    }
  };

  let markup: string;
  try {
    markup = await deps.rerender();
  } catch {
    return live();
  }
  if (/<foreignObject\b/i.test(markup)) return live();

  try {
    deps.download(svgBlob(markup), mermaidExportFileName('svg'));
    return { kind: 'svg', source: 'rerender' };
  } catch {
    return live();
  }
}
