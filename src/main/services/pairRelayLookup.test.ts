import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./pairStore', () => ({
  saveRelayHostCache: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('resolveRelayConnectTarget', () => {
  it('MagicDNS 独占且有缓存时跳过 lookup，标记钉 IP', async () => {
    const { resolveRelayConnectTarget, seedRelayHostCache } = await import('./pairRelayLookup');
    seedRelayHostCache({ 'enso-relay.j3.do': { address: '9.9.9.9', family: 4 } });
    const lookup = vi.fn();
    const target = await resolveRelayConnectTarget('enso-relay.j3.do', {
      readNameservers: () => ['100.100.100.100'],
      lookup,
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(target).toEqual({
      hostname: 'enso-relay.j3.do',
      resolved: { address: '9.9.9.9', family: 4 },
      pin: true,
    });
  });

  it('lookup 成功写入缓存；失败回落缓存并钉 IP', async () => {
    const { saveRelayHostCache } = await import('./pairStore');
    const { peekRelayHostCache, resolveRelayConnectTarget } = await import('./pairRelayLookup');
    const target = await resolveRelayConnectTarget('enso-relay.j3.do', {
      readNameservers: () => ['1.1.1.1'],
      lookup: async () => ({ address: '1.2.3.4', family: 4 }),
    });
    expect(target).toEqual({
      hostname: 'enso-relay.j3.do',
      resolved: { address: '1.2.3.4', family: 4 },
      pin: false,
    });
    expect(peekRelayHostCache().get('enso-relay.j3.do')).toEqual({
      address: '1.2.3.4',
      family: 4,
    });
    expect(saveRelayHostCache).toHaveBeenCalledWith(
      new Map([['enso-relay.j3.do', { address: '1.2.3.4', family: 4 }]])
    );

    const fallback = await resolveRelayConnectTarget('enso-relay.j3.do', {
      readNameservers: () => ['1.1.1.1'],
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(fallback).toEqual({
      hostname: 'enso-relay.j3.do',
      resolved: { address: '1.2.3.4', family: 4 },
      pin: true,
    });
  });
});
