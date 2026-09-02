/** 内嵌浏览器允许导航的协议：只放 http(s)。file/javascript/enso/chrome 等一律拒。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
// `localhost:3000` 会被 URL 当成 scheme=localhost；只有 `xx://` 或已知的无斜杠协议才算带 scheme
const HAS_SCHEME = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:javascript|data|blob|mailto|about):)/i;

/** 用户 / 模型给的字符串 → 可导航 URL；不合法抛 Error（文案给模型看）。 */
export function assertAllowedUrl(raw: string): URL {
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
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `Security restriction: ${url.protocol} URLs are not allowed. Only http:// and https:// can be opened.`
    );
  }
  if (!url.hostname) throw new Error(`Invalid URL: ${trimmed}`);
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed.');
  }
  return url;
}

/** localhost / *.localhost / 127.x.x.x / [::1]：默认不需要 origin 审批。 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]' || host === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}
