import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescer } from './coalesce';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createCoalescer', () => {
  it('merges bursts per key into one run and resolves every caller', async () => {
    const coalesce = createCoalescer(50);
    const task = vi.fn(async () => {});
    const other = vi.fn(async () => {});
    const calls = [coalesce('a', task), coalesce('a', task), coalesce('b', other)];
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all(calls);
    expect(task).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('runs once more after an in-flight run when asked again meanwhile, with the latest task', async () => {
    const coalesce = createCoalescer(50);
    const gate = Promise.withResolvers<void>();
    const first = vi.fn(() => gate.promise);
    const latest = vi.fn(async () => {});
    const done = coalesce('a', first);
    await vi.advanceTimersByTimeAsync(50);
    expect(first).toHaveBeenCalledTimes(1);
    const again = coalesce('a', first);
    coalesce('a', latest);
    gate.resolve();
    await done;
    await vi.advanceTimersByTimeAsync(50);
    await again;
    expect(first).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('keeps working after a task throws', async () => {
    const coalesce = createCoalescer(10);
    const failing = coalesce('a', async () => {
      throw new Error('x');
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(failing).resolves.toBeUndefined();
    const ok = vi.fn(async () => {});
    const next = coalesce('a', ok);
    await vi.advanceTimersByTimeAsync(10);
    await next;
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
