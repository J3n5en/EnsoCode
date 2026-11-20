import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStatePublisher } from './statePublisher';

describe('createStatePublisher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('空闲时立即发布，密集请求合并成一次尾随发布', async () => {
    let n = 0;
    const emitted: number[] = [];
    const publish = createStatePublisher({
      build: async () => ({ n: ++n }),
      emit: (state) => emitted.push(state.n),
      intervalMs: 300,
    });
    publish();
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted).toEqual([1]);
    for (let i = 0; i < 20; i++) publish();
    await vi.advanceTimersByTimeAsync(299);
    expect(emitted).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(emitted).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitted).toEqual([1, 2]);
  });

  it('内容与上次发布相同则不再发', async () => {
    const emitted: unknown[] = [];
    const publish = createStatePublisher({
      build: async () => ({ same: true }),
      emit: (state) => emitted.push(state),
      intervalMs: 100,
    });
    publish();
    await vi.advanceTimersByTimeAsync(0);
    publish();
    await vi.advanceTimersByTimeAsync(500);
    publish();
    await vi.advanceTimersByTimeAsync(500);
    expect(emitted).toHaveLength(1);
  });

  it('构建失败不阻塞之后的发布', async () => {
    let fail = true;
    const emitted: unknown[] = [];
    const publish = createStatePublisher({
      build: async () => {
        if (fail) throw new Error('x');
        return { ok: 1 };
      },
      emit: (state) => emitted.push(state),
      intervalMs: 100,
    });
    publish();
    await vi.advanceTimersByTimeAsync(0);
    fail = false;
    publish();
    await vi.advanceTimersByTimeAsync(200);
    expect(emitted).toEqual([{ ok: 1 }]);
  });
});
