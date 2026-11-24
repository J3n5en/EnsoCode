import { describe, expect, it } from 'vitest';
import { providerKeyFor } from './providerKey';

const endpoint = {
  api: 'openai-completions',
  baseUrl: 'https://api.example/v1',
  apiKey: 'sk-test',
};

describe('providerKeyFor', () => {
  it('没有请求头或空表时保持现有身份', () => {
    expect(providerKeyFor(endpoint)).toBe('enso-a0d7ec91ee5e-f3abf2a6');
    expect(providerKeyFor({ ...endpoint, headers: {} })).toBe('enso-a0d7ec91ee5e-f3abf2a6');
    expect(providerKeyFor({ ...endpoint, headers: undefined })).toBe('enso-a0d7ec91ee5e-f3abf2a6');
  });

  it('按名称小写排序并入哈希，改请求头得到新身份，仅大小写不同的名称不算新身份', () => {
    const withHeaders = providerKeyFor({
      ...endpoint,
      headers: { 'X-B': '2', 'x-a': '1' },
    });
    expect(withHeaders).toBe('enso-a00dbe0bfcd4-f3abf2a6');
    expect(withHeaders).not.toBe(providerKeyFor(endpoint));
    expect(providerKeyFor({ ...endpoint, headers: { 'x-a': '1', 'X-B': '2' } })).toBe(withHeaders);
    expect(providerKeyFor({ ...endpoint, headers: { 'User-Agent': 'custom' } })).toBe(
      providerKeyFor({ ...endpoint, headers: { 'user-agent': 'custom' } })
    );
    expect(providerKeyFor({ ...endpoint, headers: { 'X-A': 'next' } })).not.toBe(
      providerKeyFor({ ...endpoint, headers: { 'X-A': 'prev' } })
    );
  });

  it('跟随全局代理保持原身份，不同代理策略 / 地址拆成不同 provider', () => {
    expect(providerKeyFor({ ...endpoint, proxy: undefined })).toBe('enso-a0d7ec91ee5e-f3abf2a6');
    const direct = providerKeyFor({ ...endpoint, proxy: { mode: 'none' } });
    const customA = providerKeyFor({
      ...endpoint,
      proxy: { mode: 'custom', url: 'http://127.0.0.1:7890' },
    });
    const customB = providerKeyFor({
      ...endpoint,
      proxy: { mode: 'custom', url: 'http://127.0.0.1:7891' },
    });
    const keys = new Set([providerKeyFor(endpoint), direct, customA, customB]);
    expect(keys.size).toBe(4);
    expect(direct.endsWith('-f3abf2a6')).toBe(true);
    expect(
      providerKeyFor({ ...endpoint, proxy: { mode: 'custom', url: ' http://127.0.0.1:7890 ' } })
    ).toBe(customA);
    // 坏值不能借用跟随全局的身份：worker 里残留的旧注册不能被它命中
    expect(
      providerKeyFor({
        ...endpoint,
        proxy: { mode: 'custom', url: 'bad' } as unknown as { mode: 'none' },
      })
    ).not.toBe(providerKeyFor(endpoint));
  });
});
