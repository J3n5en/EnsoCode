import { DirectLink, type DirectSignal } from '@enso/pair';
import { describe, expect, it } from 'vitest';
import { isDirectPeerAvailable, mainDirectPeerFactory, preloadDirectPeer } from './pairDirectPeer';

/**
 * 真 node-datachannel 回环：guest/host 两个 DirectLink 用 loopback 信令直连，
 * 验证 offer/answer/trickle ICE/分片/双向收发在原生栈上跑得通。
 */
describe('node-datachannel 回环直连', () => {
  it('两端建立 DataChannel 并互发 20KB 帧（分片）', async () => {
    await preloadDirectPeer();
    if (!isDirectPeerAvailable()) return;

    const hostFrames: Uint8Array[] = [];
    const guestFrames: Uint8Array[] = [];
    const transports: string[] = [];
    let host: DirectLink;
    const relay = (to: () => DirectLink) => (s: DirectSignal) => {
      setTimeout(() => to().handleSignal(s), 0);
    };
    const guest = new DirectLink({
      role: 'guest',
      factory: mainDirectPeerFactory,
      sendSignal: relay(() => host),
      onFrame: (f) => guestFrames.push(f),
      onTransportChange: (t) => transports.push(`guest:${t}`),
      onResync: () => {},
    });
    host = new DirectLink({
      role: 'host',
      factory: mainDirectPeerFactory,
      iceServers: [],
      sendSignal: relay(() => guest),
      onFrame: (f) => hostFrames.push(f),
      onTransportChange: (t) => transports.push(`host:${t}`),
      onResync: () => {},
    });

    guest.peerOnline(true);
    guest.hostInfo({ capabilities: ['direct-v1'], iceServers: [] });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (guest.transport() === 'direct' && host.transport() === 'direct') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(guest.transport()).toBe('direct');
    expect(host.transport()).toBe('direct');

    const big = new Uint8Array(20_000).map((_, i) => i & 0xff);
    expect(guest.send(big)).toBe(true);
    expect(host.send(new Uint8Array([7, 8, 9]))).toBe(true);
    const until = Date.now() + 5_000;
    while (Date.now() < until && (hostFrames.length === 0 || guestFrames.length === 0)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(hostFrames[0]).toEqual(big);
    expect(guestFrames[0]).toEqual(new Uint8Array([7, 8, 9]));

    guest.close();
    host.close();
  }, 20_000);

  it('大流量突发触发 SCTP 发送缓冲时不误拆直连，已接收帧完整到达', async () => {
    await preloadDirectPeer();
    if (!isDirectPeerAvailable()) return;

    const guestFrames: Uint8Array[] = [];
    const transports: string[] = [];
    let host: DirectLink;
    const relay = (to: () => DirectLink) => (s: DirectSignal) => {
      setTimeout(() => to().handleSignal(s), 0);
    };
    const guest = new DirectLink({
      role: 'guest',
      factory: mainDirectPeerFactory,
      sendSignal: relay(() => host),
      onFrame: (f) => guestFrames.push(f),
      onTransportChange: (t) => transports.push(`guest:${t}`),
      onResync: () => {},
    });
    host = new DirectLink({
      role: 'host',
      factory: mainDirectPeerFactory,
      iceServers: [],
      sendSignal: relay(() => guest),
      onFrame: () => {},
      onTransportChange: (t) => transports.push(`host:${t}`),
      onResync: () => {},
    });

    guest.peerOnline(true);
    guest.hostInfo({ capabilities: ['direct-v1'], iceServers: [] });

    const openDeadline = Date.now() + 10_000;
    while (Date.now() < openDeadline) {
      if (guest.transport() === 'direct' && host.transport() === 'direct') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(guest.transport()).toBe('direct');
    expect(host.transport()).toBe('direct');
    transports.length = 0;

    // 连续突发超过 SCTP 初始窗口的大帧，必然触发 libdatachannel send() 返回 false（已入缓冲）
    const sent: Uint8Array[] = [];
    for (let i = 0; i < 12; i++) {
      const frame = new Uint8Array(180_000).fill((i + 1) & 0xff);
      if (host.send(frame)) sent.push(frame);
    }
    expect(sent.length).toBeGreaterThanOrEqual(7);

    const recvDeadline = Date.now() + 10_000;
    while (Date.now() < recvDeadline && guestFrames.length < sent.length) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(transports).toEqual([]);
    expect(host.transport()).toBe('direct');
    expect(guest.transport()).toBe('direct');
    expect(guestFrames.length).toBe(sent.length);
    for (let i = 0; i < sent.length; i++) {
      expect(guestFrames[i]).toEqual(sent[i]);
    }

    guest.close();
    host.close();
  }, 20_000);
});
