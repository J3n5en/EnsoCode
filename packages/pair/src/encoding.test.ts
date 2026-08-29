import { describe, expect, it } from 'vitest';
import { buildPairLink, buildPairUri, fromBase64Url, parsePairUri, toBase64Url } from './encoding';

describe('base64url', () => {
  it('随机字节往返', () => {
    for (const len of [0, 1, 2, 3, 31, 32, 33, 100]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) & 0xff;
      const round = fromBase64Url(toBase64Url(bytes));
      expect(Buffer.from(round).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it('无填充、url 安全字符', () => {
    const s = toBase64Url(new Uint8Array([251, 255, 191]));
    expect(s).not.toMatch(/[+/=]/);
  });
});

describe('配对 URI', () => {
  it('往返 relay + 公钥', () => {
    const publicKey = new Uint8Array(32).map((_, i) => i);
    const uri = buildPairUri({ relay: 'wss://relay.example.com', publicKey });
    expect(uri.startsWith('enso://pair?')).toBe(true);
    const parsed = parsePairUri(uri);
    expect(parsed.relay).toBe('wss://relay.example.com');
    expect(Buffer.from(parsed.publicKey).equals(Buffer.from(publicKey))).toBe(true);
  });

  it('非法 URI 抛错', () => {
    expect(() => parsePairUri('https://example.com')).toThrow();
    expect(() => parsePairUri('enso://pair?relay=x')).toThrow();
  });
});

describe('配对链接（二维码，https）', () => {
  const publicKey = new Uint8Array(32).map((_, i) => (i * 7) & 0xff);

  it('参数放在片段里，不会随请求发给服务器', () => {
    const link = buildPairLink({ relay: 'https://relay.example.com', publicKey });
    const url = new URL(link);
    expect(url.search).toBe('');
    expect(url.hash).toContain('pk=');
  });

  it('往返 relay + 公钥', () => {
    const link = buildPairLink({ relay: 'https://relay.example.com', publicKey });
    const parsed = parsePairUri(link);
    expect(parsed.relay).toBe('https://relay.example.com');
    expect(Buffer.from(parsed.publicKey).equals(Buffer.from(publicKey))).toBe(true);
  });

  it('relay 末尾斜杠不会导致重复', () => {
    const link = buildPairLink({ relay: 'https://relay.example.com/', publicKey });
    expect(link).not.toContain('.com//');
  });

  it('缺 relay 时回落到链接自身的来源站点', () => {
    const pk = toBase64Url(publicKey);
    const parsed = parsePairUri(`https://relay.example.com/#pk=${pk}`);
    expect(parsed.relay).toBe('https://relay.example.com');
  });

  it('查询串形式也接受（兜底）', () => {
    const pk = toBase64Url(publicKey);
    const parsed = parsePairUri(`https://relay.example.com/?pk=${pk}`);
    expect(Buffer.from(parsed.publicKey).equals(Buffer.from(publicKey))).toBe(true);
  });
});
