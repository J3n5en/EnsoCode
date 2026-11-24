import { createServer, request, type Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyWorkerProxyEnv, runWithProviderProxy } from './proxyEnv';

const ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];

interface ProxyServer {
  url: string;
  hits: string[];
  server: Server;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  );
}

/** 记录转发目标（绝对 URI 转发或 CONNECT 隧道）的最小 HTTP 代理 */
async function startProxy(): Promise<ProxyServer> {
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
  server.on('connect', (req, socket, head) => {
    hits.push(req.url ?? '');
    const [host, port] = (req.url ?? '').split(':');
    const upstream = connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, hits, server };
}

const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

describe('worker 全局 dispatcher 按服务商代理分流', () => {
  let target: Server;
  let targetUrl: string;
  let targetHits = 0;
  let globalProxy: ProxyServer;
  let customA: ProxyServer;
  let customB: ProxyServer;
  const previous = getGlobalDispatcher();
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    target = createServer((_req, res) => {
      targetHits++;
      res.end('ok');
    });
    targetUrl = `http://127.0.0.1:${await listen(target)}/`;
    [globalProxy, customA, customB] = await Promise.all([startProxy(), startProxy(), startProxy()]);
  });

  afterAll(async () => {
    setGlobalDispatcher(previous);
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await Promise.all([target, globalProxy.server, customA.server, customB.server].map(close));
  });

  beforeEach(() => {
    targetHits = 0;
    for (const proxy of [globalProxy, customA, customB]) proxy.hits.length = 0;
    applyWorkerProxyEnv({
      HTTP_PROXY: globalProxy.url,
      http_proxy: null,
      HTTPS_PROXY: null,
      https_proxy: null,
      NO_PROXY: '',
      no_proxy: null,
    });
  });

  const get = async () => (await fetch(targetUrl, { signal: AbortSignal.timeout(3000) })).text();
  const host = () => new URL(targetUrl).host;

  it('没有服务商上下文时跟随全局代理', async () => {
    expect(await get()).toBe('ok');
    expect(globalProxy.hits).toEqual([host()]);
    expect(customA.hits).toEqual([]);
  });

  it('全局代理热切换为直连后，未配置的服务商随之直连', async () => {
    applyWorkerProxyEnv({ HTTP_PROXY: null });
    expect(await get()).toBe('ok');
    expect(globalProxy.hits).toEqual([]);
    expect(targetHits).toBe(1);
  });

  it('none 强制直连，不走全局代理', async () => {
    expect(await runWithProviderProxy({ mode: 'none' }, get)).toBe('ok');
    expect(globalProxy.hits).toEqual([]);
    expect(targetHits).toBe(1);
  });

  it('custom 走该服务商的代理', async () => {
    expect(await runWithProviderProxy({ mode: 'custom', url: customA.url }, get)).toBe('ok');
    expect(customA.hits).toEqual([host()]);
    expect(globalProxy.hits).toEqual([]);
  });

  it('返回流对象后延迟发起的请求与重试仍继承上下文', async () => {
    const started = runWithProviderProxy({ mode: 'custom', url: customA.url }, () => {
      const results: Promise<string>[] = [];
      const stream = {
        result: (async () => {
          await delay(20);
          results.push(get());
          await new Promise((resolve) => setImmediate(resolve));
          results.push(get());
          return Promise.all(results);
        })(),
      };
      return stream;
    });
    expect(await started.result).toEqual(['ok', 'ok']);
    expect(customA.hits).toEqual([host(), host()]);
    expect(globalProxy.hits).toEqual([]);
  });

  it('并发的不同代理配置互不干扰', async () => {
    const pending = [
      runWithProviderProxy({ mode: 'custom', url: customA.url }, async () => {
        await delay(15);
        return get();
      }),
      runWithProviderProxy({ mode: 'custom', url: customB.url }, async () => {
        await delay(5);
        return get();
      }),
      runWithProviderProxy({ mode: 'none' }, get),
      get(),
    ];
    expect(await Promise.all(pending)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(customA.hits).toEqual([host()]);
    expect(customB.hits).toEqual([host()]);
    expect(globalProxy.hits).toEqual([host()]);
  });

  it('undici 包内 fetch 同样按上下文分流', async () => {
    const { fetch: undiciFetch } = await import('undici');
    const text = await runWithProviderProxy({ mode: 'custom', url: customB.url }, async () =>
      (await undiciFetch(targetUrl)).text()
    );
    expect(text).toBe('ok');
    expect(customB.hits).toEqual([host()]);
    expect(vi.isMockFunction(undiciFetch)).toBe(false);
  });
});
