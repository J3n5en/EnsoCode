import type { RelayHostAddress } from '@enso/pair';

export function relaySocketConnectHost(
  hostname: string,
  resolved: RelayHostAddress | null
): string {
  if (!resolved) return hostname;
  return resolved.family === 6 ? `[${resolved.address}]` : resolved.address;
}

export function buildPinnedRelaySocketUrl(url: URL, resolved: RelayHostAddress): URL {
  const next = new URL(url);
  next.hostname = relaySocketConnectHost(url.hostname, resolved);
  return next;
}
