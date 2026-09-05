/**
 * Markdown 预览远程图片的 SSRF 防护：结构层面的初筛（协议、字面量 IP、常见内网别名）。
 * 主进程实际发起请求前，还要用 `dns.lookup` 的自定义解析回调对每次连接的真实 IP
 * 再判一次（防 DNS rebinding：域名首次解析时是公网 IP，连接时改指向内网）。
 */

const PRIVATE_HOSTNAMES = new Set(['localhost', '0.0.0.0']);

function toIpv4Parts(ip: string): number[] | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return null;
  return parts;
}

/** RFC1918 私网、环回、链路本地（含云元数据端点 169.254.169.254）、CGNAT、0.0.0.0/8 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = toIpv4Parts(ip);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** 环回 ::1、链路本地 fe80::/10、唯一本地 fc00::/7、IPv4 映射地址回退到 IPv4 规则 */
export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fe9')) return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  return ip.includes(':') ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * URL 结构层面判断是否允许作为 Markdown 预览的远程图片来源：
 * - 只认 http/https
 * - 不带用户名密码
 * - 主机名非空、不是 localhost / *.local
 * - 字面量 IP（IPv4/IPv6）不能落在私有/保留段
 *
 * 通过这一关不代表最终允许连接——DNS 解析出的真实 IP 仍要在连接前再查一次。
 */
export function isAllowedRemoteImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const hostname = stripBrackets(url.hostname.toLowerCase());
  if (!hostname) return false;
  if (PRIVATE_HOSTNAMES.has(hostname)) return false;
  if (hostname.endsWith('.local')) return false;
  if (isPrivateOrReservedIp(hostname)) return false;
  return true;
}
