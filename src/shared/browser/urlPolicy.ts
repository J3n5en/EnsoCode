/** 内嵌浏览器允许导航的协议：默认只放 http(s)。file 仅在给定 fileRoot 且路径落在其内时放行。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
// `localhost:3000` 会被 URL 当成 scheme=localhost；只有 `xx://` 或已知的无斜杠协议才算带 scheme
const HAS_SCHEME = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:javascript|data|blob|mailto|about):)/i;

export interface AssertAllowedUrlOptions {
  /** 本地工作区根。传入后允许该根之内的 file:// */
  fileRoot?: string;
}

function posixNorm(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return '';
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return p.startsWith('/') ? `/${parts.join('/')}` : parts.join('/');
}

function isFileInsideRoot(fileUrl: URL, fileRoot: string): boolean {
  if (fileUrl.hostname || /%2f|%5c|%00/i.test(fileUrl.pathname)) return false;
  let abs: string;
  try {
    abs = decodeURIComponent(fileUrl.pathname);
  } catch {
    return false;
  }
  const windows = /^[a-z]:[\\/]/i.test(fileRoot);
  if (!windows && !fileRoot.startsWith('/')) return false;
  if (windows) fileRoot = `/${fileRoot.replace(/\\/g, '/')}`;
  if (fileRoot.includes('\0')) return false;
  const root = posixNorm(fileRoot).replace(/\/+$/, '') || '/';
  const normalized = posixNorm(abs) || '/';
  if (normalized === root) return true;
  const prefix = root === '/' ? '/' : `${root}/`;
  return normalized.startsWith(prefix);
}

/** 用户 / 模型给的字符串 → 可导航 URL；不合法抛 Error（文案给模型看）。 */
export function assertAllowedUrl(raw: string, opts?: AssertAllowedUrlOptions): URL {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('URL is empty.');
  const withScheme = HAS_SCHEME.test(trimmed)
    ? trimmed
    : `${isLoopbackHost(trimmed.split(/[/:?#]/, 1)[0] ?? '') ? 'http' : 'https'}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Invalid URL: ${trimmed}`);
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed.');
  }
  if (url.protocol === 'file:') {
    if (!opts?.fileRoot || !isFileInsideRoot(url, opts.fileRoot)) {
      throw new Error(
        'Security restriction: file: URLs are not allowed. Only http:// and https:// can be opened.'
      );
    }
    return url;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `Security restriction: ${url.protocol} URLs are not allowed. Only http:// and https:// can be opened.`
    );
  }
  if (!url.hostname) throw new Error(`Invalid URL: ${trimmed}`);
  return url;
}

/** localhost / *.localhost / 127.x.x.x / [::1]：默认不需要 origin 审批。 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]' || host === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}
