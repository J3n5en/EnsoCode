/**
 * 仅限 Node 进程（agent worker / 记忆服务 / 服务器宿主）：按服务商代理策略复用 undici dispatcher。
 * Renderer 不得 import。
 */
import { Agent, type Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici';
import type { ProviderProxyConfig } from './providerProxy';

const TIMEOUTS = { headersTimeout: 0, bodyTimeout: 0 } as const;
/** 自定义代理按 URL 复用；超出上限关掉最久未用的，避免改来改去的地址泄漏连接池。 */
const MAX_CUSTOM_DISPATCHERS = 16;

let direct: Agent | undefined;
const custom = new Map<string, ProxyAgent>();

export function providerProxyDispatcher(proxy: ProviderProxyConfig): Dispatcher {
  if (proxy.mode === 'none') {
    direct ??= new Agent(TIMEOUTS);
    return direct;
  }
  const cached = custom.get(proxy.url);
  if (cached) {
    custom.delete(proxy.url);
    custom.set(proxy.url, cached);
    return cached;
  }
  const agent = new ProxyAgent({ uri: proxy.url, ...TIMEOUTS });
  custom.set(proxy.url, agent);
  if (custom.size > MAX_CUSTOM_DISPATCHERS) {
    const [oldest, stale] = custom.entries().next().value as [string, ProxyAgent];
    custom.delete(oldest);
    // close 等在途请求结束再断开，不打断仍在跑的流
    void stale.close().catch(() => {});
  }
  return agent;
}

/** 跟随全局时返回 undefined，调用方继续用自己的默认 fetch。 */
export function providerProxyFetch(
  proxy: ProviderProxyConfig | undefined
): typeof fetch | undefined {
  if (!proxy) return undefined;
  return ((input: string | URL | Request, init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: providerProxyDispatcher(proxy),
    })) as unknown as typeof fetch;
}

export function providerProxyDispatcherCountForTests(): number {
  return custom.size;
}
