import electronVitePackage from 'electron-vite/package.json';
import vitePackage from 'vite/package.json';
import { describe, expect, it } from 'vitest';
import config from '../../electron.vite.config';

describe('Electron main build topology', () => {
  it('keeps the official single main entry so isolated modulePath builds the agent worker', () => {
    expect(config.main?.build?.rollupOptions?.input).toBeUndefined();
    expect(config.main?.build?.externalizeDeps).toBe(true);
  });

  it('keeps Vite within the installed electron-vite peer range', () => {
    const electronViteMajor = Number(electronVitePackage.version.split('.')[0]);
    const viteMajor = Number(vitePackage.version.split('.')[0]);
    if (electronViteMajor === 5) expect(viteMajor).toBeLessThanOrEqual(7);
  });
});
