import { describe, expect, it } from 'vitest';
import { setupPin } from './pin.testUtils';

/** 更新渠道行：服务端宿主也要显示（原来只在桌面宿主显示） */
describe('更新渠道设置行', { timeout: 30_000 }, () => {
  const pin = setupPin({
    pages: async () => ({ general: (await import('./GeneralSettings')).GeneralSettings }),
    results: {
      'electronAPI.sourceAuthority.read': { projects: [], conversations: [] },
      'electronAPI.updater.getState': {
        host: 'server',
        status: null,
        mode: 'npm',
        channel: 'stable',
      },
    },
  });

  it('server 宿主下显示渠道行，选择内测写入 store 并调用 updater:setChannel', async () => {
    expect(pin.rows()).toContain('general.updateChannel');
    const controls = await pin.probe();
    const row = controls.find((c) => c.row === 'general.updateChannel');
    expect(row, 'channel control').toBeTruthy();
    expect(row?.current).toEqual({ updateChannel: 'stable' });
    const betaEffect = row?.effects.find((e) => JSON.stringify(e).includes('beta'));
    expect(betaEffect, 'selecting beta').toBeTruthy();
    expect(betaEffect).toContain('"updateChannel":"beta"');
    expect(betaEffect).toContain('updater.setChannel');
  });
});
