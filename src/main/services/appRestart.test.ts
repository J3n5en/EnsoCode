import { describe, expect, it, vi } from 'vitest';

import { type AppRestartState, createAppRestart } from './appRestart';

function setup(overrides: { relaunch?: () => void } = {}) {
  const order: string[] = [];
  const states: AppRestartState[] = [];
  const prepared = Promise.withResolvers<unknown>();
  let onWaitingForTools: (() => void) | undefined;
  const host = {
    allowQuit: vi.fn(() => order.push('allowQuit')),
    relaunch: vi.fn(overrides.relaunch ?? (() => order.push('relaunch'))),
    quit: vi.fn(() => order.push('quit')),
    prepareQuit: vi.fn((waiting: () => void) => {
      order.push('prepareQuit');
      onWaitingForTools = waiting;
      return prepared.promise;
    }),
    stateChanged: vi.fn((state: AppRestartState) => states.push(state)),
    notifyWaitingForTools: vi.fn(() => order.push('notify')),
  };
  return {
    host,
    order,
    states,
    prepared,
    waitingForTools: () => onWaitingForTools?.(),
    restart: createAppRestart(host),
  };
}

describe('createAppRestart', () => {
  it('先等安全点再放行关窗确认并退出整个应用；没有工具在跑不提示', async () => {
    const { order, prepared, restart, host } = setup();
    expect(restart.state).toBe('idle');
    expect(restart.restart()).toBe('restarting');
    expect(restart.state).toBe('restarting');
    expect(order).toEqual(['relaunch', 'prepareQuit']);
    prepared.resolve('checkpointed');
    await vi.waitFor(() => expect(host.quit).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['relaunch', 'prepareQuit', 'allowQuit', 'quit']);
    expect(host.notifyWaitingForTools).not.toHaveBeenCalled();
  });

  it('有命令在跑：立刻提示会等它结束，菜单进入等待状态，命令结束后才退出', async () => {
    const { order, states, prepared, restart, host, waitingForTools } = setup();
    restart.restart();
    waitingForTools();
    expect(restart.state).toBe('waiting-for-tools');
    expect(states).toEqual(['restarting', 'waiting-for-tools']);
    expect(host.notifyWaitingForTools).toHaveBeenCalledTimes(1);
    // 再报一次也只提示一次
    waitingForTools();
    expect(host.notifyWaitingForTools).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(host.quit).not.toHaveBeenCalled();

    prepared.resolve('checkpointed');
    await vi.waitFor(() => expect(host.quit).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['relaunch', 'prepareQuit', 'notify', 'allowQuit', 'quit']);
    expect(restart.state).toBe('restarting');
  });

  it('等安全点出错：记日志后照常重启', async () => {
    const { prepared, restart, host } = setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    restart.restart();
    prepared.reject(new Error('boom'));
    await vi.waitFor(() => expect(host.quit).toHaveBeenCalledTimes(1));
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('重启进行中再点：不再登记第二次 relaunch，不起两个进程', async () => {
    const { host, prepared, restart, waitingForTools } = setup();
    restart.restart();
    expect(restart.restart()).toBe('already-restarting');
    waitingForTools();
    expect(restart.restart()).toBe('already-restarting');
    prepared.resolve('timeout');
    await vi.waitFor(() => expect(host.quit).toHaveBeenCalledTimes(1));
    expect(host.relaunch).toHaveBeenCalledTimes(1);
    expect(host.prepareQuit).toHaveBeenCalledTimes(1);
  });

  it('relaunch 失败：异常抛给调用方，不退出、不放行关窗确认，之后还能再试', () => {
    const { host, restart } = setup({
      relaunch: () => {
        throw new Error('boom');
      },
    });
    expect(() => restart.restart()).toThrow('boom');
    expect(host.prepareQuit).not.toHaveBeenCalled();
    expect(host.allowQuit).not.toHaveBeenCalled();
    expect(host.quit).not.toHaveBeenCalled();
    expect(restart.state).toBe('idle');
  });
});
