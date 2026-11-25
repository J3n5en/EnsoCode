import { describe, expect, it } from 'vitest';
import { setupPin } from './pin.testUtils';

/** server 宿主按真实能力显示更新控件：不能自更新的安装不该出现「自动更新」可用开关 */
describe('server 更新能力显示', { timeout: 30_000 }, () => {
  const pin = setupPin({
    pages: async () => ({ general: (await import('./GeneralSettings')).GeneralSettings }),
    results: {
      'electronAPI.sourceAuthority.read': { projects: [], conversations: [] },
      'electronAPI.updater.getState': {
        host: 'server',
        status: null,
        mode: 'manual',
        channel: 'stable',
        restartMethod: 'manual',
        canRestart: false,
      },
    },
  });

  it('manual 安装：自动更新开关被禁用，「重启服务端」不出现', async () => {
    const doc = pin.container;
    const switches = [...doc.querySelectorAll('[role="switch"]')] as HTMLElement[];
    // 找到「自动更新」行里的开关：其所在行带 general.updates 小节但行无 rowId，用文本定位
    const text = doc.textContent ?? '';
    expect(text).toContain('Automatic updates');
    // 手动安装的开关 disabled
    const manualNote = text.includes('it cannot update itself') || text.includes('Not available');
    expect(manualNote).toBe(true);
    const disabledSwitch = switches.some((sw) => sw.hasAttribute('disabled'));
    expect(disabledSwitch).toBe(true);
    // 不能重启时不显示「重启服务端」
    expect(text).not.toContain('Restart server?');
    expect(text.includes('Restart server')).toBe(false);
  });
});
