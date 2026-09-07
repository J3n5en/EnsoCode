import { execFileSync } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import {
  isMagicDnsOnly,
  parseLiteralHost,
  parseRelayHostCache,
  parseResolvConfNameservers,
  parseScutilGlobalNameservers,
  pickRelayConnectAddress,
  type RelayHostAddress,
  shouldSkipRelayLookup,
  shouldUsePinnedRelaySocket,
} from '@enso/pair';
import { saveRelayHostCache } from './pairStore';

export type RelayConnectTarget = {
  hostname: string;
  resolved: RelayHostAddress | null;
  pin: boolean;
};

const cache = new Map<string, RelayHostAddress>();

export function seedRelayHostCache(raw: unknown): void {
  cache.clear();
  for (const [hostname, address] of parseRelayHostCache(raw)) cache.set(hostname, address);
}

export function peekRelayHostCache(): Map<string, RelayHostAddress> {
  return new Map(cache);
}

function rememberHost(hostname: string, resolved: RelayHostAddress): void {
  cache.set(hostname, resolved);
  saveRelayHostCache(cache);
}

export function readSystemNameservers(): string[] {
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('scutil', ['--dns'], {
        encoding: 'utf8',
        timeout: 1_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const servers = parseScutilGlobalNameservers(output);
      if (servers.length) return servers;
    } catch {}
  }
  try {
    return parseResolvConfNameservers(readFileSync('/etc/resolv.conf', 'utf8'));
  } catch {
    return [];
  }
}

async function defaultLookup(hostname: string): Promise<RelayHostAddress> {
  const result = await dnsLookup(hostname, { all: false });
  return { address: result.address, family: result.family === 6 ? 6 : 4 };
}

export async function resolveRelayConnectTarget(
  hostname: string,
  deps?: {
    readNameservers?: () => readonly string[];
    lookup?: (hostname: string) => Promise<RelayHostAddress> | RelayHostAddress;
  }
): Promise<RelayConnectTarget> {
  const literal = parseLiteralHost(hostname);
  if (literal) return { hostname, resolved: literal, pin: false };

  const cached = cache.get(hostname) ?? null;
  const nameservers = (deps?.readNameservers ?? readSystemNameservers)();
  const skipLookup = shouldSkipRelayLookup(cached !== null, isMagicDnsOnly(nameservers));
  let lookupFailed = false;
  let resolved: RelayHostAddress | null = null;
  if (!skipLookup) {
    try {
      resolved = await (deps?.lookup ?? defaultLookup)(hostname);
      if (resolved) rememberHost(hostname, resolved);
    } catch {
      lookupFailed = true;
    }
  }
  const picked = pickRelayConnectAddress({
    hostname,
    cache: cached,
    lookup: resolved,
    skipLookup,
  });
  return {
    hostname,
    resolved: picked,
    pin: shouldUsePinnedRelaySocket({
      hostname,
      resolved: picked,
      skipLookup,
      lookupFailed,
    }),
  };
}
