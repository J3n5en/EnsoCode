import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import * as googleApi from '@earendil-works/pi-ai/api/google-generative-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { providerKeyFor } from '@shared/providers/providerKey';
import type { ProviderProxyConfig } from '@shared/providers/providerProxy';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  registerCustomProviderModels,
  resetCustomProviderRegistryForTests,
  withProviderProxy,
} from './customProviderRegistry';
import { applyWorkerProxyEnv } from './proxyEnv';

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  );
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

async function startProxy() {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const target = new URL(req.url ?? '');
    hits.push(target.host);
    const upstream = request(target, { method: req.method, headers: req.headers }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  return { url: `http://127.0.0.1:${await listen(server)}`, hits, server };
}

/** 只返回 stream / streamSimple 的最小 runtime：registerProvider 后 getProvider 给出指定实现 */
function runtimeWith(streams: Pick<Provider, 'stream' | 'streamSimple'>) {
  const native = new Map<string, Provider>();
  const runtime = {
    getModels: () => [],
    registerProvider: () => {},
    getProvider: (id: string) => ({ id, ...streams }) as unknown as Provider,
    registerNativeProvider: (provider: Provider) => native.set(provider.id, provider),
  } as unknown as ModelRuntime;
  return { runtime, native };
}

const context = {
  messages: [{ role: 'user' as const, content: 'hi', timestamp: Date.now() }],
};

describe('自定义 provider 代理经 dispatcher 生效（真实网络）', () => {
  let target: Server;
  let targetBase: string;
  let globalProxy: Awaited<ReturnType<typeof startProxy>>;
  let custom: Awaited<ReturnType<typeof startProxy>>;
  const previous = getGlobalDispatcher();
  const savedProxy = process.env.HTTP_PROXY;

  beforeAll(async () => {
    target = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'pong' }] }, finishReason: 'STOP' },
          ],
        })}\n\n`
      );
    });
    targetBase = `http://127.0.0.1:${await listen(target)}`;
    [globalProxy, custom] = await Promise.all([startProxy(), startProxy()]);
  });

  afterAll(async () => {
    setGlobalDispatcher(previous);
    if (savedProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = savedProxy;
    await Promise.all([target, globalProxy.server, custom.server].map(close));
  });

  beforeEach(() => {
    resetCustomProviderRegistryForTests();
    globalProxy.hits.length = 0;
    custom.hits.length = 0;
    applyWorkerProxyEnv({ HTTP_PROXY: globalProxy.url, http_proxy: null, NO_PROXY: '' });
  });

  async function runGoogle(
    proxy: ProviderProxyConfig | undefined,
    simple = false,
    extra: Record<string, unknown> = {}
  ) {
    const { runtime, native } = runtimeWith({
      stream: googleApi.stream as Provider['stream'],
      streamSimple: googleApi.streamSimple as Provider['streamSimple'],
    });
    const endpoint = {
      api: 'google-generative-ai' as const,
      baseUrl: targetBase,
      apiKey: 'test-key',
      ...(proxy ? { proxy } : {}),
    };
    registerCustomProviderModels(runtime, endpoint, [{ id: 'gemini-test' }]);
    const providerId = providerKeyFor(endpoint);
    const registered = native.get(providerId);
    if (!registered) throw new Error('native provider missing');
    const model = {
      id: 'gemini-test',
      name: 'gemini-test',
      api: 'google-generative-ai',
      provider: providerId,
      baseUrl: targetBase,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    } as Model<Api>;
    const call = simple ? registered.streamSimple : registered.stream;
    return call
      .call(registered, model, context as never, { apiKey: 'test-key', ...extra } as never)
      .result();
  }

  it('Google 适配器在单商代理下不报「Custom fetch」且经该代理发出', async () => {
    const message = await runGoogle({ mode: 'custom', url: custom.url });
    expect(message.errorMessage ?? '').not.toMatch(/Custom fetch/);
    expect(message.stopReason).toBe('stop');
    expect(custom.hits).toEqual([new URL(targetBase).host]);
    expect(globalProxy.hits).toEqual([]);
  });

  it('streamSimple 出口同样生效；none 直连；未配置时跟随全局', async () => {
    await runGoogle({ mode: 'custom', url: custom.url }, true);
    expect(custom.hits).toHaveLength(1);
    await runGoogle({ mode: 'none' });
    expect(globalProxy.hits).toEqual([]);
    await runGoogle(undefined);
    expect(globalProxy.hits).toEqual([new URL(targetBase).host]);
  });

  it('并发的直连与自定义代理请求互不干扰', async () => {
    await Promise.all([
      runGoogle({ mode: 'custom', url: custom.url }),
      runGoogle({ mode: 'none' }),
      runGoogle({ mode: 'custom', url: custom.url }, true),
    ]);
    expect(custom.hits).toHaveLength(2);
    expect(globalProxy.hits).toEqual([]);
  });

  it('onPayload / onResponse 等调用方钩子回到调用方上下文，钩子里的请求不串到该服务商代理', async () => {
    let hookCalls = 0;
    const hookFetch = async () => {
      hookCalls++;
      await (await fetch(`${targetBase}/hook`)).text();
    };
    await runGoogle({ mode: 'custom', url: custom.url }, false, {
      onPayload: async () => {
        await hookFetch();
        return undefined;
      },
      onResponse: hookFetch,
    });
    expect(custom.hits).toHaveLength(1);
    expect(hookCalls).toBeGreaterThan(0);
    expect(globalProxy.hits).toHaveLength(hookCalls);
  });

  it('跟随全局时 withProviderProxy 原样返回，不额外包装', () => {
    const provider = { id: 'x', stream: () => {}, streamSimple: () => {} } as unknown as Provider;
    expect(withProviderProxy(provider, undefined)).toBe(provider);
    expect(withProviderProxy(provider, { mode: 'none' })).not.toBe(provider);
  });
});
