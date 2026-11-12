import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mcpOAuthFingerprint } from '@shared/mcpOAuth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: { isAsyncEncryptionAvailable: async () => false },
  shell: { openExternal: vi.fn(async () => {}) },
}));
vi.mock('../ipc/settings', () => ({ readSettings: () => undefined }));

import { refreshMcpOAuthAccess } from './mcpOAuthRefresh';
import { McpOAuthStore } from './mcpOAuthStore';

const NOW = 1_000_000;
const SERVER_URL = 'https://mcp.test/mcp';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** 假授权服务器：discovery 固定，token 端点按用例返回 */
function fakeAuthServer(token: (params: URLSearchParams) => Response | Promise<Response>) {
  const tokenRequests: URLSearchParams[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('oauth-protected-resource')) {
      return json({ resource: SERVER_URL, authorization_servers: ['https://as.test'] });
    }
    if (url.includes('oauth-authorization-server')) {
      return json({
        issuer: 'https://as.test',
        authorization_endpoint: 'https://as.test/authorize',
        token_endpoint: 'https://as.test/token',
        response_types_supported: ['code'],
      });
    }
    if (url === 'https://as.test/token') {
      const params = new URLSearchParams(String(init?.body));
      tokenRequests.push(params);
      return token(params);
    }
    return new Response('not found', { status: 404 });
  });
  return { fetchFn, tokenRequests };
}

const newStore = (name = 'store') =>
  new McpOAuthStore({
    file: path.join(dir, `${name}.bin`),
    now: () => NOW,
  });

/** 一条已授权记录：DCR client + 有 refresh_token 的 token */
function authorizedStore(tokens: Record<string, unknown> = {}) {
  const store = newStore();
  store.saveClientInformation('s1', { client_id: 'c1' }, SERVER_URL);
  store.saveTokens('s1', {
    access_token: 'a1',
    refresh_token: 'r1',
    scope: 'read',
    expires_in: 3600,
    ...tokens,
  });
  return store;
}

const depsFor = (store: McpOAuthStore, fetchFn: typeof fetch) => ({
  store,
  fetch: fetchFn,
  now: () => NOW,
  resolveServer: (id: string) => (id === 's1' ? { url: SERVER_URL } : undefined),
});

