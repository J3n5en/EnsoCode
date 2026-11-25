import { describe, expect, it } from 'vitest';
import { setupPin } from './pin.testUtils';

/** server 宿主按真实能力显示更新控件（pin 的 beforeAll 只能挂在 describe 层，两种能力两个文件级别 describe） */
describe('server 更新能力显示（manual 安装）', { timeout: 30_000 }, () => {
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

  it('自动更新开关禁用且显示为关，「重启服务端」不出现，自动重启档位隐藏', async () => {
    const doc = pin.container;
    const switches = [...doc.querySelectorAll('[role="switch"]')] as HTMLElement[];
    const text = doc.textContent ?? '';
    expect(text).toContain('Automatic updates');
    const manualNote = text.includes('it cannot update itself') || text.includes('Not available');
    expect(manualNote).toBe(true);
    const disabledSwitch = switches.some((sw) => sw.hasAttribute('disabled'));
    expect(disabledSwitch).toBe(true);
    // 不能用的开关显示为关（aria-checked=false），不留「开着但禁用」的假象
    const autoSwitch = switches.find((sw) => sw.hasAttribute('disabled'));
    expect(autoSwitch?.getAttribute('aria-checked')).toBe('false');
    // 服务端没有「自动重启以应用更新」档位：该行不出现
    expect(text.includes('Restart automatically to apply updates')).toBe(false);
    // 不能重启时不显示「重启服务端」
    expect(text).not.toContain('Restart server?');
    expect(text.includes('Restart server')).toBe(false);
  });
});
