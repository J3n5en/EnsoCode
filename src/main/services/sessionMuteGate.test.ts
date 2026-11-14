import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = { current: undefined as unknown };

vi.mock('../ipc/settings', () => ({
  readSettings: () => settings.current,
}));

import {
  isSessionMuted,
  resetSessionMuteOverrides,
  setSessionMuteOverride,
} from './sessionMuteGate';

describe('sessionMuteGate', () => {
  beforeEach(() => {
    settings.current = undefined;
    resetSessionMuteOverrides();
  });

  it('没有覆盖时读持久化', () => {
    settings.current = {
      'enso-conversations': { state: { conversations: { a: { muted: true } } } },
    };
    expect(isSessionMuted('a')).toBe(true);
    expect(isSessionMuted('a::cw-x')).toBe(true);
    expect(isSessionMuted('b')).toBe(false);
  });

  it('覆盖优先于磁盘：静音立即生效，取消静音也立即恢复', () => {
    settings.current = {
      'enso-conversations': { state: { conversations: { a: { muted: true } } } },
    };
    setSessionMuteOverride('a', false);
    expect(isSessionMuted('a')).toBe(false);
    setSessionMuteOverride('a::cw-x', true);
    expect(isSessionMuted('a')).toBe(true);
    expect(isSessionMuted('b')).toBe(false);
  });
});
