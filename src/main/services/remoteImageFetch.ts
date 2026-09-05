import { lookup as dnsLookup } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { sniffImageMime } from '@shared/imageSniff';
import { isAllowedRemoteImageUrl, isPrivateOrReservedIp } from '@shared/remoteImageGuard';

/**
 * Files 面板 Markdown 预览的远程图片代理：主进程发起请求，带 SSRF 防护，返回 data URL。
 *
 * 防护点：
 * - 协议/字面量 IP/常见内网别名（`isAllowedRemoteImageUrl`）先过一遍；
 * - 域名解析成 IP 后，连接前**用解析出的真实 IP 再判一次**，并直接拿这个 IP 建立
 *   连接（不再让 TCP 层用主机名二次解析）——防 DNS rebinding：域名首次解析是公网 IP，
 *   连接那一刻悄悄改成内网 IP；
 * - 重定向逐跳重新校验 URL 与解析地址，跳数封顶；
 * - 响应 Content-Type 只认位图白名单（不含 svg），大小在声明头与实际接收两处都设上限。
 */

export const REMOTE_IMAGE_MAX_BYTES = 5_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;

// 含 svg：返回值总是 data URL，只会被渲染成 <img src>（见 filePreviewMarkdown.tsx），
// 浏览器对图片上下文的 SVG 隔离使内嵌脚本不执行。
const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
  'image/svg+xml',
]);

export type RemoteImageFetchResult = { ok: true; dataUrl: string } | { ok: false; error: string };

export interface RemoteImageFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  isAllowedUrl?: (url: string) => boolean;
  isAllowedAddress?: (ip: string) => boolean;
  /** 域名 \u2192 IP；默认走系统 DNS。测试用来模拟 DNS rebinding 而不依赖真实网络 */
  resolveHost?: (hostname: string) => Promise<string>;
}

function defaultResolveHost(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, (err, address) => {
      if (err) reject(err);
      else resolve(address);
    });
  });
}

export async function fetchRemoteImageDataUrl(
  url: string,
  options: RemoteImageFetchOptions = {}
): Promise<RemoteImageFetchResult> {
  const {
    maxBytes = REMOTE_IMAGE_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    isAllowedUrl = isAllowedRemoteImageUrl,
    isAllowedAddress = (ip: string) => !isPrivateOrReservedIp(ip),
    resolveHost = defaultResolveHost,
  } = options;

  let current = url;
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (!isAllowedUrl(current)) return { ok: false, error: 'blocked-address' };
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return { ok: false, error: 'invalid-url' };
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    let address: string;
    try {
      address = isIP(hostname) ? hostname : await resolveHost(hostname);
    } catch {
      return { ok: false, error: 'unavailable' };
    }
    if (!isAllowedAddress(address)) return { ok: false, error: 'blocked-address' };
    const result = await fetchOnce(parsed, address, { maxBytes, timeoutMs });
    if (result.kind === 'redirect') {
      current = new URL(result.location, parsed).toString();
      continue;
    }
    return result.kind === 'ok'
      ? { ok: true, dataUrl: result.dataUrl }
      : { ok: false, error: result.error };
  }
  return { ok: false, error: 'too-many-redirects' };
}

type FetchOnceResult =
  | { kind: 'ok'; dataUrl: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'error'; error: string };

/** 直连已校验的 `address`（不再让 TCP 层按主机名二次解析），Host/SNI 仍用原始主机名 */
function fetchOnce(
  parsed: URL,
  address: string,
  opts: { maxBytes: number; timeoutMs: number }
): Promise<FetchOnceResult> {
  return new Promise((resolve) => {
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;
    let settled = false;
    const finish = (result: FetchOnceResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = client.get(
      {
        protocol: parsed.protocol,
        hostname: address,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: { Host: parsed.hostname },
        ...(isHttps ? { servername: parsed.hostname } : {}),
        timeout: opts.timeoutMs,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          const location = res.headers.location;
          res.resume();
          finish({ kind: 'redirect', location });
          return;
        }
        if (status !== 200) {
          res.resume();
          finish({ kind: 'error', error: 'unavailable' });
          return;
        }
        const contentType = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
          res.resume();
          finish({ kind: 'error', error: 'unsupported' });
          return;
        }
        const declaredLength = Number(res.headers['content-length'] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > opts.maxBytes) {
          res.destroy();
          finish({ kind: 'error', error: 'too-large' });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > opts.maxBytes) {
            res.destroy();
            finish({ kind: 'error', error: 'too-large' });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          // 不信任服务器声明的 Content-Type：内容魔数必须与它匹配，防服务端把 SVG/HTML 假装成位图 MIME
          if (sniffImageMime(buf) !== contentType) {
            finish({ kind: 'error', error: 'unsupported' });
            return;
          }
          finish({ kind: 'ok', dataUrl: `data:${contentType};base64,${buf.toString('base64')}` });
        });
        res.on('error', () => finish({ kind: 'error', error: 'unavailable' }));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      finish({ kind: 'error', error: 'timeout' });
    });
    req.on('error', () => finish({ kind: 'error', error: 'unavailable' }));
  });
}
