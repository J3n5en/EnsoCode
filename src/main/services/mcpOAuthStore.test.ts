import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { McpOAuthStore } from './mcpOAuthStore';

const file = () => path.join(dir, 'mcp-oauth.bin');

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-mcp-oauth-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('McpOAuthStore', () => {
  it('保存并读回 tokens', () => {
    const store = new McpOAuthStore({ file: file(), encryptionAvailable: () => false });
    store.saveTokens('s1', { access_token: 'a1', refresh_token: 'r1' }, 'https://mcp.test/mcp');
    expect(store.tokens('s1')).toEqual({ access_token: 'a1', refresh_token: 'r1' });
    expect(store.record('s1')?.serverUrl).toBe('https://mcp.test/mcp');

    // 新实例从盘上读回
    const reopened = new McpOAuthStore({ file: file(), encryptionAvailable: () => false });
    expect(reopened.tokens('s1')?.access_token).toBe('a1');
  });

  it('无 safeStorage 时降级明文落盘', () => {
    const store = new McpOAuthStore({ file: file(), encryptionAvailable: () => false });
    store.saveTokens('s1', { access_token: 'plain' });
    expect(readFileSync(file(), 'utf-8')).toContain('plain');
    expect(store.encryptionDegraded).toBe(true);
  });

  it('可用时走 safeStorage 加解密', () => {
    const encrypt = vi.fn((text: string) => Buffer.from(`enc:${text}`, 'utf-8'));
    const decrypt = vi.fn((buf: Buffer) => buf.toString('utf-8').slice(4));
    const options = { file: file(), encryptionAvailable: () => true, encrypt, decrypt };
    const store = new McpOAuthStore(options);
    store.saveTokens('s1', { access_token: 'secret' });
    expect(readFileSync(file(), 'utf-8').startsWith('enc:')).toBe(true);
    expect(store.encryptionDegraded).toBe(false);
    expect(new McpOAuthStore(options).tokens('s1')?.access_token).toBe('secret');
    expect(decrypt).toHaveBeenCalled();
  });

  it('clientInformation 与 tokens 分别保存，clear 清空整条', () => {
    const store = new McpOAuthStore({ file: file(), encryptionAvailable: () => false });
    store.saveClientInformation('s1', { client_id: 'c1' });
    store.saveTokens('s1', { access_token: 'a1' });
    expect(store.record('s1')?.clientInformation).toEqual({ client_id: 'c1' });
    store.clear('s1');
    expect(store.record('s1')).toBeUndefined();
    expect(new McpOAuthStore({ file: file(), encryptionAvailable: () => false }).record('s1')).toBe(
      undefined
    );
  });

  it('clearTokens 只清 tokens，保留 clientInformation', () => {
    const store = new McpOAuthStore({ file: file(), encryptionAvailable: () => false });
    store.saveClientInformation('s1', { client_id: 'c1' }, 'https://mcp.test/mcp');
    store.saveTokens('s1', { access_token: 'a1' });
    store.clearTokens('s1');
    expect(store.tokens('s1')).toBeUndefined();
    expect(store.record('s1')?.clientInformation).toEqual({ client_id: 'c1' });
    expect(store.record('s1')?.serverUrl).toBe('https://mcp.test/mcp');
  });

  it('authState 只列出确有 tokens 的 server', () => {
    const store = new McpOAuthStore({ file: file(), encryptionAvailable: () => false });
    store.saveClientInformation('s1', { client_id: 'c1' });
    store.saveTokens('s2', { access_token: 'a2' });
    expect(store.authState()).toEqual({ s1: false, s2: true });
  });

  it('文件损坏时当空库，不抛', () => {
    const store = new McpOAuthStore({
      file: path.join(dir, 'missing', 'x.bin'),
      encryptionAvailable: () => false,
    });
    expect(store.tokens('s1')).toBeUndefined();
    expect(store.authState()).toEqual({});
  });
});
