const ESCAPE = /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|(\r\n|[\n\r\f])|([\s\S]))/g;

function unescapeCss(css: string): string {
  return css.replace(ESCAPE, (_, hex: string | undefined, newline: string | undefined, ch) => {
    if (newline) return '';
    if (!hex) return ch;
    const code = Number.parseInt(hex, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
      ? '\uFFFD'
      : String.fromCodePoint(code);
  });
}

function percentDecodeFully(text: string): string {
  let current = text;
  for (let i = 0; i < 8; i++) {
    const next = current.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * 解开 CSS 转义和百分号编码后是否出现 local-image。远程模式的 /desk/li/ 路由会解码一次再交给协议，
 * URL 解析又会删掉 tab 和换行，所以都先还原再查
 */
export function themeCssReferencesLocalImage(css: string): boolean {
  return percentDecodeFully(unescapeCss(css))
    .replace(/[\t\n\r]/g, '')
    .toLowerCase()
    .includes('local-image');
}

const URL_TOKEN = /url\(\s*(?:"([^"\\\n]*)"|'([^'\\\n]*)'|([^)"'\s\\]*))\s*\)/gi;

function resolveRelative(cssPath: string, ref: string): string | null {
  if (ref === '' || ref.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(ref)) return null;
  const stack = cssPath.split('/').slice(0, -1);
  for (const raw of ref.split('/')) {
    let part: string;
    try {
      part = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (part === '' || part === '.') continue;
    if (part !== '..') stack.push(part);
    else if (stack.pop() === undefined) return null;
  }
  return stack.length > 0 ? stack.join('/') : null;
}

/** 相对 url() 按 CSS 文件所在目录解析后交给 toUrl；绝对地址、越界、带转义的保持原样 */
export function rewriteThemeCssUrls(
  css: string,
  cssPath: string,
  toUrl: (rel: string) => string
): string {
  return css.replace(URL_TOKEN, (token, double?: string, single?: string, bare?: string) => {
    const value = (double ?? single ?? bare ?? '').trim();
    const hashAt = value.indexOf('#');
    const hash = hashAt >= 0 ? value.slice(hashAt).replaceAll('"', '%22') : '';
    const path = (hashAt >= 0 ? value.slice(0, hashAt) : value).split('?')[0] ?? '';
    const rel = resolveRelative(cssPath, path);
    return rel ? `url("${toUrl(rel)}${hash}")` : token;
  });
}
