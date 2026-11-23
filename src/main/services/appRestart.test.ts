import type { RestartBlocker, RestartWaitReason } from '@shared/types/ipc';
import { describe, expect, it, vi } from 'vitest';

import { type AppRestartState, createAppRestart, restartOverlayFor } from './appRestart';

function setup(overrides: { relaunch?: () => void } = {}) {
  const order: string[] = [];
  const states: AppRestartState[] = [];
  const prepared = Promise.withResolvers<unknown>();
  let onWaitingForTools:
    | ((reason?: RestartWaitReason, blockers?: RestartBlocker[]) => void)
    | undefined;
  const reasons: Array<string | undefined> = [];
  const host = {
    allowQuit: vi.fn(() => order.push('allowQuit')),
    relaunch: vi.fn(overrides.relaunch ?? (() => order.push('relaunch'))),
    quit: vi.fn(() => order.push('quit')),
    prepareQuit: vi.fn(
      (waiting: (reason?: RestartWaitReason, blockers?: RestartBlocker[]) => void) => {
        order.push('prepareQuit');
        onWaitingForTools = waiting;
        return prepared.promise;
      }
    ),
    stateChanged: vi.fn(
      (state: AppRestartState, reason?: RestartWaitReason, _blockers?: RestartBlocker[]) => {
        states.push(state);
        reasons.push(reason);
      }
    ),
    abandonPrepare: vi.fn(() => order.push('abandonPrepare')),
  };
  return {
    host,
    order,
    states,
    reasons,
    prepared,
    waitingForTools: (reason?: RestartWaitReason, blockers?: RestartBlocker[]) =>
      onWaitingForTools?.(reason, blockers),
    restart: createAppRestart(host),
  };
}

describe('createAppRestart', () => {
  it('先等安全点再放行关窗确认并退出整个应用；没有工具在跑不进等待态', async () => {
    const { order, states, prepared, restart, host } = setup();
    expect(restart.state).toBe('idle');
    expect(restart.restart()).toBe('restarting');
    expect(restart.state).toBe('restarting');
    expect(order).toEqual(['relaunch', 'prepareQuit']);
    prepared.resolve('checkpointed');
    await vi.waitFor(() => expect(host.quit).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['relaunch', 'prepareQuit', 'allowQuit', 'quit']);
    expect(states).toEqual(['restarting']);
  });

  it('有命令在跑：进入等待态（弹层），命令结束后先退出等待态再退出', async () => {
    const { order, states, prepared, restart, host, waitingForTools } = setup();
    restart.restart();
    waitingForTools();
    expect(restart.state).toBe('waiting-for-tools');
    expect(states).toEqual(['restarting', 'waiting-for-tools']);
    // 再报一次不重复通知
    waitingForTools();
    expect(states).toEqual(['restarting', 'waiting-for-tools']);
    await Promise.resolve();
    expect(host.quit).not.toHaveBeenCalled();

    prepared.resolve('checkpointed');
    await vi.waitFor(() => expect(host.quit).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['relaunch', 'prepareQuit', 'allowQuit', 'quit']);
    expect(states).toEqual(['restarting', 'waiting-for-tools', 'restarting']);
    expect(restart.state).toBe('restarting');
  });

  it('等待中强制退出：不等命令，立刻结束等待并退出；命令随后结束也不再退第二次', async () => {
    const { order, states, prepared, restart, host, waitingForTools } = setup();
    expect(restart.forceQuit()).toBe(false);
    restart.restart();
    waitingForTools();
    expect(restart.forceQuit()).toBe(true);
    expect(order).toEqual(['relaunch', 'prepareQuit', 'abandonPrepare', 'allowQuit', 'quit']);
    expect(states).toEqual(['restarting', 'waiting-for-tools', 'restarting']);
    expect(restart.forceQuit()).toBe(false);
    prepared.resolve('timeout');
    await Promise.resolve();
    await Promise.resolve();
    expect(host.quit).toHaveBeenCalledTimes(1);
    expect(host.relaunch).toHaveBeenCalledTimes(1);
  });

  it('强制退出时结束等待出错：记日志照常退出，不卡住', () => {
    const { restart, host, waitingForTools } = setup();
    host.abandonPrepare.mockImplementation(() => {
      throw new Error('boom');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    restart.restart();
    waitingForTools();
    expect(restart.forceQuit()).toBe(true);
    expect(host.quit).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
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

  it('等待原因变了（改等脱离不了的转后台命令）：再通知一次弹层，带上原因', () => {
    const { states, reasons, restart, waitingForTools } = setup();
    restart.restart();
    waitingForTools('tool');
    waitingForTools('background-not-detachable');
    waitingForTools('background-not-detachable');
    expect(states).toEqual(['restarting', 'waiting-for-tools', 'waiting-for-tools']);
    expect(reasons).toEqual([undefined, 'tool', 'background-not-detachable']);
  });

  it('弹层：没有命令在跑，点下去立刻是「正在重启」', () => {
    const { host, restart } = setup();
    restart.restart();
    expect(host.stateChanged.mock.calls.map(([s, r]) => restartOverlayFor(s, r))).toEqual([
      { phase: 'restarting' },
    ]);
  });

  it('弹层：有命令在跑，先「正在等当前命令结束」，等到了切成「正在重启」', async () => {
    const { host, prepared, restart, waitingForTools } = setup();
    restart.restart();
    waitingForTools('tool');
    prepared.resolve('checkpointed');
    await vi.waitFor(() => expect(host.quit).toHaveBeenCalledTimes(1));
    expect(host.stateChanged.mock.calls.map(([s, r]) => restartOverlayFor(s, r))).toEqual([
      { phase: 'restarting' },
      { phase: 'waiting', reason: 'tool', exit: 'restart' },
      { phase: 'restarting' },
    ]);
    expect(restartOverlayFor('idle')).toBeNull();
    expect(restartOverlayFor('waiting-for-tools')).toEqual({
      phase: 'waiting',
      reason: 'tool',
      exit: 'restart',
    });
  });

  it('挡住的会话变了：原因没变也再通知，并写进弹层', () => {
    const first = [{ sessionId: 's1', kind: 'tool' as const, tools: ['bash'] }];
    const next = [{ sessionId: 's1', kind: 'tool' as const, tools: ['ask_user'] }];
    const { host, restart, waitingForTools } = setup();
    restart.restart();
    waitingForTools('tool', first);
    waitingForTools('tool', first);
    waitingForTools('tool', next);
    expect(
      host.stateChanged.mock.calls.map(([state, reason, blockers]) =>
        restartOverlayFor(state, reason, blockers)
      )
    ).toEqual([
      { phase: 'restarting' },
      { phase: 'waiting', reason: 'tool', exit: 'restart', blockers: first },
      { phase: 'waiting', reason: 'tool', exit: 'restart', blockers: next },
    ]);
  });
});
