import { describe, expect, it } from 'vitest';
import { setupPin } from './pin.testUtils';

/** npm 安装的 server 宿主：更新渠道/优雅重启出现，自动重启档位隐藏 */
describe('server 更新能力显示（npm 安装）', { timeout: 30_000 }, () => {
  const pin = setupPin({
    pages: async () => ({ general: (await import('./GeneralSettings')).GeneralSettings }),
    results: {
      'electronAPI.sourceAuthority.read': { projects: [], conversations: [] },
      'electronAPI.updater.getState': {
        host: 'server',
        status: null,
        mode: 'npm',
        channel: 'stable',
        restartMethod: 'reexec',
        canRestart: true,
      },
    },
  });

  it('更新渠道/重启服务端/立即重启出现，自动重启档位隐藏（服务端内建等待）', async () => {
    const text = pin.container.textContent ?? '';
    expect(text.includes('Update channel')).toBe(true);
    expect(text.includes('Restart server')).toBe(true);
    expect(text.includes('Restart now')).toBe(true);
    expect(text.includes('Restart automatically to apply updates')).toBe(false);
    expect(pin.rows()).toContain('general.updateChannel');
    // 终端命令/访达快速操作是桌面 Mac 本机集成，服务端宿主下不出现
    expect(pin.rows()).not.toContain('general.ensoCommand');
    expect(pin.rows()).not.toContain('general.finderQuickAction');
  });
});
