import { isIP } from 'node:net';
import { Agent, type Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici';

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

interface NoProxyEntry {
  hostname: string;
  port: number;
  wildcard: boolean;
}

/** 与 undici EnvHttpProxyAgent 同一套 NO_PROXY 语法。 */
function parseNoProxy(value: string): NoProxyEntry[] {
  const entries: NoProxyEntry[] = [];
  for (const raw of value.split(/[,\s]/)) {
    if (!raw) continue;
    let hostname: string;
    let port = 0;
    const ipv6WithPort = /^\[(.+)\]:(\d+)$/.exec(raw);
    if (ipv6WithPort) {
      hostname = ipv6WithPort[1];
      port = Number.parseInt(ipv6WithPort[2], 10);
    } else {
      const unbracketed = raw.replace(/^\[(.+)\]$/, '$1');
      const colonCount = unbracketed.match(/:/g)?.length ?? 0;
      const parsed = colonCount === 1 ? /^(.+):(\d+)$/.exec(unbracketed) : null;
      hostname = parsed?.[1] ?? unbracketed;
      port = parsed ? Number.parseInt(parsed[2], 10) : 0;
    }
    entries.push({
      hostname: hostname
        .replace(/^\*?\./, '')
        .replace(/^(.+)\.$/, '$1')
        .toLowerCase(),
      port,
      wildcard: raw.charCodeAt(0) === 42,
    });
  }
  return entries;
}

function requestHostPort(url: URL): { hostname: string; port: number } {
  let hostname = url.host
    .replace(/:\d*$/, '')
    .replace(/^\[(.+)\]$/, '$1')
    .toLowerCase();
  if (hostname.length > 1 && hostname.charCodeAt(hostname.length - 1) === 46) {
    hostname = hostname.slice(0, -1);
  }
  const port = Number.parseInt(url.port, 10) || DEFAULT_PORTS[url.protocol] || 0;
  return { hostname, port };
}

function shouldProxy(url: URL, noProxy: string): boolean {
  const entries = parseNoProxy(noProxy);
  if (entries.length === 0) return true;
  const { hostname, port } = requestHostPort(url);
  for (const entry of entries) {
    if (entry.hostname === '*') {
      if (entry.port && entry.port !== port) continue;
      return false;
    }
    if (entry.port && entry.port !== port) continue;
    if (!entry.wildcard && hostname === entry.hostname) return false;
    if (hostname.slice(-(entry.hostname.length + 1)) === `.${entry.hostname}`) return false;
  }
  return true;
}

/**
 * 与 EnvHttpProxyAgent 相同的代理选择：小写环境变量优先，https 可回退到 HTTP_PROXY，
 * 只配置了 HTTPS_PROXY 时 http 直连。返回 null 表示这一跳不走代理。
 */
export function selectWebFetchProxy(url: URL, env: NodeJS.ProcessEnv = process.env): string | null {
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? '';
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY ?? '';
  const noProxy = env.no_proxy ?? env.NO_PROXY ?? '';
  if (!shouldProxy(url, noProxy)) return null;
  if (url.protocol === 'https:') return httpsProxy || httpProxy || null;
  if (url.protocol === 'http:') return httpProxy || null;
  return null;
}

function orderConnectAddresses(addresses: readonly string[]): string[] {
  return addresses
    .map((address, index) => ({ address, index, v4: isIP(address) === 4 }))
    .sort((a, b) => Number(b.v4) - Number(a.v4) || a.index - b.index)
    .map((item) => item.address);
}

function pinnedAgent(url: URL, address: string): Agent {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(address);
  const lookup = ((
    _host: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void
  ) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as never;
  return new Agent({
    connect: {
      lookup,
      ...(url.protocol === 'https:' && !isIP(hostname) ? { servername: hostname } : {}),
    },
  });
}

function isAbortError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (
      current instanceof Error &&
      (current.name === 'AbortError' || current.name === 'TimeoutError')
    ) {
      return true;
    }
    const code = (current as { code?: string }).code;
    if (code === 'UND_ERR_ABORTED' || code === 'ABORT_ERR') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function undiciRequest(
  url: string,
  init: RequestInit,
  dispatcher: Dispatcher
): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher } as Parameters<
    typeof undiciFetch
  >[1]) as unknown as Promise<Response>;
}

/**
 * 走代理时把原主机名交给代理（https 为 CONNECT 主机名，http 为普通转发、不建隧道）。
 * 直连才固定到已校验地址，IPv4 优先，只有连接失败才换下一个。
 */
export async function fetchWebResource(
  url: URL,
  addresses: readonly string[],
  init: RequestInit,
  onDispatcher: (dispatcher: Dispatcher) => void
): Promise<Response> {
  const proxy = selectWebFetchProxy(url);
  if (proxy) {
    const dispatcher = new ProxyAgent({ uri: proxy });
    onDispatcher(dispatcher);
    return undiciRequest(url.href, init, dispatcher);
  }
  const ordered = orderConnectAddresses(addresses).filter((address) => isIP(address) !== 0);
  let last: unknown;
  for (let i = 0; i < ordered.length; i++) {
    const dispatcher = pinnedAgent(url, ordered[i]);
    onDispatcher(dispatcher);
    try {
      return await undiciRequest(url.href, init, dispatcher);
    } catch (error) {
      last = error;
      if (i === ordered.length - 1 || isAbortError(error)) throw error;
    }
  }
  throw last instanceof Error ? last : new Error('No validated address to connect');
}
