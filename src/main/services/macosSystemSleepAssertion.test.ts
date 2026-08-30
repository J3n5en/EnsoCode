import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacosSystemSleepAssertion } from './macosSystemSleepAssertion';

class FakeCaffeinateProcess extends EventEmitter {
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

const silentLogger = { warn: () => {} };

describe('MacosSystemSleepAssertion', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('在 macOS 上用 idle + system sleep 启动 caffeinate', () => {
    const child = new FakeCaffeinateProcess();
    const spawn = vi.fn(() => child);
    const assertion = new MacosSystemSleepAssertion({
      platform: 'darwin',
      spawn,
    });

    assertion.start('phone-online');

    expect(spawn).toHaveBeenCalledWith('/usr/bin/caffeinate', ['-i', '-s'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  });

  it('非 macOS 不拉起进程', () => {
    const spawn = vi.fn(() => new FakeCaffeinateProcess());
    const assertion = new MacosSystemSleepAssertion({
      platform: 'linux',
      spawn,
    });

    assertion.start('phone-online');

    expect(spawn).not.toHaveBeenCalled();
  });

  it('已有活进程时不重复 spawn', () => {
    const spawn = vi.fn(() => new FakeCaffeinateProcess());
    const assertion = new MacosSystemSleepAssertion({
      platform: 'darwin',
      spawn,
    });

    assertion.start('phone-online');
    assertion.start('phone-online');

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('stop 杀掉 caffeinate', () => {
    const child = new FakeCaffeinateProcess();
    const assertion = new MacosSystemSleepAssertion({
      platform: 'darwin',
      spawn: () => child,
    });

    assertion.start('phone-online');
    assertion.stop('phone-offline');

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('意外退出后在仍需要保活时重试', () => {
    vi.useFakeTimers();
    const first = new FakeCaffeinateProcess();
    const second = new FakeCaffeinateProcess();
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const assertion = new MacosSystemSleepAssertion({
      logger: silentLogger,
      platform: 'darwin',
      spawn,
    });

    assertion.start('phone-online');
    first.emit('exit', 1, null);
    expect(spawn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(spawn).toHaveBeenCalledTimes(2);

    assertion.stop('phone-offline');
    expect(second.kill).toHaveBeenCalledTimes(1);
  });

  it('spawn 失败不抛给调用方', () => {
    const assertion = new MacosSystemSleepAssertion({
      logger: silentLogger,
      platform: 'darwin',
      spawn: () => {
        throw new Error('missing caffeinate');
      },
    });

    expect(() => assertion.start('phone-online')).not.toThrow();
    assertion.stop('phone-offline');
  });
});
