import { describe, expect, it } from 'vitest';
import { pickFaviconUrl } from './favicon';

describe('pickFaviconUrl', () => {
  it('优先第一个合法 http(s) 地址', () => {
    expect(
      pickFaviconUrl(['data:image/png;base64,xx', 'https://a.example/favicon.ico', 'https://b'])
    ).toBe('local-image://remote-fetch/?url=https%3A%2F%2Fa.example%2Ffavicon.ico');
  });

  it('没有可用地址时返回 null', () => {
    expect(pickFaviconUrl([])).toBeNull();
    expect(pickFaviconUrl(['chrome://favicon/x', 'not a url'])).toBeNull();
  });
});
