export type ProxyMode = 'system' | 'none' | 'custom';

export const PROXY_MODES = ['system', 'none', 'custom'] as const;

export const DEFAULT_NO_PROXY =
  'localhost, 127.0.0.1, ::1, 192.168.*.*, 10.*.*.*, *.local, host.docker.internal';

export const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'GRPC_PROXY',
  'grpc_proxy',
  'no_proxy',
  'NO_PROXY',
] as const;

export type ProxyEnvKey = (typeof PROXY_ENV_KEYS)[number];
export type ProxyEnvPatch = Record<ProxyEnvKey, string | null>;

export function normalizeProxyMode(value: unknown): ProxyMode {
  return value === 'none' || value === 'custom' || value === 'system' ? value : 'system';
}

export function mergeNoProxy(defaultNoProxy: string, inheritedNoProxy: string): string {
  if (!inheritedNoProxy.trim()) return defaultNoProxy;
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of `${defaultNoProxy},${inheritedNoProxy}`.split(',')) {
    const item = raw.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    items.push(item);
  }
  return items.join(', ');
}

export function parseResolveProxy(proxyString: string): string | null {
  const first = proxyString.split(';')[0]?.trim() ?? '';
  if (!first) return null;
  const [protocol, address] = first.split(/\s+/);
  const host = address?.trim();
  if (!host) return null;
  if (protocol === 'PROXY') return `http://${host}`;
  if (protocol === 'HTTPS') return `https://${host}`;
  return null;
}

export function isValidProxyUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function proxyEnvPatch(proxyUrl: string | null, noProxy: string): ProxyEnvPatch {
  if (!proxyUrl) {
    return Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, null])) as ProxyEnvPatch;
  }
  return {
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    GRPC_PROXY: proxyUrl,
    grpc_proxy: proxyUrl,
    no_proxy: noProxy,
    NO_PROXY: noProxy,
  };
}
