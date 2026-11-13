/**
 * Files 面板 Markdown 预览的图片资源解析：
 * - 判断 img src 是否已是远程/data URL（这类交给渲染层原样处理，不走工作区读取）
 * - 把相对路径解析到 Markdown 文件所在目录，越权（逃出工作区根）拒绝
 * - 位图扩展名白名单（含 svg：只作为 <img src> 的二进制载体，浏览器图片上下文隔离使其内嵌脚本不执行）
 */

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  // svg 支持：仅因为整条链路自始至终只把它当 <img src> 的二进制载体用（从不用
  // dangerouslySetInnerHTML/内联 <svg>/object/embed/iframe）——浏览器对作为图片
  // 加载的 SVG 实施“图片上下文”隔离（禁脚本/禁外部资源拉取/交互失效），
  // 内容是否带 <script>/onload 不影响安全。真正的内容验证在 shared/imageSniff.ts。
  svg: 'image/svg+xml',
};

/** 预览图片主进程读盘上限（字节） */
export const PREVIEW_IMAGE_MAX_BYTES = 5_000_000;

/** 是否已带协议（http/https/data/协议相对 `//`）——这类不经工作区解析 */
export function isRemoteOrDataImageSrc(src: string): boolean {
  if (src.startsWith('//')) return true;
  const colon = src.indexOf(':');
  if (colon < 0) return false;
  const slash = src.indexOf('/');
  const question = src.indexOf('?');
  const hash = src.indexOf('#');
  if (slash > -1 && colon > slash) return false;
  if (question > -1 && colon > question) return false;
  if (hash > -1 && colon > hash) return false;
  return true;
}

/**
 * 把 Markdown 里的相对图片 src 解析为工作区相对路径。
 * - `baseDirRel` 是当前 Markdown 文件所在目录（工作区相对，"" 为根）
 * - 以 `/` 开头视为工作区根相对路径
 * - `..` 允许在工作区内向上跳转，逃出根则拒绝（返回 null）
 * - 远程/data URL、含反斜杠或 NUL 的非法输入也返回 null
 * - src 按段做 %XX 解码，解不出合法 UTF-8 或解出分隔符/NUL 的返回 null
 */
export function resolvePreviewImageRel(baseDirRel: string, src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed || isRemoteOrDataImageSrc(trimmed)) return null;
  if (trimmed.includes('\\') || trimmed.includes('\0')) return null;
  const withoutFragment = trimmed.split(/[?#]/)[0];
  if (!withoutFragment) return null;
  // baseDirRel 是真实路径，只解码 src 部分
  const decoded = decodeSrcPath(withoutFragment);
  if (decoded === null) return null;
  const rooted = decoded.startsWith('/');
  const joined = rooted ? decoded.slice(1) : posixJoin(baseDirRel, decoded);
  const stack: string[] = [];
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

/**
 * mdast-util-to-hast 会对 Markdown 图片地址做 normalizeUri（中文、空格等转成 %XX），不解码读盘
 * 只会 ENOENT。只解合法的 %XX：原始 HTML 的 <img> 不经 normalizeUri，字面 `%` 就是文件名字符。
 * 解出 `/`、`\`、NUL 的段直接拒绝，否则 `..%2F` 之类会绕过后面的分段与穿越校验。
 */
function decodeSrcPath(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    let decoded: string;
    try {
      decoded = segment.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => decodeURIComponent(run));
    } catch {
      return null;
    }
    if (/[/\\\0]/.test(decoded)) return null;
    segments.push(decoded);
  }
  return segments.join('/');
}

function posixJoin(dir: string, rel: string): string {
  return dir ? `${dir}/${rel}` : rel;
}

export type PreviewImageSrcKind = 'local' | 'remote' | 'data' | 'unsupported';

/**
 * 判断 Markdown 里的 img src 属于哪种来源，决定预览时走哪条解析链路：
 * - `local`：相对路径，走工作区文件读取（`resolvePreviewImageRel` + `files:read-image`）
 * - `remote`：http(s) 或协议相对 URL，走主进程带 SSRF 防护的代理读取
 * - `data`：已是静态资源，无需再取（sanitize 阶段已拒非位图 mime）
 * - `unsupported`：其他协议（mailto: 等）或空字符串，不尝试加载
 */
export function classifyPreviewImageSrc(src: string): PreviewImageSrcKind {
  const trimmed = src.trim();
  if (!trimmed) return 'unsupported';
  if (trimmed.startsWith('data:')) return 'data';
  if (trimmed.startsWith('//') || /^https?:\/\//i.test(trimmed)) return 'remote';
  if (isRemoteOrDataImageSrc(trimmed)) return 'unsupported';
  return 'local';
}

/** 协议相对 URL（`//host/x`）补上 `https:`；已带协议的原样返回 */
export function normalizeRemoteImageUrl(src: string): string {
  return src.startsWith('//') ? `https:${src}` : src;
}

/** 位图扩展名白名单对应的 mime；不支持（含 svg）返回 null */
export function previewImageMime(rel: string): string | null {
  const clean = rel.split(/[?#]/)[0] ?? '';
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = clean.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}
