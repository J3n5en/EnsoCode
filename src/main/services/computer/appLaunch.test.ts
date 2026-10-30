import { describe, expect, it } from 'vitest';
import { backgroundOpenArgs, resolveOpenArgs, resolveSettingsPaneUrl } from './appLaunch';

describe('resolveOpenArgs', () => {
  it('系统设置走 bundle id，不把本地化名传给 open -a', () => {
    expect(resolveOpenArgs('系统设置')).toEqual(['-b', 'com.apple.systempreferences']);
    expect(resolveOpenArgs('System Settings')).toEqual(['-b', 'com.apple.systempreferences']);
    expect(resolveOpenArgs('System Preferences')).toEqual(['-b', 'com.apple.systempreferences']);
  });

  it('访达走 Finder bundle', () => {
    expect(resolveOpenArgs('访达')).toEqual(['-b', 'com.apple.finder']);
    expect(resolveOpenArgs('Finder')).toEqual(['-b', 'com.apple.finder']);
  });

  it('未知应用仍 open -a 原名', () => {
    expect(resolveOpenArgs('Safari')).toEqual(['-a', 'Safari']);
  });

  it('显示器使用系统设置面板，而不是只打开应用', () => {
    expect(resolveOpenArgs('系统设置', { pane: '显示器' })).toEqual([
      'x-apple.systempreferences:com.apple.Displays-Settings.extension',
    ]);
    expect(resolveSettingsPaneUrl('显示器')).toBe(resolveSettingsPaneUrl('displays'));
  });

  it('未知面板明确失败，不静默打开错误页面', () => {
    expect(() => resolveOpenArgs('系统设置', { pane: 'unknown-pane' })).toThrow(
      /unsupported.*pane/i
    );
  });

  it('系统设置 pane 走 appearance URL', () => {
    expect(resolveSettingsPaneUrl('外观')).toMatch(/Appearance-Settings/);
    expect(resolveSettingsPaneUrl('Appearance')).toMatch(/Appearance-Settings/);
    expect(resolveSettingsPaneUrl('锁屏')).toMatch(/Lock-Screen-Settings/);
    expect(resolveSettingsPaneUrl('Lock Screen')).toMatch(/Lock-Screen-Settings/);
    expect(resolveSettingsPaneUrl('电池')).toMatch(/Battery-Settings/);
    expect(resolveSettingsPaneUrl('nope')).toBeUndefined();
  });
});

describe('backgroundOpenArgs', () => {
  it('打开应用与设置面板都不激活目标（open -g），用户前台不变', () => {
    expect(backgroundOpenArgs('Safari')).toEqual(['-g', '-a', 'Safari']);
    expect(backgroundOpenArgs('系统设置', { pane: '外观' })).toEqual([
      '-g',
      'x-apple.systempreferences:com.apple.Appearance-Settings.extension',
    ]);
  });
});
