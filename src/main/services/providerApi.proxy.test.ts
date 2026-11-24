import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProviderApiConfig } from '@shared/types';
import { net, session } from 'electron';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listModels, resetProviderProxySessionsForTests, testProvider } from './providerApi';

const proxyMocks = vi.hoisted(() => ({
  whenReady: vi.fn(async () => true),
  fetchOverride: undefined as undefined | ((url: string) => Promise<Response>),
}));

vi.mock('./proxyConfig', () => ({
  getProxyConfig: () => ({ whenReady: proxyMocks.whenReady }),
}));

vi.mock('@shared/providers/providerProxyDispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/providers/providerProxyDispatcher')>();
  return {
    ...actual,
    providerProxyFetch: (proxy: Parameters<typeof actual.providerProxyFetch>[0]) => {
      const real = actual.providerProxyFetch(proxy);
      return (
        real &&
        ((url: string, init?: RequestInit) =>
          proxyMocks.fetchOverride ? proxyMocks.fetchOverride(url) : real(url, init))
      );
    },
  };
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const base: ProviderApiConfig = {
  api: 'openai-completions',
  apiKey: 'sk-proxy-test',
  baseUrl: 'https://api.example.com/v1',
};

interface FakeSession {
  partition: string;
  setProxy: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
}

const originalNetFetch = net.fetch;
let sessions: FakeSession[];
let netFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetProviderProxySessionsForTests();
  proxyMocks.fetchOverride = undefined;
  proxyMocks.whenReady.mockClear();
  sessions = [];
  netFetch = vi.fn(async () => json({ data: [{ id: 'global-model' }] }));
  net.fetch = netFetch as unknown as typeof fetch;
  vi.spyOn(session, 'fromPartition').mockImplementation((partition: string) => {
    const fake: FakeSession = {
      partition,
      setProxy: vi.fn(async () => {}),
      fetch: vi.fn(async () => json({ data: [{ id: 'session-model' }] })),
    };
    sessions.push(fake);
    return fake as unknown as ReturnType<typeof session.fromPartition>;
  });
});

afterEach(() => {
  net.fetch = originalNetFetch;
  vi.restoreAllMocks();
});

