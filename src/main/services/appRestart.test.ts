import { describe, expect, it, vi } from 'vitest';

import { createAppRestart } from './appRestart';

function setup(overrides: { relaunch?: () => void } = {}) {
  const order: string[] = [];
  const host = {
    allowQuit: vi.fn(() => order.push('allowQuit')),
    relaunch: vi.fn(overrides.relaunch ?? (() => order.push('relaunch'))),
    quit: vi.fn(() => order.push('quit')),
  };
  return { host, order, restart: createAppRestart(host) };
}

describe('createAppRestart', () => {
  it('登记重新打开后放行关窗确认并退出整个应用（退出收尾里等安全点、写恢复清单）', () => {
    const { order, restart } = setup();
    expect(restart.restarting).toBe(false);
    expect(restart.restart()).toBe('restarting');
    expect(order).toEqual(['relaunch', 'allowQuit', 'quit']);
    expect(restart.restarting).toBe(true);
  });

  it('重启进行中再点：不再登记第二次 relaunch，不起两个进程', () => {
    const { host, restart } = setup();
    restart.restart();
    expect(restart.restart()).toBe('already-restarting');
    expect(host.relaunch).toHaveBeenCalledTimes(1);
    expect(host.quit).toHaveBeenCalledTimes(1);
  });

  it('relaunch 失败：异常抛给调用方，不退出、不放行关窗确认，之后还能再试', () => {
    const { host, restart } = setup({
      relaunch: () => {
        throw new Error('boom');
      },
    });
    expect(() => restart.restart()).toThrow('boom');
    expect(host.allowQuit).not.toHaveBeenCalled();
    expect(host.quit).not.toHaveBeenCalled();
    expect(restart.restarting).toBe(false);
  });
});
