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
