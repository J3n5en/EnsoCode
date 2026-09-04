import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

const TIMEOUTS = { headersTimeout: 0, bodyTimeout: 0 } as const;

/**
 * worker 启动自举：按 fork 时继承的 HTTP_PROXY / NO_PROXY 装 undici dispatcher。
 * Node fetch 默认不读代理 env；main 在 worker 存在前下发的 set-proxy-env 又会被丢，
 * 不在这里自举，冷启动后 LLM 请求就一直直连。
 */
export function bootstrapWorkerProxyFromEnv(): void {
  applyWorkerProxyEnv({});
}

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
