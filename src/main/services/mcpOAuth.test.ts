import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn(async () => {}) },
}));
vi.mock('../ipc/settings', () => ({ readSettings: () => undefined }));

import { authorizeMcpServer, McpOAuthClientProvider } from './mcpOAuth';
import { McpOAuthStore } from './mcpOAuthStore';

const newStore = () =>
  new McpOAuthStore({ file: path.join(dir, 'store.bin'), encryptionAvailable: () => false });

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

function fakeCallbackServer(code: string | (() => Promise<string>)) {
  const close = vi.fn();
  return {
    close,
    start: vi.fn(async () => ({
      redirectUri: 'http://127.0.0.1:5000/cb',
      waitForCode: () => (typeof code === 'string' ? Promise.resolve(code) : code()),
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
