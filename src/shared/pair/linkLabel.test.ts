import { describe, expect, it } from 'vitest';
import { formatLinkSubtitle } from './linkLabel';

const t = (key: string) => key;

describe('formatLinkSubtitle', () => {
  it('在线时带通道和延迟', () => {
    expect(formatLinkSubtitle({ state: 'online', transport: 'relay', rttMs: 180.4 }, t)).toBe(
      'Connected · Via relay · 180ms'
    );
    expect(formatLinkSubtitle({ state: 'online', transport: 'direct', rttMs: 0.2 }, t)).toBe(
      'Connected · Direct link · <1ms'
    );
  });

  it('还没有采样时不编一个延迟', () => {
    expect(formatLinkSubtitle({ state: 'online', transport: 'direct', rttMs: null }, t)).toBe(
      'Connected · Direct link'
    );
  });

  it('不在线时只报状态', () => {
    expect(formatLinkSubtitle({ state: 'offline', transport: 'relay', rttMs: 10 }, t)).toBe(
      'Reconnecting…'
    );
    expect(formatLinkSubtitle({ state: 'host-offline', transport: 'relay', rttMs: null }, t)).toBe(
      'Desktop is offline'
    );
    expect(formatLinkSubtitle({ state: 'unauthorized', transport: 'relay', rttMs: null }, t)).toBe(
      'Pairing expired'
    );
  });
});
