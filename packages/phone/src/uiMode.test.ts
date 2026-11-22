import { beforeEach, describe, expect, it } from 'vitest';
import type { StoredDevice } from './deviceList';
import {
  deskUrl,
  launchTarget,
  loadUiMode,
  PAIR_FROM_DESK_URL,
  PHONE_URL,
  saveUiMode,
} from './uiMode';

function memoryStorage(): void {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  });
}

const device = (pairId: string, scope?: 'read' | 'operate') =>
  ({ pairId, label: pairId, scope }) as unknown as StoredDevice;

describe('uiMode', () => {
  beforeEach(memoryStorage);

  it('defaults to phone and persists only valid modes', () => {
    expect(loadUiMode()).toBe('phone');
    saveUiMode('desk');
    expect(loadUiMode()).toBe('desk');
    localStorage.setItem('enso-phone-ui-mode', 'garbage');
    expect(loadUiMode()).toBe('phone');
  });

  it('reopens desk mode on the active operate device', () => {
    const devices = [device('a'), device('b', 'operate')];
    expect(launchTarget('', 'desk', devices, 'b')).toBe(deskUrl('b'));
    expect(deskUrl('a/b')).toBe('/desk?device=a%2Fb');
  });

  it('stays on phone when mode is phone, no usable device, or an explicit phone link', () => {
    expect(launchTarget('', 'phone', [device('a')], 'a')).toBeNull();
    expect(launchTarget('', 'desk', [], null)).toBeNull();
    expect(launchTarget('', 'desk', [device('a', 'read')], 'a')).toBeNull();
    expect(launchTarget(PHONE_URL.slice(1), 'desk', [device('a')], 'a')).toBeNull();
    expect(launchTarget('?session=s1&mode=phone', 'desk', [device('a')], 'a')).toBeNull();
  });

  it('从完整版去配对新电脑时留在精简版，且不改记住的模式', () => {
    saveUiMode('desk');
    expect(launchTarget(PAIR_FROM_DESK_URL.slice(1), 'desk', [device('a')], 'a')).toBeNull();
    expect(loadUiMode()).toBe('desk');
  });

  it('keeps a notification deep link inside desk mode', () => {
    expect(launchTarget('?session=s1', 'desk', [device('a')], 'a')).toBe(
      '/desk?device=a&session=s1'
    );
    expect(launchTarget('?session=s1', 'phone', [device('a')], 'a')).toBeNull();
    expect(launchTarget('?session=s1', 'desk', [device('a', 'read')], 'a')).toBeNull();
    expect(launchTarget('?session=bad id', 'desk', [device('a')], 'a')).toBe('/desk?device=a');
  });
});
