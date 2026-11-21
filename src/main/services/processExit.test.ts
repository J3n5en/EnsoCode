import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { killAndWaitExit } from './processExit';

function child() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { kill: vi.fn(() => true) });
}

describe('killAndWaitExit', () => {
  it('发出终止信号并等到进程退出', async () => {
    const proc = child();
    let done = false;
    const pending = killAndWaitExit(proc, 5_000).then(() => {
      done = true;
    });
    expect(proc.kill).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(done).toBe(false);
    proc.emit('exit', 0);
    await pending;
    expect(done).toBe(true);
  });

  it('进程迟迟不退出时到时限放行，不卡住应用退出', async () => {
    vi.useFakeTimers();
    const proc = child();
    const pending = killAndWaitExit(proc, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('到时限还不退出就 SIGKILL；按时退出的不补刀', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const stuck = Object.assign(child(), { pid: 424242 });
    const pending = killAndWaitExit(stuck, 1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(kill).toHaveBeenCalledWith(424242, 'SIGKILL');

    kill.mockClear();
    const polite = Object.assign(child(), { pid: 515151 });
    const done = killAndWaitExit(polite, 1_000);
    polite.emit('exit', 0);
    await done;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
    vi.useRealTimers();
  });
});
