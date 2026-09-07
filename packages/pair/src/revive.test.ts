import { describe, expect, it } from 'vitest';
import {
  createCachedHostLookup,
  isMagicDnsOnly,
  networkFingerprint,
  parseLiteralHost,
  parseRelayHostCache,
  parseResolvConfNameservers,
  parseScutilGlobalNameservers,
  pickRelayConnectAddress,
  serializeRelayHostCache,
  shouldReplaceOnNudge,
  shouldSkipRelayLookup,
  shouldUsePinnedRelaySocket,
} from './revive';

describe('networkFingerprint', () => {
  it('忽略回环 / 链路本地，按网卡+地址排序', () => {
    const left = networkFingerprint({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '192.168.1.8', family: 'IPv4', internal: false }],
      utun4: [{ address: 'fe80::1', family: 'IPv6', internal: false }],
    });
    const right = networkFingerprint({
      utun4: [{ address: 'fe80::1', family: 6, internal: false }],
      en0: [{ address: '192.168.1.8', family: 4, internal: false }],
      lo0: [{ address: '127.0.0.1', family: 4, internal: true }],
    });
    expect(left).toBe(right);
    expect(left).toContain('en0|IPv4|192.168.1.8');
    expect(left).not.toContain('127.0.0.1');
    expect(left).not.toContain('fe80:');
  });

  it('VPN 隧道地址消失时指纹变化', () => {
    const withVpn = networkFingerprint({
      en0: [{ address: '192.168.1.8', family: 'IPv4', internal: false }],
      utun4: [{ address: '100.64.0.2', family: 'IPv4', internal: false }],
    });
    const withoutVpn = networkFingerprint({
      en0: [{ address: '192.168.1.8', family: 'IPv4', internal: false }],
    });
    expect(withVpn).not.toBe(withoutVpn);
  });
});

describe('shouldReplaceOnNudge', () => {
  it('无 socket 一律重连', () => {
    expect(shouldReplaceOnNudge('resume', false)).toBe(true);
    expect(shouldReplaceOnNudge('visibility', false)).toBe(true);
  });

  it('活链：网络变化 / 重新上线拆 socket，睡眠与回前台只探活', () => {
    expect(shouldReplaceOnNudge('network-change', true)).toBe(true);
    expect(shouldReplaceOnNudge('online', true)).toBe(true);
    expect(shouldReplaceOnNudge('resume', true)).toBe(false);
    expect(shouldReplaceOnNudge('visibility', true)).toBe(false);
  });
});

describe('relay lookup 决策', () => {
  it('系统 DNS 全是 MagicDNS 时视为死解析器', () => {
    expect(isMagicDnsOnly(['100.100.100.100'])).toBe(true);
    expect(isMagicDnsOnly(['100.100.100.100', '100.100.100.100'])).toBe(true);
    expect(isMagicDnsOnly(['100.100.100.100', '1.1.1.1'])).toBe(false);
    expect(isMagicDnsOnly([])).toBe(false);
  });

  it('有缓存且 MagicDNS 独占时跳过 lookup', () => {
    expect(shouldSkipRelayLookup(true, true)).toBe(true);
    expect(shouldSkipRelayLookup(false, true)).toBe(false);
    expect(shouldSkipRelayLookup(true, false)).toBe(false);
  });

  it('字面量 IP 不再走 DNS', () => {
    expect(parseLiteralHost('1.2.3.4')).toEqual({ address: '1.2.3.4', family: 4 });
    expect(parseLiteralHost('[2001:db8::1]')).toEqual({ address: '2001:db8::1', family: 6 });
    expect(parseLiteralHost('enso-relay.j3.do')).toBeNull();
  });

  it('scutil 只取全局 nameserver，忽略 scoped 残留', () => {
    const output = [
      'DNS configuration',
      '',
      'resolver #1',
      '  nameserver[0] : 100.100.100.100',
      '',
      'DNS configuration (for scoped queries)',
      '',
      'resolver #2',
      '  nameserver[0] : 1.1.1.1',
    ].join('\n');
    expect(parseScutilGlobalNameservers(output)).toEqual(['100.100.100.100']);
  });

  it('resolv.conf 去重 nameserver', () => {
    expect(
      parseResolvConfNameservers('# comment\nnameserver 1.1.1.1\nnameserver 1.1.1.1\n')
    ).toEqual(['1.1.1.1']);
  });

  it('选址：字面量优先，跳过 lookup 时用缓存，否则 lookup 再回落缓存', () => {
    expect(
      pickRelayConnectAddress({
        hostname: '9.9.9.9',
        cache: { address: '1.1.1.1', family: 4 },
        lookup: { address: '8.8.8.8', family: 4 },
        skipLookup: true,
      })
    ).toEqual({ address: '9.9.9.9', family: 4 });
    expect(
      pickRelayConnectAddress({
        hostname: 'enso-relay.j3.do',
        cache: { address: '1.1.1.1', family: 4 },
        lookup: { address: '8.8.8.8', family: 4 },
        skipLookup: true,
      })
    ).toEqual({ address: '1.1.1.1', family: 4 });
    expect(
      pickRelayConnectAddress({
        hostname: 'enso-relay.j3.do',
        cache: { address: '1.1.1.1', family: 4 },
        lookup: { address: '8.8.8.8', family: 4 },
        skipLookup: false,
      })
    ).toEqual({ address: '8.8.8.8', family: 4 });
    expect(
      pickRelayConnectAddress({
        hostname: 'enso-relay.j3.do',
        cache: { address: '1.1.1.1', family: 4 },
        lookup: null,
        skipLookup: false,
      })
    ).toEqual({ address: '1.1.1.1', family: 4 });
  });
});

