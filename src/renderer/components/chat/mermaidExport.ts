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
