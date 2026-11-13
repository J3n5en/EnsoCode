import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: { isAsyncEncryptionAvailable: async () => false },
  shell: { openExternal: vi.fn(async () => {}) },
}));
vi.mock('../ipc/settings', () => ({ readSettings: () => undefined }));

import { authorizeMcpServer, McpOAuthClientProvider } from './mcpOAuth';
import { McpOAuthStore } from './mcpOAuthStore';

const newStore = () => new McpOAuthStore({ file: path.join(dir, 'store.bin') });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-mcp-oauth-flow-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('McpOAuthClientProvider', () => {
  it('元数据与 redirectUrl 绑定回调地址', () => {
    const provider = new McpOAuthClientProvider({
      serverId: 's1',
      serverUrl: 'https://mcp.test/mcp',
      redirectUrl: 'http://127.0.0.1:5000/cb',
      state: 'st',
      store: newStore(),
      openExternal: vi.fn(),
    });
    expect(provider.redirectUrl).toBe('http://127.0.0.1:5000/cb');
    expect(provider.clientMetadata.redirect_uris).toEqual(['http://127.0.0.1:5000/cb']);
    expect(provider.state()).toBe('st');
  });

  it('client information / tokens 落到 store，code verifier 在内存', async () => {
    const store = newStore();
    const provider = new McpOAuthClientProvider({
      serverId: 's1',
      serverUrl: 'https://mcp.test/mcp',
      redirectUrl: 'http://127.0.0.1:5000/cb',
      state: 'st',
      store,
      openExternal: vi.fn(),
    });
    expect(await provider.clientInformation()).toBeUndefined();
    await provider.saveClientInformation({ client_id: 'c1' } as never);
    expect(await provider.clientInformation()).toEqual({ client_id: 'c1' });
    expect(store.record('s1')?.clientInformation).toEqual({ client_id: 'c1' });

    await provider.saveTokens({ access_token: 'a1', token_type: 'Bearer' } as never);
    expect(store.tokens('s1')).toEqual({ access_token: 'a1', token_type: 'Bearer' });

    expect(() => provider.codeVerifier()).toThrow();
    provider.saveCodeVerifier('v1');
    expect(provider.codeVerifier()).toBe('v1');
  });

  it('redirectToAuthorization 交给外部浏览器', async () => {
    const openExternal = vi.fn();
    const provider = new McpOAuthClientProvider({
      serverId: 's1',
      serverUrl: 'https://mcp.test/mcp',
      redirectUrl: 'http://127.0.0.1:5000/cb',
      state: 'st',
      store: newStore(),
      openExternal,
    });
    await provider.redirectToAuthorization(new URL('https://auth.test/authorize?x=1'));
    expect(openExternal).toHaveBeenCalledWith('https://auth.test/authorize?x=1');
  });
});

function fakeCallbackServer(code: string | (() => Promise<string>), iss?: string) {
  const close = vi.fn();
  const waitForCode = vi.fn(() => (typeof code === 'string' ? Promise.resolve(code) : code()));
  const waitForResponse = vi.fn(async () => ({
    code: await waitForCode(),
    ...(iss ? { iss } : {}),
  }));
  return {
    close,
    waitForCode,
    start: vi.fn(async () => ({
      redirectUri: 'http://127.0.0.1:5000/cb',
      waitForCode,
      waitForResponse,
      close,
    })),
  };
}

/** 真实回调服务器的行为：close() 会 reject 内部 promise */
function rejectingCallbackServer() {
  const { promise, reject } = Promise.withResolvers<string>();
  const close = vi.fn(() => reject(new Error('回调服务器已关闭')));
  return {
    close,
    start: vi.fn(async () => ({
      redirectUri: 'http://127.0.0.1:5000/cb',
      waitForCode: () => promise,
      waitForResponse: () => promise.then((code) => ({ code })),
      close,
    })),
  };
}

