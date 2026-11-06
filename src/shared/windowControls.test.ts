import { describe, expect, it } from 'vitest';
import { parseTitleBarAppearance, toTitleBarHex, windowSurfaceColor } from './windowControls';

describe('parseTitleBarAppearance', () => {
  it('accepts opaque RGB colors without forwarding other window options', () => {
    expect(
      parseTitleBarAppearance({ color: '#102030', symbolColor: '#AABBCC', height: 999 })
    ).toEqual({ color: '#102030', symbolColor: '#AABBCC' });
  });

  it('accepts a translucent overlay color so wallpapers show behind native buttons', () => {
    expect(parseTitleBarAppearance({ color: '#10203000', symbolColor: '#ffffff' })).toEqual({
      color: '#10203000',
      symbolColor: '#ffffff',
    });
    expect(parseTitleBarAppearance({ color: '#102030d6', symbolColor: '#ffffff' })).toEqual({
      color: '#102030d6',
      symbolColor: '#ffffff',
    });
  });

  it('accepts an opaque window surface color', () => {
    expect(
      parseTitleBarAppearance({ color: '#00000000', symbolColor: '#ffffff', surface: '#202020' })
    ).toEqual({ color: '#00000000', symbolColor: '#ffffff', surface: '#202020' });
  });

  it.each([
    null,
    [],
    'dark',
    {},
    { color: '#ffffff' },
    { color: '#fff', symbolColor: '#000000' },
    { color: '#fff0', symbolColor: '#000000' },
    { color: '#ffffff0', symbolColor: '#000000' },
    { color: '#ffffff', symbolColor: '#00000000' },
    { color: '#ffffff', symbolColor: '#000000', surface: '#20202000' },
    { color: '#ffffff', symbolColor: '#000000', surface: 'red' },
    { color: 'url(file:///private)', symbolColor: '#000000' },
    { color: '#ffffff', symbolColor: 123 },
  ])('rejects malformed appearance or a translucent symbol color: %j', (input) => {
    expect(parseTitleBarAppearance(input)).toBeNull();
  });
});

describe('toTitleBarHex', () => {
  it('drops the alpha byte for fully opaque pixels', () => {
    expect(toTitleBarHex([16, 32, 48, 255])).toBe('#102030');
  });

  it('keeps the alpha byte for translucent and transparent pixels', () => {
    expect(toTitleBarHex([16, 32, 48, 214])).toBe('#102030d6');
    expect(toTitleBarHex([0, 0, 0, 0])).toBe('#00000000');
  });
});

describe('windowSurfaceColor', () => {
  it('prefers the explicit opaque surface', () => {
    expect(
      windowSurfaceColor({ color: '#00000000', symbolColor: '#fff000', surface: '#f0f0f0' })
    ).toBe('#f0f0f0');
  });

  it('falls back to an opaque overlay color', () => {
    expect(windowSurfaceColor({ color: '#102030', symbolColor: '#ffffff' })).toBe('#102030');
  });

  it('never turns a translucent overlay into the window surface', () => {
    expect(windowSurfaceColor({ color: '#102030d6', symbolColor: '#ffffff' })).toBeNull();
    expect(windowSurfaceColor({ color: '#00000000', symbolColor: '#ffffff' })).toBeNull();
  });
});
