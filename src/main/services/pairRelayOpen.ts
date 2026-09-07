import { Agent, WebSocket as UndiciWebSocket } from 'undici';
import { type RelayConnectTarget, resolveRelayConnectTarget } from './pairRelayLookup';
import { buildPinnedRelaySocketUrl } from './pairRelaySocket';

export async function openPairRelayWebSocket(
  url: string,
  deps?: {
    resolveTarget?: (hostname: string) => Promise<RelayConnectTarget>;
    openNamed?: (url: string) => WebSocket;
    openPinned?: (url: string, servername: string, port: string) => WebSocket;
  }
): Promise<WebSocket> {
  const parsed = new URL(url);
  const target = await (deps?.resolveTarget ?? resolveRelayConnectTarget)(parsed.hostname);
  if (target.pin && target.resolved) {
    const pinned = buildPinnedRelaySocketUrl(parsed, target.resolved);
    return (deps?.openPinned ?? defaultOpenPinned)(pinned.href, target.hostname, parsed.port);
  }
  return (deps?.openNamed ?? defaultOpenNamed)(url);
}

function defaultOpenNamed(url: string): WebSocket {
  return new WebSocket(url);
}

/** 钉 IP 时必须自带 SNI / Host，否则证书对不上。走 undici，避开 Chromium 按 IP 校验。 */
function defaultOpenPinned(url: string, servername: string, _port: string): WebSocket {
  const dispatcher = new Agent({
    connect: { servername },
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  const ws = new UndiciWebSocket(url, {
    dispatcher,
    headers: { host: servername },
  });
  const closeAgent = (): void => {
    void dispatcher.close();
  };
  ws.addEventListener('close', closeAgent);
  ws.addEventListener('error', closeAgent);
  return ws as unknown as WebSocket;
}
