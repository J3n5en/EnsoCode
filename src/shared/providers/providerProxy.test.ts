import { describe, expect, it } from 'vitest';
import {
  normalizeProviderProxy,
  parseProviderProxy,
  proxyUrlHasCredentials,
  redactProxyUrlCredentials,
  sameProviderProxy,
} from './providerProxy';

describe('parseProviderProxy', () => {
  it('undefined 表示跟随全局', () => {
    expect(parseProviderProxy(undefined)).toBeUndefined();
  });

  it('接受 none 与合法 http(s) 自定义地址，并去掉首尾空白', () => {
    expect(parseProviderProxy({ mode: 'none' })).toEqual({ mode: 'none' });
    expect(parseProviderProxy({ mode: 'custom', url: ' http://127.0.0.1:7890 ' })).toEqual({
      mode: 'custom',
      url: 'http://127.0.0.1:7890',
    });
    expect(parseProviderProxy({ mode: 'custom', url: 'https://u:p@proxy.example:443' })).toEqual({
      mode: 'custom',
      url: 'https://u:p@proxy.example:443',
    });
  });

  it.each([
    null,
    'none',
    [],
    {},
    { mode: 'global' },
    { mode: 'system' },
    { mode: 'none', url: 'http://a:1' },
    { mode: 'custom' },
    { mode: 'custom', url: '' },
    { mode: 'custom', url: 'socks5://127.0.0.1:1080' },
    { mode: 'custom', url: 'not a url' },
    { mode: 'custom', url: 1 },
    { mode: 'custom', url: 'http://a:1', extra: true },
  ])('拒绝坏输入 %j', (value) => {
    expect(parseProviderProxy(value)).toBeNull();
  });

  it('normalize 把坏值降级为跟随全局', () => {
    expect(normalizeProviderProxy({ mode: 'custom', url: 'bad' })).toBeUndefined();
    expect(normalizeProviderProxy({ mode: 'none' })).toEqual({ mode: 'none' });
  });
});

describe('sameProviderProxy', () => {
  it('按归一化后的值比较', () => {
    expect(sameProviderProxy(undefined, undefined)).toBe(true);
    expect(sameProviderProxy(undefined, { mode: 'custom', url: 'bad' })).toBe(true);
    expect(sameProviderProxy({ mode: 'none' }, { mode: 'none' })).toBe(true);
    expect(sameProviderProxy({ mode: 'none' }, undefined)).toBe(false);
    expect(
      sameProviderProxy(
        { mode: 'custom', url: 'http://a:1' },
        { mode: 'custom', url: ' http://a:1' }
      )
    ).toBe(true);
    expect(
      sameProviderProxy(
        { mode: 'custom', url: 'http://a:1' },
        { mode: 'custom', url: 'http://a:2' }
      )
    ).toBe(false);
    expect(sameProviderProxy({ mode: 'custom', url: 'http://a:1' }, { mode: 'none' })).toBe(false);
  });
});

describe('redactProxyUrlCredentials', () => {
  it('隐藏所有 URL 里的账密，保留其余文本', () => {
    expect(redactProxyUrlCredentials('http://user:pass@127.0.0.1:7890')).toBe(
      'http://***@127.0.0.1:7890'
    );
    expect(
      redactProxyUrlCredentials('connect https://a:b@p.example:1 failed; via http://c@q:2/x')
    ).toBe('connect https://***@p.example:1 failed; via http://***@q:2/x');
    expect(redactProxyUrlCredentials('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
  });

  it('密码里未编码的 @ 也整段隐藏，不漏出半截', () => {
    expect(redactProxyUrlCredentials('via http://user:p@ss@127.0.0.1:7890/x failed')).toBe(
      'via http://***@127.0.0.1:7890/x failed'
    );
  });

  it('识别地址是否带凭据', () => {
    expect(proxyUrlHasCredentials('http://u:p@h:1')).toBe(true);
    expect(proxyUrlHasCredentials('http://u@h:1')).toBe(true);
    expect(proxyUrlHasCredentials('http://h:1')).toBe(false);
    expect(proxyUrlHasCredentials('bad')).toBe(false);
  });
});