const rejectedA1 = () => mcpOAuthFingerprint('a1');

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-mcp-oauth-refresh-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('refreshMcpOAuthAccess', () => {
  it('用授权时注册的 client 与 resource 刷新，新 token 落盘，只把 access 交回 worker', async () => {
    const store = authorizedStore();
    const { fetchFn, tokenRequests } = fakeAuthServer(() =>
      json({ access_token: 'a2', token_type: 'Bearer', refresh_token: 'r2', expires_in: 60 })
    );
    const result = await refreshMcpOAuthAccess('s1', rejectedA1(), depsFor(store, fetchFn));

    expect(result).toEqual({
      ok: true,
      access: { access_token: 'a2', expires_at: NOW + 60_000 },
    });
    expect(tokenRequests).toHaveLength(1);
    expect(Object.fromEntries(tokenRequests[0] ?? [])).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'r1',
      client_id: 'c1',
      resource: SERVER_URL,
    });
    // 没有重新注册 client
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('register'))).toBe(false);
    // 响应不带 scope 时沿用原授权 scope（RFC 6749 §6）
    expect(store.tokens('s1')).toEqual({
      access_token: 'a2',
      token_type: 'Bearer',
      refresh_token: 'r2',
      expires_in: 60,
      scope: 'read',
    });
  });

  it('服务端不轮换 refresh_token 时保留旧的', async () => {
    const store = authorizedStore();
    const { fetchFn } = fakeAuthServer(() => json({ access_token: 'a2', token_type: 'Bearer' }));
    await refreshMcpOAuthAccess('s1', rejectedA1(), depsFor(store, fetchFn));
    expect(store.tokens('s1')?.refresh_token).toBe('r1');
  });

  it('被拒的已不是当前 token（已被刷新过）时直接返回当前 token，不再消耗 refresh_token', async () => {
    const store = authorizedStore();
    const { fetchFn, tokenRequests } = fakeAuthServer(() => json({ access_token: 'x' }));
    const result = await refreshMcpOAuthAccess(
      's1',
      mcpOAuthFingerprint('stale'),
      depsFor(store, fetchFn)
    );
    expect(result).toMatchObject({ ok: true, access: { access_token: 'a1' } });
    expect(tokenRequests).toHaveLength(0);
  });

  it('主动续期：未临期不发请求，进入提前量后刷新', async () => {
    const { fetchFn, tokenRequests } = fakeAuthServer(() =>
      json({ access_token: 'a2', token_type: 'Bearer' })
    );
    const fresh = authorizedStore();
    expect(await refreshMcpOAuthAccess('s1', undefined, depsFor(fresh, fetchFn))).toMatchObject({
      ok: true,
      access: { access_token: 'a1' },
    });
    expect(tokenRequests).toHaveLength(0);

    const expiring = authorizedStore({ expires_in: 30 });
    expect(await refreshMcpOAuthAccess('s1', undefined, depsFor(expiring, fetchFn))).toMatchObject({
      ok: true,
      access: { access_token: 'a2' },
    });
    expect(tokenRequests).toHaveLength(1);
  });

  it('并发请求合并成一次刷新（轮换 refresh_token 不会被用两次）', async () => {
    const store = authorizedStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetchFn, tokenRequests } = fakeAuthServer(async () => {
      await gate;
      return json({ access_token: 'a2', token_type: 'Bearer', refresh_token: 'r2' });
    });
    const deps = depsFor(store, fetchFn);
    const first = refreshMcpOAuthAccess('s1', rejectedA1(), deps);
    const second = refreshMcpOAuthAccess('s1', rejectedA1(), deps);
    await vi.waitFor(() => expect(tokenRequests).toHaveLength(1));
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.ok && r.access.access_token)).toEqual(['a2', 'a2']);
    expect(tokenRequests).toHaveLength(1);
  });

  it('invalid_grant：清掉 token、保留 client，报需重新授权', async () => {
    const store = authorizedStore();
    const { fetchFn } = fakeAuthServer(() => json({ error: 'invalid_grant' }, 400));
    const result = await refreshMcpOAuthAccess('s1', rejectedA1(), depsFor(store, fetchFn));
    expect(result).toMatchObject({ ok: false, unauthorized: true });
    expect(store.tokens('s1')).toBeUndefined();
    expect(store.record('s1')?.clientInformation).toEqual({ client_id: 'c1' });
  });

  it('invalid_client：client 已失效，整条清掉，报需重新授权', async () => {
    const store = authorizedStore();
    const { fetchFn } = fakeAuthServer(() => json({ error: 'invalid_client' }, 401));
    const result = await refreshMcpOAuthAccess('s1', rejectedA1(), depsFor(store, fetchFn));
    expect(result).toMatchObject({ ok: false, unauthorized: true });
    expect(store.record('s1')).toBeUndefined();
  });

  it('临时故障（5xx/网络）保留凭据，不当成需授权', async () => {
    const store = authorizedStore();
    const { fetchFn } = fakeAuthServer(() => new Response('upstream down', { status: 503 }));
    const result = await refreshMcpOAuthAccess('s1', rejectedA1(), depsFor(store, fetchFn));
    expect(result).toMatchObject({ ok: false, unauthorized: false });
    expect(store.tokens('s1')?.refresh_token).toBe('r1');
  });

  it('没有 refresh_token 或 client 信息时不发请求，直接报需授权', async () => {
    const { fetchFn } = fakeAuthServer(() => json({ access_token: 'x' }));
    const noRefresh = newStore();
    noRefresh.saveClientInformation('s1', { client_id: 'c1' }, SERVER_URL);
    noRefresh.saveTokens('s1', { access_token: 'a1' });
    expect(
      await refreshMcpOAuthAccess('s1', rejectedA1(), depsFor(noRefresh, fetchFn))
    ).toMatchObject({ ok: false, unauthorized: true });

    const noClient = newStore('no-client');
    noClient.saveTokens('s1', { access_token: 'a1', refresh_token: 'r1' });
    expect(
      await refreshMcpOAuthAccess('s1', rejectedA1(), depsFor(noClient, fetchFn))
    ).toMatchObject({ ok: false, unauthorized: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('刷新期间用户重新授权：不拿旧结果覆盖新凭据', async () => {
    const store = authorizedStore();
    const { fetchFn } = fakeAuthServer(() => {
      store.saveTokens('s1', { access_token: 'reauthorized', refresh_token: 'r9' });
      return json({ access_token: 'a2', refresh_token: 'r2' });
    });
    const result = await refreshMcpOAuthAccess('s1', rejectedA1(), depsFor(store, fetchFn));
    expect(result).toMatchObject({ ok: true, access: { access_token: 'reauthorized' } });
    expect(store.tokens('s1')?.refresh_token).toBe('r9');
  });
});
