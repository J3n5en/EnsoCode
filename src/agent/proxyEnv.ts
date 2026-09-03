import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

const TIMEOUTS = { headersTimeout: 0, bodyTimeout: 0 } as const;

export function applyWorkerProxyEnv(env: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  const proxyUrl = process.env.HTTP_PROXY ?? process.env.http_proxy ?? null;
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  if (proxyUrl) {
    setGlobalDispatcher(
      new EnvHttpProxyAgent({
        httpProxy: proxyUrl,
        httpsProxy: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? proxyUrl,
        noProxy,
        ...TIMEOUTS,
      })
    );
    return;
  }
  setGlobalDispatcher(new Agent(TIMEOUTS));
}
