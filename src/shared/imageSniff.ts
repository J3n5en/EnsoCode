/** 只看前面一段，避免把整份大文件都拿来扫描 */
const SVG_SNIFF_WINDOW = 512;

/**
 * 内容是否以 SVG 根元素开头（容忍前导 BOM/空白/xml 声明/注释）。只要开头是
 * `<svg`，即便内部带 `<script>`/`onload` 也认为是合法 SVG——本功能自始至终只通过真实
 * `<img>` DOM 元素渲染这个内容（不用 dangerouslySetInnerHTML、不用内联 `<svg>`、不用
 * object/embed/iframe），浏览器对作为图片加载的 SVG 实施“图片上下文”隔离（禁脚本、禁外部
 * 资源拉取、交互失效），内容本身是否带脚本不影响安全。
 */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const text = Buffer.from(bytes.subarray(0, Math.min(bytes.length, SVG_SNIFF_WINDOW))).toString(
    'utf8'
  );
  // 逐段线性扫描，不能写回一条 `(<!--[\s\S]*?-->\s*)*<svg` 正则：连续注释后接的不是 <svg 时
  // 它会指数回溯，而这里在 Main 同步执行，512 字节的前缀就能卡死整个应用。
  // `\s` 含 U+FEFF，BOM 随空白一起跳过。
  let pos = skipSpaces(text, 0);
  if (/^<\?xml/i.test(text.slice(pos, pos + 5))) {
    const end = text.indexOf('>', pos);
    if (end < 0 || text[end - 1] !== '?') return false;
    pos = skipSpaces(text, end + 1);
  }
  // 注释按 XML 语义结束于第一个 `-->`
  while (text.startsWith('<!--', pos)) {
    const end = text.indexOf('-->', pos + 4);
    if (end < 0) return false;
    pos = skipSpaces(text, end + 3);
  }
  return /^<svg[\s>]/i.test(text.slice(pos, pos + 5));
}

function skipSpaces(text: string, from: number): number {
  let pos = from;
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  return pos;
}

/**
 * 位图内容嗅探（读魔数，不信任扩展名/声明的 Content-Type）：防止把非位图/非 SVG 的
 * 任意内容改个图片后缀或伪造 Content-Type 就绕过 Markdown 预览的图片白名单。
 * 识别不出本功能支持的格式返回 null。
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 6 &&
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61
  )
    return 'image/gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00)
    return 'image/x-icon';
  if (looksLikeSvg(b)) return 'image/svg+xml';
  return null;
}