describe('providerApi 按服务商代理发请求', () => {
  it('跟随全局：沿用等待全局代理 + net.fetch，不建分区', async () => {
    expect(await listModels(base)).toMatchObject({ ok: true, models: [{ id: 'global-model' }] });
    expect(proxyMocks.whenReady).toHaveBeenCalledOnce();
    expect(netFetch).toHaveBeenCalledOnce();
    expect(session.fromPartition).not.toHaveBeenCalled();
  });

  it('none：内存分区 direct 初始化一次后复用，不碰全局 net', async () => {
    const config = { ...base, proxy: { mode: 'none' as const } };
    expect(await listModels(config)).toMatchObject({ ok: true, models: [{ id: 'session-model' }] });
    expect(await testProvider(config, 'm')).toMatchObject({ ok: true });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.partition).toBe('enso-provider-proxy:direct');
    expect(sessions[0]?.partition.startsWith('persist:')).toBe(false);
    expect(sessions[0]?.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: 'direct' });
    expect(sessions[0]?.fetch).toHaveBeenCalledTimes(2);
    expect(sessions[0]?.fetch.mock.calls[1]?.[0]).toBe(
      'https://api.example.com/v1/chat/completions'
    );
    expect(netFetch).not.toHaveBeenCalled();
    expect(proxyMocks.whenReady).not.toHaveBeenCalled();
  });

  it('custom：每个代理地址一个分区，规则即该地址', async () => {
    const a = { ...base, proxy: { mode: 'custom' as const, url: 'http://127.0.0.1:7890' } };
    const b = { ...base, proxy: { mode: 'custom' as const, url: 'http://127.0.0.1:7891' } };
    await listModels(a);
    await listModels(b);
    await listModels(a);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.partition).toMatch(/^enso-provider-proxy:custom-[0-9a-f]{16}$/);
    expect(sessions[0]?.partition).not.toBe(sessions[1]?.partition);
    expect(sessions[0]?.setProxy).toHaveBeenCalledWith({
      proxyRules: 'http://127.0.0.1:7890',
      proxyBypassRules: '<-loopback>',
    });
    expect(sessions[1]?.setProxy).toHaveBeenCalledWith({
      proxyRules: 'http://127.0.0.1:7891',
      proxyBypassRules: '<-loopback>',
    });
    expect(sessions[0]?.fetch).toHaveBeenCalledTimes(2);
    expect(netFetch).not.toHaveBeenCalled();
  });

  it('分区初始化失败时报错并在下次重试', async () => {
    const config = { ...base, proxy: { mode: 'none' as const } };
    vi.mocked(session.fromPartition).mockImplementationOnce((partition: string) => {
      const fake = {
        partition,
        setProxy: vi.fn(async () => {
          throw new Error('setProxy failed');
        }),
        fetch: vi.fn(),
      };
      return fake as unknown as ReturnType<typeof session.fromPartition>;
    });
    expect(await listModels(config)).toMatchObject({ ok: false, error: 'setProxy failed' });
    expect(await listModels(config)).toMatchObject({ ok: true });
  });

  it('classifier 测试同样走服务商代理', async () => {
    const config = {
      api: 'typesafe-system-one' as const,
      apiKey: 'fixture-key',
      baseUrl: 'https://api.typesafe.ai/v1/',
      proxy: { mode: 'none' as const },
    };
    await testProvider(config);
    expect(sessions).toHaveLength(1);
    expect(String(sessions[0]?.fetch.mock.calls[0]?.[0])).toBe(
      'https://api.typesafe.ai/v1/systemone'
    );
    expect(netFetch).not.toHaveBeenCalled();
  });

  it('带账密的自定义代理错误文案不泄露账密', async () => {
    const proxy = { mode: 'custom' as const, url: 'http://alice:s3cr3t-pass@127.0.0.1:9' };
    proxyMocks.fetchOverride = async () => {
      throw new Error(`connect ECONNREFUSED via ${proxy.url} (alice:s3cr3t-pass)`);
    };
    const listed = await listModels({ ...base, proxy });
    const tested = await testProvider({ ...base, proxy }, 'm');
    const classified = await testProvider({
      api: 'typesafe-system-one',
      apiKey: 'fixture-key',
      baseUrl: 'https://api.typesafe.ai/v1/',
      proxy,
    });
    for (const text of [listed.error, tested.message, classified.message]) {
      expect(text).toBeTruthy();
      expect(text).not.toContain('s3cr3t-pass');
      expect(text).not.toContain('alice');
    }
    expect(listed.error).toContain('http://***@127.0.0.1:9');
    expect(sessions).toEqual([]);
  });
});

describe('带账密的自定义代理经 undici ProxyAgent 真实发送', () => {
  let target: Server;
  let proxy: Server;
  let targetBase: string;
  let proxyPort: number;
  const auth: string[] = [];
  const listen = (server: Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    );

  beforeAll(async () => {
    target = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'via-proxy' }] }));
    });
    proxy = createServer((req, res) => {
      auth.push(String(req.headers['proxy-authorization'] ?? ''));
      const url = new URL(req.url ?? '');
      const { 'proxy-authorization': _drop, ...headers } = req.headers;
      request(url, { headers }, (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      }).end();
    });
    targetBase = `http://127.0.0.1:${await listen(target)}/v1`;
    proxyPort = await listen(proxy);
  });

  afterAll(async () => {
    for (const server of [target, proxy]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('Proxy-Authorization 由代理 URL 账密生成，不经 Chromium 分区', async () => {
    const result = await listModels({
      ...base,
      baseUrl: targetBase,
      proxy: { mode: 'custom', url: `http://bob:pw-1234@127.0.0.1:${proxyPort}` },
    });
    expect(result).toMatchObject({ ok: true, models: [{ id: 'via-proxy' }] });
    expect(auth).toEqual([`Basic ${Buffer.from('bob:pw-1234').toString('base64')}`]);
    expect(sessions).toEqual([]);
    expect(netFetch).not.toHaveBeenCalled();
  });
});
