import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { setupPin } from './pin.testUtils';

/** 手动更新提示里的 npm 命令要随更新渠道走 dist-tag：内测 @beta、正式 @latest */
describe('server 手动更新提示', { timeout: 30_000 }, () => {
  const pin = setupPin({
    pages: async () => ({ general: (await import('./GeneralSettings')).GeneralSettings }),
    results: {
      'electronAPI.sourceAuthority.read': { projects: [], conversations: [] },
      'electronAPI.updater.getState': {
        host: 'server',
        status: null,
        mode: 'manual',
        channel: 'stable',
      },
    },
  });

  const command = () =>
    pin.container.querySelector('[data-server-manual-command]')?.textContent ?? '';

  it('正式渠道显示 @latest', async () => {
    expect(command()).toContain('npm i -g @ensocode/server@latest');
    expect(command()).not.toContain('@beta');
  });

  it('切到内测后显示 @beta', async () => {
    await act(async () => {
      pin.store.getState().setUpdateChannel('beta');
    });
    await pin.settle();
    expect(command()).toContain('npm i -g @ensocode/server@beta');
    expect(command()).not.toContain('@latest');
    await act(async () => {
      pin.store.getState().setUpdateChannel('stable');
    });
  });
});
