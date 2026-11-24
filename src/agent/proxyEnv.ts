import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProviderProxyConfig } from '@shared/providers/providerProxy';
import { providerProxyDispatcher } from '@shared/providers/providerProxyDispatcher';
import { Agent, Dispatcher, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

const TIMEOUTS = { headersTimeout: 0, bodyTimeout: 0 } as const;

const providerProxyContext = new AsyncLocalStorage<ProviderProxyConfig | undefined>();
/** 全局代理（随 set-proxy-env 热切换）；路由器无服务商上下文时转发到这里。 */
let globalDispatcher: Dispatcher | undefined;
let router: ProviderProxyRouter | undefined;

/**
 * pi-ai 的 Google 适配器拒绝自定义 options.fetch，单商代理只能在全局 dispatcher 层分流：
 * 按 AsyncLocalStorage 里的服务商代理选直连 Agent / ProxyAgent，没有上下文时走全局代理。
 */
class ProviderProxyRouter extends Dispatcher {
  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler
  ): boolean {
    const proxy = providerProxyContext.getStore();
    globalDispatcher ??= new Agent(TIMEOUTS);
    const target = proxy ? providerProxyDispatcher(proxy) : globalDispatcher;
    return target.dispatch(options, handler);
  }
}

/** fn 内同步与其派生的异步请求（流式读取、SDK 重试）都按该服务商代理发送。 */
export function runWithProviderProxy<T>(proxy: ProviderProxyConfig | undefined, fn: () => T): T {
  return providerProxyContext.run(proxy, fn);
}

const CALLER_HOOKS = ['onPayload', 'onResponse', 'onProviderStreamEvent'] as const;

/** 调用方钩子（扩展的 before_provider_request 等）回到调用方上下文执行，钩子里的请求不继承服务商代理。 */
export function withCallerHooks<T>(options: T): T {
  if (!options || typeof options !== 'object') return options;
  const caller = AsyncLocalStorage.snapshot();
  const record = options as Record<string, unknown>;
  const wrapped: Record<string, unknown> = { ...record };
  for (const name of CALLER_HOOKS) {
    const hook = record[name];
    if (typeof hook === 'function') {
      wrapped[name] = (...args: unknown[]) => caller(() => hook(...args));
    }
  }
  return wrapped as T;
}

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
  globalDispatcher = proxyUrl
    ? new EnvHttpProxyAgent({
        httpProxy: proxyUrl,
        httpsProxy: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? proxyUrl,
        noProxy,
        ...TIMEOUTS,
      })
    : new Agent(TIMEOUTS);
  router ??= new ProviderProxyRouter();
  setGlobalDispatcher(router);
}