describe('shouldUsePinnedRelaySocket', () => {
  it('只有 DNS 不可用且已有解析结果时才钉 IP，避免绕过 Chromium 代理', () => {
    const resolved = { address: '1.2.3.4', family: 4 as const };
    expect(
      shouldUsePinnedRelaySocket({
        hostname: 'enso-relay.j3.do',
        resolved,
        skipLookup: true,
        lookupFailed: false,
      })
    ).toBe(true);
    expect(
      shouldUsePinnedRelaySocket({
        hostname: 'enso-relay.j3.do',
        resolved,
        skipLookup: false,
        lookupFailed: true,
      })
    ).toBe(true);
    expect(
      shouldUsePinnedRelaySocket({
        hostname: 'enso-relay.j3.do',
        resolved,
        skipLookup: false,
        lookupFailed: false,
      })
    ).toBe(false);
    expect(
      shouldUsePinnedRelaySocket({
        hostname: 'enso-relay.j3.do',
        resolved: null,
        skipLookup: true,
        lookupFailed: true,
      })
    ).toBe(false);
    expect(
      shouldUsePinnedRelaySocket({
        hostname: '1.2.3.4',
        resolved,
        skipLookup: true,
        lookupFailed: true,
      })
    ).toBe(false);
  });
});

describe('createCachedHostLookup', () => {
  it('字面量不查 DNS', async () => {
    const lookup = createCachedHostLookup({
      cache: new Map(),
      readNameservers: () => ['1.1.1.1'],
      lookup: () => {
        throw new Error('should not lookup');
      },
    });
    await expect(lookup('8.8.8.8')).resolves.toEqual({ address: '8.8.8.8', family: 4 });
  });

  it('MagicDNS 独占且有缓存时不查 DNS', async () => {
    const cache = new Map([['enso-relay.j3.do', { address: '9.9.9.9', family: 4 as const }]]);
    const lookup = createCachedHostLookup({
      cache,
      readNameservers: () => ['100.100.100.100'],
      lookup: () => {
        throw new Error('should not lookup');
      },
    });
    await expect(lookup('enso-relay.j3.do')).resolves.toEqual({
      address: '9.9.9.9',
      family: 4,
    });
  });

  it('lookup 成功写入缓存；失败回落缓存', async () => {
    const cache = new Map<string, { address: string; family: 4 | 6 }>();
    const lookup = createCachedHostLookup({
      cache,
      readNameservers: () => ['1.1.1.1'],
      lookup: async (hostname) => {
        if (hostname === 'ok.example') return { address: '1.2.3.4', family: 4 };
        throw new Error('ENOTFOUND');
      },
    });
    await expect(lookup('ok.example')).resolves.toEqual({ address: '1.2.3.4', family: 4 });
    expect(cache.get('ok.example')).toEqual({ address: '1.2.3.4', family: 4 });

    cache.set('dead.example', { address: '5.5.5.5', family: 4 });
    await expect(lookup('dead.example')).resolves.toEqual({ address: '5.5.5.5', family: 4 });
  });
});

describe('relay host cache 落盘形状', () => {
  it('丢掉脏条目，往返合法记录', () => {
    const parsed = parseRelayHostCache({
      'enso-relay.j3.do': { address: '1.2.3.4', family: 4 },
      bad: { address: 'nope', family: 4 },
      empty: null,
    });
    expect(parsed.get('enso-relay.j3.do')).toEqual({ address: '1.2.3.4', family: 4 });
    expect(parsed.has('bad')).toBe(false);
    expect(JSON.parse(serializeRelayHostCache(parsed))).toEqual({
      'enso-relay.j3.do': { address: '1.2.3.4', family: 4 },
    });
  });
});
