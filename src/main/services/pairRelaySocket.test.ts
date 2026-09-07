import { describe, expect, it } from 'vitest';
import { buildPinnedRelaySocketUrl, relaySocketConnectHost } from './pairRelaySocket';

describe('relaySocketConnectHost', () => {
  it('钉 IPv4 时用字面量，IPv6 加方括号', () => {
    expect(relaySocketConnectHost('enso-relay.j3.do', { address: '1.2.3.4', family: 4 })).toBe(
      '1.2.3.4'
    );
    expect(relaySocketConnectHost('enso-relay.j3.do', { address: '2001:db8::1', family: 6 })).toBe(
      '[2001:db8::1]'
    );
  });

  it('没解析结果时仍用域名', () => {
    expect(relaySocketConnectHost('enso-relay.j3.do', null)).toBe('enso-relay.j3.do');
  });
});

describe('buildPinnedRelaySocketUrl', () => {
  it('把 hostname 换成钉住的 IP，Host 头仍是原域名', () => {
    const url = new URL('wss://enso-relay.j3.do/v1/pair/p1?role=host&token=t');
    const next = buildPinnedRelaySocketUrl(url, { address: '1.2.3.4', family: 4 });
    expect(next.href).toBe('wss://1.2.3.4/v1/pair/p1?role=host&token=t');
    expect(next.hostname).toBe('1.2.3.4');
  });
});
