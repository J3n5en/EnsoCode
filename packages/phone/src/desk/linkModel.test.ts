import { describe, expect, it } from 'vitest';
import {
  initialDeskLink,
  parsePushPending,
  parseRemotePushSubscription,
  reduceDeskLink,
  toRemoteLinkStatus,
} from './linkModel';

describe('reduceDeskLink', () => {
  it('相同采样不换对象', () => {
    const model = reduceDeskLink(initialDeskLink('电脑 1', false), { type: 'rtt', rttMs: 40 });
    expect(reduceDeskLink(model, { type: 'rtt', rttMs: 40 })).toBe(model);
    expect(reduceDeskLink(model, { type: 'state', state: 'connecting' })).toBe(model);
  });

  it('记下通道、延迟和桌面公钥', () => {
    let model = initialDeskLink('电脑 1', true);
    model = reduceDeskLink(model, { type: 'state', state: 'online' });
    model = reduceDeskLink(model, { type: 'transport', transport: 'direct' });
    model = reduceDeskLink(model, { type: 'rtt', rttMs: 32 });
    model = reduceDeskLink(model, { type: 'push-config', key: 'vapid' });
    expect(toRemoteLinkStatus(model, 'ok')).toMatchObject({
      deviceLabel: '电脑 1',
      state: 'online',
      transport: 'direct',
      rttMs: 32,
      pushReady: true,
      pushEnabled: true,
      pushAvailability: 'ok',
    });
  });

  it('推送失败时关掉开关并留下原因', () => {
    const model = reduceDeskLink(initialDeskLink('电脑 1', false), {
      type: 'push',
      enabled: false,
      busy: false,
      error: 'permission-denied',
    });
    expect(model).toMatchObject({
      pushEnabled: false,
      pushBusy: false,
      pushError: 'permission-denied',
    });
  });
});

describe('parseRemotePushSubscription', () => {
  const ok = { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } };

  it('收下完整订阅', () => {
    expect(parseRemotePushSubscription(ok)).toEqual(ok);
  });

  it('丢掉缺字段和空串', () => {
    expect(parseRemotePushSubscription(null)).toBeNull();
    expect(parseRemotePushSubscription({ endpoint: '', keys: ok.keys })).toBeNull();
    expect(
      parseRemotePushSubscription({ endpoint: ok.endpoint, keys: { p256dh: 'p' } })
    ).toBeNull();
    expect(parseRemotePushSubscription({ endpoint: ok.endpoint })).toBeNull();
  });
});

describe('parsePushPending', () => {
  it('只收布尔开关和已知错误', () => {
    expect(parsePushPending({ busy: true, enabled: true, error: null })).toEqual({
      busy: true,
      enabled: true,
      error: null,
    });
    expect(parsePushPending({ busy: false, enabled: false, error: 'nope' })).toBeNull();
    expect(parsePushPending({ busy: 'yes', enabled: true, error: null })).toBeNull();
  });
});