describe('authorizeMcpServer', () => {
  it('未知 server 直接失败', async () => {
    const result = await authorizeMcpServer('nope', {
      store: newStore(),
      resolveServer: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('stdio server 不支持 OAuth', async () => {
    const result = await authorizeMcpServer('s1', {
      store: newStore(),
      resolveServer: () => ({ id: 's1', name: 'local', transport: 'stdio' }),
    });
    expect(result.ok).toBe(false);
  });

  it('REDIRECT → 等回调 → 用 code 换 token → 落盘并重新下发', async () => {
    const store = newStore();
    const server = fakeCallbackServer('the-code');
    const onAuthorized = vi.fn();
    const auth = vi.fn(
      async (provider: McpOAuthClientProvider, options: { authorizationCode?: string }) => {
        if (!options.authorizationCode) {
          await provider.redirectToAuthorization(new URL('https://auth.test/authorize'));
          return 'REDIRECT' as const;
        }
        expect(options.authorizationCode).toBe('the-code');
        await provider.saveTokens({ access_token: 'fresh' } as never);
        return 'AUTHORIZED' as const;
      }
    );
    const openExternal = vi.fn();

    const result = await authorizeMcpServer('s1', {
      store,
      resolveServer: () => ({
        id: 's1',
        name: 'notion',
        transport: 'http',
        url: 'https://mcp.test/mcp',
      }),
      startCallbackServer: server.start as never,
      auth: auth as never,
      openExternal,
      onAuthorized,
    });

    expect(result).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalled();
    expect(auth).toHaveBeenCalledTimes(2);
    expect(store.tokens('s1')).toEqual({ access_token: 'fresh' });
    expect(onAuthorized).toHaveBeenCalledWith('s1');
    expect(server.close).toHaveBeenCalled();
  });

  it('授权未完成时回滚旧凭据，不把原本可用的 token 弄没', async () => {
    const store = newStore();
    store.saveTokens('s1', { access_token: 'old', refresh_token: 'r-old' });
    const server = fakeCallbackServer(() => Promise.reject(new Error('用户关了浏览器')));
    const result = await authorizeMcpServer('s1', {
      store,
      resolveServer: () => ({
        id: 's1',
        name: 'notion',
        transport: 'http',
        url: 'https://mcp.test/mcp',
      }),
      startCallbackServer: server.start as never,
      auth: (async () => 'REDIRECT') as never,
      openExternal: vi.fn(),
    });
    expect(result.ok).toBe(false);
    expect(store.tokens('s1')).toEqual({ access_token: 'old', refresh_token: 'r-old' });
  });

  // token 只剩 5 分钟时点授权又取消：回滚若按 expires_in 重算，看起来还能用一小时，临期主动续期被跳过
  it('授权未完成回滚时保留旧 token 原来的过期时间', async () => {
    let now = 1_000_000;
    const store = new McpOAuthStore({ file: path.join(dir, 'store.bin'), now: () => now });
    store.saveTokens('s1', { access_token: 'old', refresh_token: 'r-old', expires_in: 3600 });
    const expiresAt = now + 3_600_000;
    now += 55 * 60_000;
    const server = fakeCallbackServer(() => Promise.reject(new Error('用户关了浏览器')));
    const result = await authorizeMcpServer('s1', {
      store,
      resolveServer: () => ({
        id: 's1',
        name: 'notion',
        transport: 'http',
        url: 'https://mcp.test/mcp',
      }),
      startCallbackServer: server.start as never,
      auth: (async () => 'REDIRECT') as never,
      openExternal: vi.fn(),
    });
    expect(result.ok).toBe(false);
    expect(store.access('s1')).toEqual({ access_token: 'old', expires_at: expiresAt });
  });

  it('首轮即 AUTHORIZED 时不等待回调', async () => {
    const server = fakeCallbackServer(() => Promise.reject(new Error('不该等待')));
    const auth = vi.fn(async () => 'AUTHORIZED' as const);
    const result = await authorizeMcpServer('s1', {
      store: newStore(),
      resolveServer: () => ({
        id: 's1',
        name: 'notion',
        transport: 'http',
        url: 'https://mcp.test/mcp',
      }),
      startCallbackServer: server.start as never,
      auth: auth as never,
      openExternal: vi.fn(),
    });
    expect(result).toEqual({ ok: true });
    expect(auth).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalled();
  });

  it('auth 抛错时返回错误并关闭回调服务器', async () => {
    const server = fakeCallbackServer('x');
    const result = await authorizeMcpServer('s1', {
      store: newStore(),
      resolveServer: () => ({
        id: 's1',
        name: 'notion',
        transport: 'http',
        url: 'https://mcp.test/mcp',
      }),
      startCallbackServer: server.start as never,
      auth: vi.fn(async () => {
        throw new Error('discovery failed');
      }) as never,
      openExternal: vi.fn(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('discovery failed');
    expect(server.close).toHaveBeenCalled();
  });

  it('首轮即 AUTHORIZED 也预挂回调 handler，close 不产生无人接管的 rejection', async () => {
    const server = rejectingCallbackServer();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await authorizeMcpServer('s1', {
        store: newStore(),
        resolveServer: () => ({
          id: 's1',
          name: 'notion',
          transport: 'http',
          url: 'https://mcp.test/mcp',
        }),
        startCallbackServer: server.start as never,
        auth: vi.fn(async () => 'AUTHORIZED' as const) as never,
        openExternal: vi.fn(),
      });
      expect(result).toEqual({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('重新授权忽略已失效 token，但保留 clientInformation', async () => {
    const store = newStore();
    store.saveClientInformation('s1', { client_id: 'c1' }, 'https://mcp.test/mcp');
    store.saveTokens('s1', { access_token: 'stale', refresh_token: 'dead' });
    const server = fakeCallbackServer('c');
    let seenTokens: unknown = 'unset';
    let seenClient: unknown;
    const result = await authorizeMcpServer('s1', {
      store,
      resolveServer: () => ({
        id: 's1',
        name: 'notion',
        transport: 'http',
        url: 'https://mcp.test/mcp',
      }),
      startCallbackServer: server.start as never,
      auth: vi.fn(async (provider: McpOAuthClientProvider) => {
        seenTokens = provider.tokens();
        seenClient = await provider.clientInformation();
        await provider.saveTokens({ access_token: 'fresh' } as never);
        return 'AUTHORIZED' as const;
      }) as never,
      openExternal: vi.fn(),
    });
    expect(result).toEqual({ ok: true });
    expect(seenTokens).toBeUndefined();
    expect(seenClient).toEqual({ client_id: 'c1' });
    expect(store.tokens('s1')).toEqual({ access_token: 'fresh' });
  });

  it('同一 server 并发授权复用同一条流程', async () => {
    const server = fakeCallbackServer('c');
    let resolveAuth: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveAuth = resolve;
    });
    const auth = vi.fn(async () => {
      await gate;
      return 'AUTHORIZED' as const;
    });
    const deps = {
      store: newStore(),
      resolveServer: () => ({
        id: 's1',
        name: 'notion',
        transport: 'http' as const,
        url: 'https://mcp.test/mcp',
      }),
      startCallbackServer: server.start as never,
      auth: auth as never,
      openExternal: vi.fn(),
    };
    const first = authorizeMcpServer('s1', deps);
    const second = authorizeMcpServer('s1', deps);
    resolveAuth?.();
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(auth).toHaveBeenCalledTimes(1);
  });
});

describe('authorizeMcpServer · pi 1.0 OAuth 加固', () => {
  const remote = (extra: Record<string, unknown> = {}) => ({
    id: 's1',
    name: 'notion',
    transport: 'http' as const,
    url: 'https://mcp.test/mcp',
    ...extra,
  });
  const redirectThenAuthorize = () =>
    vi.fn(async (provider: McpOAuthClientProvider, options: { authorizationCode?: string }) => {
      if (!options.authorizationCode) {
        await provider.redirectToAuthorization(new URL('https://auth.test/authorize'));
        return 'REDIRECT' as const;
      }
      await provider.saveTokens({ access_token: 'fresh' } as never);
      return 'AUTHORIZED' as const;
    });

  it('回调里的 iss 随 code 一起交给换 token 的流程（RFC 9207）', async () => {
    const auth = redirectThenAuthorize();
    const server = fakeCallbackServer('the-code', 'https://auth.test');
    const result = await authorizeMcpServer('s1', {
      store: newStore(),
      resolveServer: () => remote(),
      startCallbackServer: server.start as never,
      auth: auth as never,
      openExternal: vi.fn(),
    });
    expect(result).toEqual({ ok: true });
    expect(auth.mock.calls[1][1]).toMatchObject({
      authorizationCode: 'the-code',
      iss: 'https://auth.test',
    });
  });

  it('配置的 clientName 与授权服务器元数据地址用于注册与发现', async () => {
    const auth = vi.fn(
      async (provider: McpOAuthClientProvider, _options: { [key: string]: unknown }) => {
        expect(provider.clientMetadata.client_name).toBe('Known Client');
        return 'AUTHORIZED' as const;
      }
    );
    await authorizeMcpServer('s1', {
      store: newStore(),
      resolveServer: () =>
        remote({
          oauthClientName: 'Known Client',
          oauthMetadataUrl: 'https://auth.test/.well-known/oauth-authorization-server',
        }),
      startCallbackServer: fakeCallbackServer('c').start as never,
      auth: auth as never,
      openExternal: vi.fn(),
    });
    expect(auth).toHaveBeenCalledTimes(1);
    expect(String(auth.mock.calls[0][1].authorizationServerMetadataUrl)).toBe(
      'https://auth.test/.well-known/oauth-authorization-server'
    );
  });

  it('服务器要求更多 scope 时，新授权保留已授予的 scope 并跳过刷新', async () => {
    const store = newStore();
    store.saveTokens('s1', { access_token: 'old', refresh_token: 'r', scope: 'read' });
    const auth = redirectThenAuthorize();
    await authorizeMcpServer('s1', {
      store,
      resolveServer: () => remote(),
      scopeChallenge: () => ({
        scope: 'write',
        resourceMetadataUrl: 'https://mcp.test/.well-known/oauth-protected-resource',
      }),
      startCallbackServer: fakeCallbackServer('c').start as never,
      auth: auth as never,
      openExternal: vi.fn(),
    });
    const options = auth.mock.calls[0][1] as Record<string, unknown>;
    expect(String(options.scope).split(' ').sort()).toEqual(['read', 'write']);
    expect(options.skipRefresh).toBe(true);
    expect(String(options.resourceMetadataUrl)).toBe(
      'https://mcp.test/.well-known/oauth-protected-resource'
    );
  });

  it('真实流程：iss 与授权服务器不符时拒绝换 token', async () => {
    const as = await startFakeAuthorizationServer();
    try {
      const run = (iss: string) =>
        authorizeMcpServer('s1', {
          store: newStore(),
          resolveServer: () => remote({ url: `${as.base}/mcp` }),
          startCallbackServer: fakeCallbackServer('the-code', iss).start as never,
          openExternal: vi.fn(),
        });
      const rejected = await run('https://evil.test');
      expect(rejected.ok).toBe(false);
      expect(as.tokenRequests).toBe(0);
      const accepted = await run(as.base);
      expect(accepted).toEqual({ ok: true });
      expect(as.tokenRequests).toBe(1);
    } finally {
      await as.close();
    }
  });

  // 首选回调端口被占用退到随机端口时，DCR 登记的 redirect_uri 与本次不符；复用旧 client 会被严格比对的
  // 授权服务器拒绝（真机上卡在浏览器错误页，Enso 干等到 300 秒超时）
  it('回调端口变了：已存 client 没登记本次回调地址时重新注册，不复用旧 client', async () => {
    const stale = 'http://127.0.0.1:43117/mcp/oauth/callback';
    const as = await startFakeAuthorizationServer({ stale: [stale] });
    try {
      const store = newStore();
      store.saveClientInformation(
        's1',
        { client_id: 'stale', redirect_uris: [stale] },
        `${as.base}/mcp`
      );
      const result = await authorizeMcpServer('s1', {
        store,
        resolveServer: () => remote({ url: `${as.base}/mcp` }),
        startCallbackServer: fakeCallbackServer('the-code', as.base).start as never,
        openExternal: vi.fn(),
      });
      expect(result).toEqual({ ok: true });
      expect(store.record('s1')?.clientInformation).toMatchObject({
        redirect_uris: ['http://127.0.0.1:5000/cb'],
      });
    } finally {
      await as.close();
    }
  });

  // 端口回退时流程已按新回调地址重新注册了 client，用户随后取消：旧 token 只配旧 client，拆开恢复会让续期失败
  it('授权未完成回滚时，旧 client 与旧 token 一起恢复', async () => {
    const stale = {
      client_id: 'stale',
      redirect_uris: ['http://127.0.0.1:43117/mcp/oauth/callback'],
    };
    const as = await startFakeAuthorizationServer({ stale: stale.redirect_uris });
    try {
      const store = newStore();
      store.saveClientInformation('s1', stale, `${as.base}/mcp`);
      store.saveTokens('s1', { access_token: 'old', refresh_token: 'r-old' });
      const result = await authorizeMcpServer('s1', {
        store,
        resolveServer: () => remote({ url: `${as.base}/mcp` }),
        startCallbackServer: fakeCallbackServer(() => Promise.reject(new Error('用户关了浏览器')))
          .start as never,
        openExternal: vi.fn(),
      });
      expect(result.ok).toBe(false);
      expect(store.record('s1')).toMatchObject({
        clientInformation: stale,
        tokens: { access_token: 'old', refresh_token: 'r-old' },
      });
    } finally {
      await as.close();
    }
  });
});

/**
 * loopback 上的最小授权服务器：PRM + AS 元数据（声明支持 iss）+ DCR + token。
 * 与真实服务一样按 client 登记的 redirect_uris 严格比对；preregistered 模拟之前注册过的 client
 */
async function startFakeAuthorizationServer(preregistered: Record<string, string[]> = {}) {
  const { createServer } = await import('node:http');
  let tokenRequests = 0;
  const clients = new Map(Object.entries(preregistered));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (payload: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json({ resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.pathname === '/register') {
      const redirectUris = (JSON.parse(body) as { redirect_uris: string[] }).redirect_uris;
      const clientId = `c${clients.size + 1}`;
      clients.set(clientId, redirectUris);
      return json({ client_id: clientId, redirect_uris: redirectUris });
    }
    if (url.pathname === '/token') {
      tokenRequests += 1;
      const form = new URLSearchParams(body);
      if (!clients.get(form.get('client_id') ?? '')?.includes(form.get('redirect_uri') ?? '')) {
        return json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
      }
      return json({ access_token: 'issued', token_type: 'Bearer' });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return {
    base,
    get tokenRequests() {
      return tokenRequests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
