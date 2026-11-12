import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { describe, expect, it, vi } from 'vitest';
import { formatFetchResult, isPublicAddress, validateFetchUrl, webFetch } from './webFetch';
import { fetchWebResource, selectWebFetchProxy } from './webFetchConnect';

const publicLookup = async () => ['93.184.215.14'];

function respond(body: BodyInit | null, init: ResponseInit & { url?: string } = {}) {
  return new Response(body, init);
}

describe('validateFetchUrl', () => {
  it('只接受无凭据、长度受限的 http(s) URL', () => {
    expect(validateFetchUrl('https://example.com/a').href).toBe('https://example.com/a');
    expect(() => validateFetchUrl('ftp://example.com')).toThrow(/http/);
    expect(() => validateFetchUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => validateFetchUrl('https://user:pw@example.com')).toThrow(/credentials/);
    expect(() => validateFetchUrl('not a url')).toThrow(/Invalid URL/);
    expect(() => validateFetchUrl(`https://example.com/${'a'.repeat(2100)}`)).toThrow(/length/);
  });
});

describe('isPublicAddress', () => {
  it.each([
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.16.0.1', false],
    ['192.168.1.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['::1', false],
    ['fe80::1', false],
    ['fd00::1', false],
    ['::ffff:127.0.0.1', false],
    ['8.8.8.8', true],
    // Surge / Clash 的 fake-ip 段：代理环境下公网域名都解析到这里
    ['198.18.0.5', true],
    ['2606:4700::1111', true],
  ])('%s → %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe('webFetch', () => {
  it('域名解析到内网地址时拒绝，且不发请求', async () => {
    const fetch = vi.fn();
    await expect(
      webFetch('https://intranet.example/', {}, { fetch, lookup: async () => ['10.0.0.8'] })
    ).rejects.toThrow(/non-public/);
    await expect(webFetch('http://localhost:3000/', {}, { fetch })).rejects.toThrow(/non-public/);
    await expect(webFetch('http://[::1]/', {}, { fetch })).rejects.toThrow(/non-public/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('跟随重定向并逐跳复检，重定向到内网即拒绝', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(respond(null, { status: 302, headers: { location: '/next' } }))
      .mockResolvedValueOnce(
        respond('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
      );
    const result = await webFetch('https://a.example/start', {}, { fetch, lookup: publicLookup });
    expect(result.url).toBe('https://a.example/next');
    expect(result.text).toBe('ok');

    const evil = vi
      .fn()
      .mockResolvedValue(
        respond(null, { status: 301, headers: { location: 'http://127.0.0.1/admin' } })
      );
    await expect(
      webFetch('https://a.example/', {}, { fetch: evil, lookup: publicLookup })
    ).rejects.toThrow(/non-public/);
    expect(evil).toHaveBeenCalledTimes(1);
  });

  // 走代理时按原主机名转发。http 不建 CONNECT 隧道；本机解析出的 IP 不能拿来当隧道目标。
  it('http 经代理按主机名转发且不建隧道，重定向后仍如此', async () => {
    const targets: string[] = [];
    const hosts: string[] = [];
    const tunnels: string[] = [];
    // 第一跳 302 到另一个域名,第二跳返回正文
    const raw = (path: string) =>
      path === '/start'
        ? 'HTTP/1.1 302 Found\r\nLocation: http://next.example/done\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
        : 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok';
    // 明文代理请求:目标写在请求行的绝对 URL 里
    const proxy = createServer((request, response) => {
      const target = new URL(request.url ?? '');
      targets.push(target.hostname);
      hosts.push(request.headers.host ?? '');
      response.socket?.end(raw(target.pathname));
    });
    // CONNECT 隧道:目标是 CONNECT 的 authority
    proxy.on('connect', (request, socket) => {
      tunnels.push(request.url ?? '');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', (data) => {
        const head = data.toString();
        hosts.push(/^host:\s*(\S+)/im.exec(head)?.[1] ?? '');
        socket.end(raw(/^GET (\S+)/.exec(head)?.[1] ?? ''));
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    vi.stubEnv('http_proxy', proxyUrl);
    vi.stubEnv('HTTP_PROXY', proxyUrl);
    vi.stubEnv('https_proxy', '');
    vi.stubEnv('HTTPS_PROXY', '');
    vi.stubEnv('no_proxy', '');
    vi.stubEnv('NO_PROXY', '');
    // 与 worker 启动时 applyWorkerProxyEnv 装的全局代理一致
    const previous = getGlobalDispatcher();
    const globalProxy = new EnvHttpProxyAgent({ httpProxy: proxyUrl, noProxy: '' });
    setGlobalDispatcher(globalProxy);
    const resolved: Record<string, string> = {
      'start.example': '1.1.1.1',
      'next.example': '8.8.8.8',
    };
    try {
      const result = await webFetch(
        'http://start.example/start',
        { signal: AbortSignal.timeout(3000) },
        { lookup: async (host) => [resolved[host]] }
      );
      expect(result.text).toBe('ok');
      expect(targets).toEqual(['start.example', 'next.example']);
      expect(hosts).toEqual(['start.example', 'next.example']);
      expect(tunnels).toEqual([]);
    } finally {
      setGlobalDispatcher(previous);
      await globalProxy.destroy();
      vi.unstubAllEnvs();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('https 经代理时 CONNECT 原主机名，而不是本机解析出的 IP', async () => {
    const tunnels: string[] = [];
    const proxy = createServer();
    proxy.on('connect', (request, socket) => {
      tunnels.push(request.url ?? '');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.destroy();
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    vi.stubEnv('http_proxy', proxyUrl);
    vi.stubEnv('HTTP_PROXY', proxyUrl);
    vi.stubEnv('https_proxy', proxyUrl);
    vi.stubEnv('HTTPS_PROXY', proxyUrl);
    vi.stubEnv('no_proxy', '');
    vi.stubEnv('NO_PROXY', '');
    try {
      await expect(
        webFetch(
          'https://secure.example/a',
          { signal: AbortSignal.timeout(3000) },
          { lookup: async () => ['2001:db8::1'] }
        )
      ).rejects.toThrow();
      expect(tunnels).toEqual(['secure.example:443']);
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('重定向次数有上限', async () => {
    const fetch = vi.fn(async () => respond(null, { status: 302, headers: { location: '/loop' } }));
    await expect(
      webFetch('https://a.example/', {}, { fetch, lookup: publicLookup })
    ).rejects.toThrow(/redirects/);
  });

  it('HTML 提取正文转 markdown，丢掉脚本与导航', async () => {
    const paragraph = 'Readable body text that matters. '.repeat(20);
    const html = `<!doctype html><html><head><title>Doc Title</title><script>var secret=1</script></head>
      <body><nav><a href="/x">Menu</a></nav><article><h1>Heading</h1><p>${paragraph}</p>
      <p>See <a href="/docs">docs</a>.</p></article></body></html>`;
    const fetch = vi.fn(async () =>
      respond(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    );
    const result = await webFetch('https://a.example/page', {}, { fetch, lookup: publicLookup });
    expect(result.title).toBe('Doc Title');
    expect(result.text).toContain('Readable body text');
    expect(result.text).toContain('[docs](https://a.example/docs)');
    expect(result.text).not.toContain('secret');
  });

  it('JSON 原样返回，二进制拒绝', async () => {
    const json = vi.fn(async () =>
      respond('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    expect(
      (await webFetch('https://a.example/x', {}, { fetch: json, lookup: publicLookup })).text
    ).toBe('{"a":1}');
    const png = vi.fn(async () =>
      respond(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } })
    );
    await expect(
      webFetch('https://a.example/x.png', {}, { fetch: png, lookup: publicLookup })
    ).rejects.toThrow(/Unsupported content type: image\/png/);
  });

  it('按声明或 meta 的 charset 解码', async () => {
    const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]); // “你好”
    const fetch = vi.fn(async () =>
      respond(gbk, { status: 200, headers: { 'content-type': 'text/plain; charset=gbk' } })
    );
    expect((await webFetch('https://a.example/', {}, { fetch, lookup: publicLookup })).text).toBe(
      '你好'
    );
    const html = new Uint8Array([
      ...new TextEncoder().encode('<html><head><meta charset="gbk"><title>'),
      ...gbk,
      ...new TextEncoder().encode('</title></head><body><p>x</p></body></html>'),
    ]);
    const meta = vi.fn(async () =>
      respond(html, { status: 200, headers: { 'content-type': 'text/html' } })
    );
    expect(
      (await webFetch('https://a.example/', {}, { fetch: meta, lookup: publicLookup })).title
    ).toBe('你好');
  });

  it('长文按 offset 分页并标记截断', async () => {
    const body = 'x'.repeat(120_000);
    const fetch = vi.fn(async () =>
      respond(body, { status: 200, headers: { 'content-type': 'text/plain' } })
    );
    const first = await webFetch('https://a.example/', {}, { fetch, lookup: publicLookup });
    expect(first.text.length).toBe(50_000);
    expect(first.nextOffset).toBe(50_000);
    expect(formatFetchResult(first)).toContain('offset=50000');
    const last = await webFetch(
      'https://a.example/',
      { offset: 100_000 },
      { fetch, lookup: publicLookup }
    );
    expect(last.text.length).toBe(20_000);
    expect(last.nextOffset).toBeUndefined();
  });

  it('结果带不可信内容提示与状态码', async () => {
    const fetch = vi.fn(async () =>
      respond('gone', { status: 404, headers: { 'content-type': 'text/plain' } })
    );
    const text = formatFetchResult(
      await webFetch('https://a.example/', {}, { fetch, lookup: publicLookup })
    );
    expect(text).toContain('HTTP 404');
    expect(text).toMatch(/untrusted/i);
  });
});

describe('selectWebFetchProxy', () => {
  const env = (patch: NodeJS.ProcessEnv): NodeJS.ProcessEnv => patch;

  it('与 undici 一样：https 用 HTTPS_PROXY，缺省回退 HTTP_PROXY；http 不用只配的 HTTPS_PROXY', () => {
    const httpUrl = new URL('http://example.com/a');
    const httpsUrl = new URL('https://example.com/a');
    expect(selectWebFetchProxy(httpUrl, env({ http_proxy: 'http://proxy:8080' }))).toBe(
      'http://proxy:8080'
    );
    expect(selectWebFetchProxy(httpsUrl, env({ HTTP_PROXY: 'http://proxy:8080' }))).toBe(
      'http://proxy:8080'
    );
    expect(selectWebFetchProxy(httpsUrl, env({ https_proxy: 'http://tls-proxy:8443' }))).toBe(
      'http://tls-proxy:8443'
    );
    expect(selectWebFetchProxy(httpUrl, env({ HTTPS_PROXY: 'http://tls-proxy:8443' }))).toBeNull();
  });

  it('NO_PROXY 的 *、后缀、仅子域和端口规则与 EnvHttpProxyAgent 一致', () => {
    const proxy = { http_proxy: 'http://proxy:8080', https_proxy: 'http://proxy:8080' };
    expect(
      selectWebFetchProxy(new URL('https://example.com'), env({ ...proxy, NO_PROXY: '*' }))
    ).toBeNull();
    expect(
      selectWebFetchProxy(new URL('https://example.com'), env({ ...proxy, no_proxy: ' * ' }))
    ).toBeNull();
    expect(
      selectWebFetchProxy(
        new URL('https://a.example.com'),
        env({ ...proxy, NO_PROXY: 'example.com' })
      )
    ).toBeNull();
    expect(
      selectWebFetchProxy(
        new URL('https://example.com.'),
        env({ ...proxy, NO_PROXY: '.example.com' })
      )
    ).toBeNull();
    expect(
      selectWebFetchProxy(
        new URL('https://example.com'),
        env({ ...proxy, NO_PROXY: '*.example.com' })
      )
    ).toBe('http://proxy:8080');
    expect(
      selectWebFetchProxy(
        new URL('https://a.example.com'),
        env({ ...proxy, NO_PROXY: '*.example.com' })
      )
    ).toBeNull();
    expect(
      selectWebFetchProxy(
        new URL('https://example.com'),
        env({ ...proxy, NO_PROXY: 'example.com:443' })
      )
    ).toBeNull();
    expect(
      selectWebFetchProxy(
        new URL('https://example.com:8443'),
        env({ ...proxy, NO_PROXY: 'example.com:443' })
      )
    ).toBe('http://proxy:8080');
  });
});

describe('fetchWebResource 直连', () => {
  function clearProxy() {
    for (const key of [
      'http_proxy',
      'HTTP_PROXY',
      'https_proxy',
      'HTTPS_PROXY',
      'no_proxy',
      'NO_PROXY',
    ]) {
      vi.stubEnv(key, '');
    }
  }

  it('IPv4 优先，当前地址连接失败才换下一个，HTTP 错误不换', async () => {
    clearProxy();
    const v4Hits: string[] = [];
    const v4 = createServer((request, response) => {
      v4Hits.push(request.headers.host ?? '');
      response.end('from-v4');
    });
    await new Promise<void>((resolve) => v4.listen(0, '127.0.0.1', resolve));
    const port = (v4.address() as AddressInfo).port;
    const v6 = createServer((_request, response) => {
      response.end('from-v6');
    });
    await new Promise<void>((resolve) => v6.listen(port, '::1', resolve));
    const url = new URL(`http://unresolvable.example:${port}/x`);
    const init = () => ({ signal: AbortSignal.timeout(3000) });
    try {
      const preferred = await fetchWebResource(url, ['::1', '127.0.0.1'], init(), () => {});
      expect(await preferred.text()).toBe('from-v4');
      expect(v4Hits).toEqual([url.host]);

      await new Promise<void>((resolve, reject) =>
        v4.close((error) => (error ? reject(error) : resolve()))
      );
      const fallback = await fetchWebResource(url, ['::1', '127.0.0.1'], init(), () => {});
      expect(await fallback.text()).toBe('from-v6');
      await expect(
        fetchWebResource(
          new URL('http://unresolvable.example:1/x'),
          ['127.0.0.1'],
          init(),
          () => {}
        )
      ).rejects.toThrow();

      let errors = 0;
      const failing = createServer((_request, response) => {
        errors += 1;
        response.writeHead(500);
        response.end('nope');
      });
      await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
      const failPort = (failing.address() as AddressInfo).port;
      try {
        const response = await fetchWebResource(
          new URL(`http://unresolvable.example:${failPort}/x`),
          ['127.0.0.1', '::1'],
          init(),
          () => {}
        );
        expect(response.status).toBe(500);
        expect(errors).toBe(1);
      } finally {
        await new Promise<void>((resolve, reject) =>
          failing.close((error) => (error ? reject(error) : resolve()))
        );
      }
    } finally {
      vi.unstubAllEnvs();
      if (v4.listening) {
        await new Promise<void>((resolve, reject) =>
          v4.close((error) => (error ? reject(error) : resolve()))
        );
      }
      await new Promise<void>((resolve, reject) =>
        v6.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('NO_PROXY 命中时直连已校验地址，不把请求交给代理', async () => {
    const origin = createServer((request, response) => {
      response.end(request.headers.host ?? '');
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const port = (origin.address() as AddressInfo).port;
    const seen: string[] = [];
    const proxy = createServer((request, response) => {
      seen.push(request.url ?? '');
      response.end('proxied');
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    vi.stubEnv('http_proxy', proxyUrl);
    vi.stubEnv('HTTP_PROXY', proxyUrl);
    vi.stubEnv('https_proxy', '');
    vi.stubEnv('HTTPS_PROXY', '');
    vi.stubEnv('no_proxy', 'unresolvable.example');
    vi.stubEnv('NO_PROXY', 'unresolvable.example');
    try {
      const url = new URL(`http://unresolvable.example:${port}/x`);
      const response = await fetchWebResource(
        url,
        ['127.0.0.1'],
        { signal: AbortSignal.timeout(3000) },
        () => {}
      );
      expect(await response.text()).toBe(url.host);
      expect(seen).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((resolve, reject) =>
        origin.close((error) => (error ? reject(error) : resolve()))
      );
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
