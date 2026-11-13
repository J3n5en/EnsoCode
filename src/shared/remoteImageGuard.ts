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

/**
 * 展开成 8 个 16 位分组再判断：同一地址有压缩、完整展开、末尾点分 IPv4 等多种写法，
 * WHATWG URL 还会把 `::ffff:127.0.0.1` 规范成 `::ffff:7f00:1`，按字符串匹配必然漏掉某种写法。
 */
function toIpv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = toIpv4Parts(tail);
    if (!v4) return null;
    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const zeros = 8 - head.length - rest.length;
  if (halves.length === 2 ? zeros < 1 : zeros !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? zeros : 0).fill('0'), ...rest];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * 链路本地 fe80::/10、唯一本地 fc00::/7；内嵌 IPv4 的三类前缀还原成 IPv4 走同一套私网判断：
 * IPv4 兼容 ::/96（`::`、`::1` 还原成 0.0.0.0/8 一并拦下）、IPv4 映射 ::ffff:0:0/96、
 * NAT64 64:ff9b::/96（DNS64 网络靠它访问公网 IPv4，不能整段拒绝）。
 */
export function isPrivateIPv6(ip: string): boolean {
  const groups = toIpv6Groups(ip);
  // 真实调用方给的都是 URL / DNS 规范化过的地址，解析不了说明形态异常，不放行
  if (!groups) return true;
  const [first, second] = groups;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  const embedsIpv4 =
    (zeros(0, 5) && (groups[5] === 0 || groups[5] === 0xffff)) ||
    (first === 0x64 && second === 0xff9b && zeros(2, 6));
  if (!embedsIpv4) return false;
  const [high, low] = [groups[6], groups[7]];
  return isPrivateIPv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
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
