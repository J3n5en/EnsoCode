import { describe, expect, it } from 'vitest';
import {
  isValidProxyUrl,
  mergeNoProxy,
  normalizeProxyMode,
  PROXY_ENV_KEYS,
  parseResolveProxy,
  proxyEnvPatch,
  proxyEnvPatchFromEnv,
} from './proxy';

describe('proxyEnvPatchFromEnv', () => {
  it('从当前 env 快照出完整 patch：缺失的键为 null', () => {
    expect(
      proxyEnvPatchFromEnv({ HTTP_PROXY: 'http://a:1', no_proxy: 'localhost', OTHER: 'x' })
    ).toEqual({
      http_proxy: null,
      https_proxy: null,
      HTTP_PROXY: 'http://a:1',
      HTTPS_PROXY: null,
      GRPC_PROXY: null,
      grpc_proxy: null,
      no_proxy: 'localhost',
      NO_PROXY: null,
    });
  });

  it('空 env → 全 null，键顺序与 PROXY_ENV_KEYS 一致', () => {
    const patch = proxyEnvPatchFromEnv({});
    expect(Object.keys(patch)).toEqual([...PROXY_ENV_KEYS]);
    expect(Object.values(patch).every((value) => value === null)).toBe(true);
  });
});

describe('parseResolveProxy', () => {
  it('maps DIRECT and empty junk to null', () => {
    expect(parseResolveProxy('DIRECT')).toBeNull();
    expect(parseResolveProxy('')).toBeNull();
    expect(parseResolveProxy('SOCKS5 127.0.0.1:1080')).toBeNull();
  });

  it('maps PROXY / HTTPS and keeps only the first PAC segment', () => {
    expect(parseResolveProxy('PROXY 127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
    expect(parseResolveProxy('HTTPS proxy.example:443')).toBe('https://proxy.example:443');
    expect(parseResolveProxy('PROXY a:1; PROXY b:2')).toBe('http://a:1');
  });
});

describe('mergeNoProxy', () => {
  it('returns the default list when nothing was inherited', () => {
    expect(mergeNoProxy('localhost, 127.0.0.1', '')).toBe('localhost, 127.0.0.1');
  });

  it('merges, trims, and dedupes inherited entries', () => {
    expect(mergeNoProxy('localhost, 127.0.0.1', ' example.test, localhost ')).toBe(
      'localhost, 127.0.0.1, example.test'
    );
  });
});

describe('isValidProxyUrl', () => {
  it('accepts http(s) proxy URLs and rejects the rest', () => {
    expect(isValidProxyUrl('http://127.0.0.1:7890')).toBe(true);
    expect(isValidProxyUrl('https://user:pass@proxy.example:8443')).toBe(true);
    expect(isValidProxyUrl('127.0.0.1:7890')).toBe(false);
    expect(isValidProxyUrl('')).toBe(false);
    expect(isValidProxyUrl('ftp://proxy.example:21')).toBe(false);
  });
});

describe('normalizeProxyMode', () => {
  it('keeps known modes and falls back to system', () => {
    expect(normalizeProxyMode('system')).toBe('system');
    expect(normalizeProxyMode('none')).toBe('none');
    expect(normalizeProxyMode('custom')).toBe('custom');
    expect(normalizeProxyMode(undefined)).toBe('system');
    expect(normalizeProxyMode('')).toBe('system');
    expect(normalizeProxyMode('foo')).toBe('system');
  });
});

describe('proxyEnvPatch', () => {
  it('writes the proxy env family when a URL is present', () => {
    expect(proxyEnvPatch('http://127.0.0.1:7890', 'localhost')).toEqual({
      http_proxy: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      GRPC_PROXY: 'http://127.0.0.1:7890',
      grpc_proxy: 'http://127.0.0.1:7890',
      no_proxy: 'localhost',
      NO_PROXY: 'localhost',
    });
  });

  it('clears the same keys when there is no proxy', () => {
    const patch = proxyEnvPatch(null, '');
    expect(PROXY_ENV_KEYS).toEqual([
      'http_proxy',
      'https_proxy',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'GRPC_PROXY',
      'grpc_proxy',
      'no_proxy',
      'NO_PROXY',
    ]);
    expect(Object.keys(patch)).toEqual([...PROXY_ENV_KEYS]);
    expect(Object.values(patch).every((value) => value === null)).toBe(true);
  });
});
