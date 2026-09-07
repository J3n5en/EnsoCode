import { describe, expect, it, vi } from 'vitest';
import { openPairRelayWebSocket } from './pairRelayOpen';

describe('openPairRelayWebSocket', () => {
  it('DNS 正常时走域名 socket，不钉 IP', async () => {
    const openNamed = vi.fn(() => ({ kind: 'named' }) as unknown as WebSocket);
    const openPinned = vi.fn(() => ({ kind: 'pinned' }) as unknown as WebSocket);
    const ws = await openPairRelayWebSocket('wss://enso-relay.j3.do/v1/pair/p1?role=host', {
      resolveTarget: async () => ({
        hostname: 'enso-relay.j3.do',
        resolved: { address: '1.2.3.4', family: 4 },
        pin: false,
      }),
      openNamed,
      openPinned,
    });
    expect(ws).toEqual({ kind: 'named' });
    expect(openNamed).toHaveBeenCalledWith('wss://enso-relay.j3.do/v1/pair/p1?role=host');
    expect(openPinned).not.toHaveBeenCalled();
  });

  it('DNS 挂了时钉 IP，并把原域名交给 pinned opener（SNI / Host）', async () => {
    const openNamed = vi.fn(() => ({ kind: 'named' }) as unknown as WebSocket);
    const openPinned = vi.fn(() => ({ kind: 'pinned' }) as unknown as WebSocket);
    const ws = await openPairRelayWebSocket('wss://enso-relay.j3.do/v1/pair/p1?role=host', {
      resolveTarget: async () => ({
        hostname: 'enso-relay.j3.do',
        resolved: { address: '1.2.3.4', family: 4 },
        pin: true,
      }),
      openNamed,
      openPinned,
    });
    expect(ws).toEqual({ kind: 'pinned' });
    expect(openPinned).toHaveBeenCalledWith(
      'wss://1.2.3.4/v1/pair/p1?role=host',
      'enso-relay.j3.do',
      ''
    );
    expect(openNamed).not.toHaveBeenCalled();
  });
});
