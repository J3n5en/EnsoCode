import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
vi.mock('electron', () => ({ app: { getPath: () => dir } }));

import { McpOAuthStore, type McpOAuthStoreOptions } from './mcpOAuthStore';
import type { SecureCodec } from './secureFile';

const file = () => path.join(dir, 'mcp-oauth.bin');
const plain: SecureCodec = {
  available: async () => false,
  encrypt: async (text) => Buffer.from(text, 'utf-8'),
  decrypt: async (data) => ({ text: data.toString('utf-8'), reEncrypt: false }),
};

async function open(options: McpOAuthStoreOptions = {}) {
  const store = new McpOAuthStore({ file: file(), codec: plain, ...options });
  await store.ready();
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-mcp-oauth-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('McpOAuthStore', () => {
  it('保存并读回 tokens', async () => {
    const store = await open();
    store.saveTokens('s1', { access_token: 'a1', refresh_token: 'r1' }, 'https://mcp.test/mcp');
    expect(store.tokens('s1')).toEqual({ access_token: 'a1', refresh_token: 'r1' });
    expect(store.record('s1')?.serverUrl).toBe('https://mcp.test/mcp');
    await store.flush();

    // 新实例从盘上读回
    const reopened = await open();
    expect(reopened.tokens('s1')?.access_token).toBe('a1');
  });

  it('无 safeStorage 时降级明文落盘', async () => {
    const store = await open();
    store.saveTokens('s1', { access_token: 'plain' });
    await store.flush();
    expect(readFileSync(file(), 'utf-8')).toContain('plain');
    expect(store.encryptionDegraded).toBe(true);
  });

  it('可用时走 safeStorage 加解密', async () => {
    const encrypt = vi.fn(async (text: string) => Buffer.from(`enc:${text}`, 'utf-8'));
    const decrypt = vi.fn(async (buf: Buffer) => ({
      text: buf.toString('utf-8').slice(4),
      reEncrypt: false,
    }));
    const codec: SecureCodec = { available: async () => true, encrypt, decrypt };
    const store = await open({ codec });
    store.saveTokens('s1', { access_token: 'secret' });
    await store.flush();
    expect(readFileSync(file(), 'utf-8').startsWith('enc:')).toBe(true);
    expect(store.encryptionDegraded).toBe(false);
    expect((await open({ codec })).tokens('s1')?.access_token).toBe('secret');
    expect(decrypt).toHaveBeenCalled();
  });

  it('clientInformation 与 tokens 分别保存，clear 清空整条', async () => {
    const store = await open();
    store.saveClientInformation('s1', { client_id: 'c1' });
    store.saveTokens('s1', { access_token: 'a1' });
    expect(store.record('s1')?.clientInformation).toEqual({ client_id: 'c1' });
    store.clear('s1');
    expect(store.record('s1')).toBeUndefined();
    await store.flush();
    expect((await open()).record('s1')).toBe(undefined);
  });

  it('clearTokens 只清 tokens，保留 clientInformation', async () => {
    const store = await open();
    store.saveClientInformation('s1', { client_id: 'c1' }, 'https://mcp.test/mcp');
    store.saveTokens('s1', { access_token: 'a1' });
    store.clearTokens('s1');
    expect(store.tokens('s1')).toBeUndefined();
    expect(store.record('s1')?.clientInformation).toEqual({ client_id: 'c1' });
    expect(store.record('s1')?.serverUrl).toBe('https://mcp.test/mcp');
  });

  it('authState 只列出确有 tokens 的 server', async () => {
    const store = await open();
    store.saveClientInformation('s1', { client_id: 'c1' });
    store.saveTokens('s2', { access_token: 'a2' });
    expect(store.authState()).toEqual({ s1: false, s2: true });
  });

  it('按 expires_in 记下绝对过期时间；下发给 worker 的 access 不含 refresh_token', async () => {
    const store = await open({ now: () => 1_000 });
    store.saveTokens('s1', { access_token: 'a1', refresh_token: 'r1', expires_in: 60 });
    expect(store.access('s1')).toEqual({ access_token: 'a1', expires_at: 61_000 });
    // 新 token 不带 expires_in：不能沿用旧的过期时间
    store.saveTokens('s1', { access_token: 'a2', token_type: 'Bearer' });
    expect(store.access('s1')).toEqual({ access_token: 'a2' });
    store.saveTokens('s1', { access_token: 'a3', expires_in: 60 });
    store.clearTokens('s1');
    expect(store.access('s1')).toBeUndefined();
    expect(store.record('s1')).not.toHaveProperty('expiresAt');
  });

  it('文件缺失时当空库，不抛', async () => {
    const store = await open({ file: path.join(dir, 'missing', 'x.bin') });
    expect(store.tokens('s1')).toBeUndefined();
    expect(store.authState()).toEqual({});
  });
});
