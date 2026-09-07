/** VPN 掉线后的即时唤醒：网卡指纹、拆半开 socket、避开死掉的 MagicDNS。 */

export const TAILSCALE_MAGIC_DNS = '100.100.100.100';

export type NudgeReason = 'resume' | 'online' | 'network-change' | 'visibility';

export type RelayHostAddress = { address: string; family: 4 | 6 };

export type NetworkInterfaceAddress = {
  address: string;
  family: string | number;
  internal: boolean;
};

export type NetworkInterfaceSnapshot = Record<string, NetworkInterfaceAddress[] | undefined>;

function familyLabel(family: string | number): 'IPv4' | 'IPv6' {
  return family === 6 || family === 'IPv6' ? 'IPv6' : 'IPv4';
}

function isLinkLocalIPv6(address: string, family: 'IPv4' | 'IPv6'): boolean {
  return family === 'IPv6' && address.toLowerCase().startsWith('fe80:');
}

/** 非回环、非链路本地地址的稳定指纹。VPN utun 增减会变。 */
export function networkFingerprint(nics: NetworkInterfaceSnapshot): string {
  const rows: string[] = [];
  for (const [name, addrs] of Object.entries(nics)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      const family = familyLabel(addr.family);
      if (isLinkLocalIPv6(addr.address, family)) continue;
      rows.push(`${name}|${family}|${addr.address}`);
    }
  }
  rows.sort();
  return rows.join(';');
}

/** 链路已死但 close 不来时：网络切换 / 重新上线拆旧 socket，睡眠与回前台只 ping。 */
export function shouldReplaceOnNudge(reason: NudgeReason, hasSocket: boolean): boolean {
  if (!hasSocket) return true;
  return reason === 'network-change' || reason === 'online';
}

export function isMagicDnsOnly(nameservers: readonly string[]): boolean {
  return nameservers.length > 0 && nameservers.every((ns) => ns === TAILSCALE_MAGIC_DNS);
}

export function shouldSkipRelayLookup(hasCache: boolean, magicDnsOnly: boolean): boolean {
  return hasCache && magicDnsOnly;
}

export function parseLiteralHost(hostname: string): RelayHostAddress | null {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return { address: host, family: 4 };
  if (host.includes(':') && !host.includes('.')) return { address: host, family: 6 };
  return null;
}

/** 只读 scutil 的全局段，scoped 查询常残留已死隧道的 DNS。 */
export function parseScutilGlobalNameservers(output: string): string[] {
  const scoped = output.indexOf('\nDNS configuration (for scoped queries)');
  const global = scoped === -1 ? output : output.slice(0, scoped);
  return [
    ...new Set(Array.from(global.matchAll(/nameserver\[\d+\]\s*:\s*(\S+)/g), (match) => match[1])),
  ];
}

export function parseResolvConfNameservers(text: string): string[] {
  const servers: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*nameserver\s+(\S+)/.exec(line);
    if (match) servers.push(match[1]);
  }
  return [...new Set(servers)];
}

/** Chromium WebSocket 默认走系统代理；只有 DNS 挂了才钉 IP，避免平时绕过代理。 */
export function shouldUsePinnedRelaySocket(input: {
  hostname: string;
  resolved: RelayHostAddress | null;
  skipLookup: boolean;
  lookupFailed: boolean;
}): boolean {
  if (!input.resolved || parseLiteralHost(input.hostname)) return false;
  return input.skipLookup || input.lookupFailed;
}

export function pickRelayConnectAddress(input: {
  hostname: string;
  cache: RelayHostAddress | null;
  lookup: RelayHostAddress | null;
  skipLookup: boolean;
}): RelayHostAddress | null {
  const literal = parseLiteralHost(input.hostname);
  if (literal) return literal;
  if (input.skipLookup) return input.cache;
  return input.lookup ?? input.cache;
}

function isRelayHostAddress(value: unknown): value is RelayHostAddress {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { address?: unknown; family?: unknown };
  if (record.family !== 4 && record.family !== 6) return false;
  if (typeof record.address !== 'string') return false;
  return parseLiteralHost(record.family === 6 ? `[${record.address}]` : record.address) !== null;
}

export function parseRelayHostCache(raw: unknown): Map<string, RelayHostAddress> {
  const cache = new Map<string, RelayHostAddress>();
  if (typeof raw !== 'object' || raw === null) return cache;
  for (const [hostname, value] of Object.entries(raw)) {
    if (!hostname || parseLiteralHost(hostname)) continue;
    if (isRelayHostAddress(value)) cache.set(hostname, value);
  }
  return cache;
}

export function serializeRelayHostCache(cache: Map<string, RelayHostAddress>): string {
  return JSON.stringify(Object.fromEntries(cache));
}

export function createCachedHostLookup(deps: {
  cache: Map<string, RelayHostAddress>;
  readNameservers: () => readonly string[];
  lookup: (hostname: string) => Promise<RelayHostAddress> | RelayHostAddress;
}): (hostname: string) => Promise<RelayHostAddress | null> {
  return async (hostname) => {
    const cache = deps.cache.get(hostname) ?? null;
    const skipLookup = shouldSkipRelayLookup(
      cache !== null,
      isMagicDnsOnly(deps.readNameservers())
    );
    let resolved: RelayHostAddress | null = null;
    if (!skipLookup && !parseLiteralHost(hostname)) {
      try {
        resolved = await deps.lookup(hostname);
        if (resolved) deps.cache.set(hostname, resolved);
      } catch {
        resolved = null;
      }
    }
    return pickRelayConnectAddress({ hostname, cache, lookup: resolved, skipLookup });
  };
}
