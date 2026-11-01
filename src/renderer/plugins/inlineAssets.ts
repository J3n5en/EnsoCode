import { isPluginRelativePath } from '@shared/extensionPlugins/manifest';

export interface PluginViewAsset {
  mime: string;
  base64: string;
}

/** 相对页面目录解析资源；绝对路径、协议 URL、查询串和越界返回 null */
export function resolvePluginViewAsset(pagePath: string, ref: string): string | null {
  const trimmed = ref.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return null;
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0') ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  )
    return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null;
  const page =
    isPluginRelativePath(pagePath) && pagePath !== '.'
      ? pagePath
      : (pagePath.split('/').pop() ?? '');
  const slash = page.lastIndexOf('/');
  const dir = slash === -1 ? '' : page.slice(0, slash);
  const joined = dir ? `${dir}/${trimmed}` : trimmed;
  const parts: string[] = [];
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const normalized = parts.join('/');
  if (!normalized || !isPluginRelativePath(normalized)) return null;
  return normalized;
}

function attrValue(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i').exec(
    attrs
  );
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? '';
}

function replaceAttr(attrs: string, name: string, value: string): string {
  return attrs.replace(
    new RegExp(`\\b${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>]+)`, 'i'),
    `${name}="${value}"`
  );
}

function isStylesheet(rel: string | null): boolean {
  return rel?.trim().toLowerCase().split(/\s+/).includes('stylesheet') ?? false;
}

function decodeUtf8Base64(base64: string): string | null {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

interface Slot {
  start: number;
  end: number;
  kind: 'script' | 'style' | 'img';
  rel: string;
  attrs: string;
  full: string;
}

function collect(html: string, pagePath: string): Slot[] {
  const slots: Slot[] = [];
  const push = (
    kind: Slot['kind'],
    match: RegExpExecArray,
    attrName: string,
    accept: (attrs: string) => boolean
  ) => {
    const attrs = match[1] ?? '';
    if (!accept(attrs)) return;
    const raw = attrValue(attrs, attrName);
    if (raw === null) return;
    const rel = resolvePluginViewAsset(pagePath, raw);
    if (!rel) return;
    slots.push({
      start: match.index,
      end: match.index + match[0].length,
      kind,
      rel,
      attrs,
      full: match[0],
    });
  };
  for (const match of html.matchAll(/<script\b([^>]*)>[\s\S]*?<\/script>/gi))
    push('script', match, 'src', () => true);
  for (const match of html.matchAll(/<link\b([^>]*?)\/?>/gi))
    push('style', match, 'href', (attrs) => isStylesheet(attrValue(attrs, 'rel')));
  for (const match of html.matchAll(/<img\b([^>]*?)\/?>/gi)) push('img', match, 'src', () => true);
  slots.sort((a, b) => a.start - b.start);
  return slots;
}

/** 注入侧栏页面前把相对脚本、样式和图片内联；读不到或路径不合法的标签保持原样 */
export async function inlinePluginViewHtml(
  html: string,
  pagePath: string,
  readAsset: (rel: string) => Promise<PluginViewAsset | null>
): Promise<string> {
  const slots = collect(html, pagePath);
  const assets = new Map<string, PluginViewAsset | null>();
  await Promise.all(
    [...new Set(slots.map((slot) => slot.rel))].map(async (rel) => {
      assets.set(rel, await readAsset(rel));
    })
  );
  let cursor = 0;
  let out = '';
  for (const slot of slots) {
    out += html.slice(cursor, slot.start);
    cursor = slot.end;
    const asset = assets.get(slot.rel);
    if (!asset) {
      out += slot.full;
      continue;
    }
    if (slot.kind === 'img') {
      const mime = asset.mime || 'application/octet-stream';
      out += `<img${replaceAttr(slot.attrs, 'src', `data:${mime};base64,${asset.base64}`)}>`;
      continue;
    }
    const text = decodeUtf8Base64(asset.base64);
    if (text === null) {
      out += slot.full;
      continue;
    }
    out +=
      slot.kind === 'script'
        ? `<script>${text.replace(/<\/script/gi, '<\\/script')}</script>`
        : `<style>${text.replace(/<\/style/gi, '<\\/style')}</style>`;
  }
  return out + html.slice(cursor);
}
