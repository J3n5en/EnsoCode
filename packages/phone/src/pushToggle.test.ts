import { describe, expect, it, vi } from 'vitest';
import { PHONE_PUSH_ENABLED_KEY } from './push';
import { type PushToggleDeps, pushHints, turnPushOff, turnPushOn } from './pushToggle';

const subscription = { endpoint: 'https://push/1', keys: { p256dh: 'p', auth: 'a' } };

function deps(ok: boolean): PushToggleDeps & { stored: Map<string, string> } {
  const stored = new Map<string, string>();
  return {
    stored,
    send: vi.fn(),
    storage: { setItem: (key: string, value: string) => void stored.set(key, value) },
    subscribe: vi.fn(async () =>
      ok
        ? { ok: true as const, subscription }
        : { ok: false as const, reason: 'permission-denied' as const }
    ),
    unsubscribe: vi.fn(async () => {}),
  };
}

describe('pushToggle', () => {
  it('开启成功：报给桌面并记住', async () => {
    const d = deps(true);
    const result = await turnPushOn('vapid', d);
    expect(result.ok).toBe(true);
    expect(d.subscribe).toHaveBeenCalledWith('vapid');
    expect(d.send).toHaveBeenCalledWith({ type: 'push-subscribe', subscription });
    expect(d.stored.get(PHONE_PUSH_ENABLED_KEY)).toBe('on');
  });

  it('开启失败：不报也不记', async () => {
    const d = deps(false);
    expect(await turnPushOn('vapid', d)).toEqual({ ok: false, reason: 'permission-denied' });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.stored.has(PHONE_PUSH_ENABLED_KEY)).toBe(false);
  });

  it('关闭：退订并记住', () => {
    const d = deps(true);
    turnPushOff(d);
    expect(d.send).toHaveBeenCalledWith({ type: 'push-unsubscribe' });
    expect(d.unsubscribe).toHaveBeenCalled();
    expect(d.stored.get(PHONE_PUSH_ENABLED_KEY)).toBe('off');
  });

  it('提示按状态给出', () => {
    const base = {
      busy: false,
      error: null,
      availability: 'ok' as const,
      connected: true,
      configReady: true,
    };
    expect(pushHints(base)).toEqual([]);
    expect(pushHints({ ...base, busy: true, error: 'subscribe-failed' })).toEqual([
      { text: '正在开启…', error: false },
    ]);
    expect(pushHints({ ...base, error: 'permission-denied' })[0].error).toBe(true);
    expect(pushHints({ ...base, configReady: false })[0].text).toContain('升级桌面端');
    expect(pushHints({ ...base, availability: 'needs-install' })[0].text).toContain('添加到主屏幕');
  });
});
