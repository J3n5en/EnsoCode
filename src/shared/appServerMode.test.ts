import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  firstExistingPath,
  isTrayTemplatePath,
  shouldStayAliveOnWindowAllClosed,
  trayClickAction,
  trayIconCandidates,
} from './appServerMode';

describe('shouldStayAliveOnWindowAllClosed', () => {
  it('keeps the process in server mode on every platform', () => {
    expect(shouldStayAliveOnWindowAllClosed({ serverMode: true, platform: 'win32' })).toBe(true);
    expect(shouldStayAliveOnWindowAllClosed({ serverMode: true, platform: 'linux' })).toBe(true);
  });

  it('keeps macOS alive without server mode, and quits Windows/Linux', () => {
    expect(shouldStayAliveOnWindowAllClosed({ serverMode: false, platform: 'darwin' })).toBe(true);
    expect(shouldStayAliveOnWindowAllClosed({ serverMode: false, platform: 'win32' })).toBe(false);
    expect(shouldStayAliveOnWindowAllClosed({ serverMode: false, platform: 'linux' })).toBe(false);
  });
});

describe('trayClickAction', () => {
  it('hides to tray when the window is showing, and shows when already in tray', () => {
    expect(trayClickAction({ serverMode: false, windowShown: true })).toBe('hide');
    expect(trayClickAction({ serverMode: true, windowShown: false })).toBe('show');
  });

  it('窗口被别处藏起（非托盘模式）时也唤回，而不是再进托盘', () => {
    expect(trayClickAction({ serverMode: false, windowShown: false })).toBe('show');
  });
});

describe('trayIconCandidates', () => {
  it('macOS 只用 ensō template，不用实心 App 图标', () => {
    const candidates = trayIconCandidates({
      appPath: '/app',
      resourcesPath: '/Resources',
      moduleDir: '/repo/out/main',
      cwd: '/repo',
      platform: 'darwin',
    });
    expect(candidates[0]).toBe(path.join('/Resources', 'trayTemplate.png'));
    expect(candidates).toContain(path.join('/repo', 'build', 'trayTemplate.png'));
    expect(candidates.some((file) => file.includes('32x32.png') || file.endsWith('icon.png'))).toBe(
      false
    );
  });

  it('非 macOS 在 template 之后才回落到彩色 App 图标', () => {
    const candidates = trayIconCandidates({
      appPath: '/app',
      resourcesPath: '/Resources',
      moduleDir: '/repo/out/main',
      cwd: '/repo',
      platform: 'win32',
    });
    expect(candidates[0]).toBe(path.join('/Resources', 'trayTemplate.png'));
    expect(candidates).toContain(path.join('/Resources', 'tray-icon.png'));
    expect(candidates.indexOf(path.join('/repo', 'build', 'icons', '32x32.png'))).toBeLessThan(
      candidates.indexOf(path.join('/repo', 'build', 'icon.png'))
    );
  });

  it('picks the first path that exists and returns null when none do', () => {
    const hit = path.join('/repo', 'build', 'icons', '32x32.png');
    expect(firstExistingPath(['/missing.png', hit], (file) => file === hit)).toBe(hit);
    expect(firstExistingPath(['/missing.png'], () => false)).toBeNull();
  });

  it('recognizes Electron template filenames', () => {
    expect(isTrayTemplatePath('/Resources/trayTemplate.png')).toBe(true);
    expect(isTrayTemplatePath('/Resources/trayTemplate@2x.png')).toBe(true);
    expect(isTrayTemplatePath('/Resources/tray-icon.png')).toBe(false);
  });
});
