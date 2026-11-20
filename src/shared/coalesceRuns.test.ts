import { describe, expect, it } from 'vitest';
import { coalesceRuns, mapLimited } from './coalesceRuns';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('coalesceRuns', () => {
  it('在途时的多次调用合并成一次尾随执行，且都等到尾随结束', async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    let runs = 0;
    const run = coalesceRuns(async () => {
      runs += 1;
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
    });
    const first = run();
    const second = run();
    const third = run();
    expect(runs).toBe(1);
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });
    gates[0].resolve();
    await first;
    await Promise.resolve();
    expect(runs).toBe(2);
    expect(secondDone).toBe(false);
    gates[1].resolve();
    await Promise.all([second, third]);
    expect(runs).toBe(2);
  });

  it('失败不影响下一次调用', async () => {
    let fail = true;
    const run = coalesceRuns(async () => {
      if (fail) throw new Error('x');
    });
    await expect(run()).rejects.toThrow('x');
    fail = false;
    await expect(run()).resolves.toBeUndefined();
  });
});

describe('mapLimited', () => {
  it('按顺序返回结果，同时在跑的不超过上限', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
      return n * 2;
    });
    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});
