import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUIT_REPLY_IDLE_MS,
  QUIT_REPLY_WAIT_CAP_MS,
  QUIT_REPLY_WAIT_FLOOR_MS,
  QUIT_TOOL_WAIT_LIMIT_MS,
} from './agentQuitLimits';
import {
  createQuitWatchdog,
  QUIT_FINISH_LIMIT_MS,
  QUIT_WATCHDOG_LIMIT_MS,
} from './appQuitWatchdog';

const limits = { totalMs: 60_000, finishMs: 10_000, exitGraceMs: 1_000 };

function setup(options: { exitThrows?: boolean } = {}) {
  const host = {
    relaunch: vi.fn(),
    exit: vi.fn(() => {
      if (options.exitThrows) throw new Error('boom');
    }),
    kill: vi.fn(),
    log: vi.fn(),
    began: vi.fn(),
  };
  return { host, dog: createQuitWatchdog(host, limits) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('退出看门狗', () => {
  it('总上限是工具等待上限再加 30 秒', () => {
    expect(QUIT_WATCHDOG_LIMIT_MS).toBe(QUIT_TOOL_WAIT_LIMIT_MS + 30_000);
  });

  it('等回复写完的上限落在工具等待上限内，等完后的收尾时间不比关窗收尾期限短：两者不打架', () => {
    expect(QUIT_REPLY_WAIT_FLOOR_MS).toBeGreaterThanOrEqual(30_000);
    expect(QUIT_REPLY_IDLE_MS).toBeLessThan(QUIT_REPLY_WAIT_FLOOR_MS);
    expect(QUIT_REPLY_WAIT_FLOOR_MS).toBeLessThan(QUIT_REPLY_WAIT_CAP_MS);
    expect(QUIT_REPLY_WAIT_CAP_MS).toBeLessThan(QUIT_TOOL_WAIT_LIMIT_MS);
    expect(QUIT_WATCHDOG_LIMIT_MS - QUIT_TOOL_WAIT_LIMIT_MS).toBeGreaterThanOrEqual(
      QUIT_FINISH_LIMIT_MS
    );
  });

  it('安装更新超过总上限：日志写明卡在哪一步，先 relaunch 再 app.exit；还没退出就 SIGKILL', async () => {
    const { host, dog } = setup();
    dog.begin('update', '等 agent 安全点');
    dog.step('等 Squirrel 接手安装');
    await vi.advanceTimersByTimeAsync(limits.totalMs - 1);
    expect(host.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.log.mock.calls[0][0]).toContain('卡在「等 Squirrel 接手安装」');
    expect(host.relaunch).toHaveBeenCalledOnce();
    expect(host.relaunch.mock.invocationCallOrder[0]).toBeLessThan(
      host.exit.mock.invocationCallOrder[0]
    );
    expect(host.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(limits.exitGraceMs);
    expect(host.kill).toHaveBeenCalledOnce();
  });

  it('菜单重启已登记过 relaunch：强退时不再登记第二次；普通退出不重新打开', async () => {
    const restart = setup();
    restart.dog.begin('restart', '等 agent 安全点', { relaunched: true });
    await vi.advanceTimersByTimeAsync(limits.totalMs);
    expect(restart.host.exit).toHaveBeenCalledOnce();
    expect(restart.host.relaunch).not.toHaveBeenCalled();

    const quit = setup();
    quit.dog.begin('quit', '等 agent 安全点');
    await vi.advanceTimersByTimeAsync(limits.totalMs);
    expect(quit.host.exit).toHaveBeenCalledOnce();
    expect(quit.host.relaunch).not.toHaveBeenCalled();
  });

  it('开始关窗收尾后期限收紧到 finishMs，之后的步骤不会再放宽', async () => {
    const { host, dog } = setup();
    dog.begin('restart', '等 agent 安全点', { relaunched: true });
    await vi.advanceTimersByTimeAsync(5_000);
    dog.step('关窗退出', { finishing: true });
    await vi.advanceTimersByTimeAsync(5_000);
    dog.step('will-quit 收尾：llama', { finishing: true });
    await vi.advanceTimersByTimeAsync(limits.finishMs - 5_000 - 1);
    expect(host.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.exit).toHaveBeenCalledOnce();
    expect(host.log.mock.calls[0][0]).toContain('卡在「will-quit 收尾：llama」');
  });

  it('没经过确认的退出（托盘、SIGTERM）到了 will-quit 也按退出计时', async () => {
    const { host, dog } = setup();
    expect(dog.active()).toBe(false);
    dog.step('will-quit 收尾：agent worker', { finishing: true });
    expect(dog.active()).toBe(true);
    await vi.advanceTimersByTimeAsync(limits.finishMs);
    expect(host.exit).toHaveBeenCalledOnce();
    expect(host.relaunch).not.toHaveBeenCalled();
  });

  it('多个入口同时触发：沿用最早的期限，退出升级成重启后强退会重新打开', async () => {
    const { host, dog } = setup();
    dog.begin('quit', '等 agent 安全点');
    await vi.advanceTimersByTimeAsync(30_000);
    dog.begin('update', '等 agent 安全点');
    dog.begin('quit', '等 agent 安全点');
    await vi.advanceTimersByTimeAsync(limits.totalMs - 30_000);
    expect(host.exit).toHaveBeenCalledOnce();
    expect(host.relaunch).toHaveBeenCalledOnce();
    expect(host.log.mock.calls[0][0]).toContain('update:');
    expect(host.began).toHaveBeenCalledOnce();
    // 只强退一次
    dog.step('again', { finishing: true });
    await vi.advanceTimersByTimeAsync(limits.totalMs);
    expect(host.exit).toHaveBeenCalledOnce();
  });

  it('退出没有发生（安装失败已恢复窗口）：撤掉后不再强退', async () => {
    const { host, dog } = setup();
    dog.begin('update', '等 Squirrel 接手安装');
    dog.cancel();
    expect(dog.active()).toBe(false);
    await vi.advanceTimersByTimeAsync(limits.totalMs * 2);
    expect(host.exit).not.toHaveBeenCalled();
  });

  it('app.exit 抛错时直接结束进程', async () => {
    const { host, dog } = setup({ exitThrows: true });
    dog.begin('quit', 'x');
    await vi.advanceTimersByTimeAsync(limits.totalMs);
    expect(host.kill).toHaveBeenCalled();
  });
});
