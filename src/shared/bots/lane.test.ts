import { describe, expect, it } from 'vitest';
import { type BotDeliverySource, enqueueByLane } from './lane';

describe('enqueueByLane', () => {
  it('人 > bot > 后台，同级先来先出，缺省按 bot', () => {
    let queue: Array<{ id: string; source?: 'human' | 'bot' | 'background' }> = [];
    for (const item of [
      { id: 'r1', source: 'background' as const },
      { id: 'b1', source: 'bot' as const },
      { id: 'r2', source: 'background' as const },
      { id: 'h1', source: 'human' as const },
      { id: 'x' },
      { id: 'h2', source: 'human' as const },
    ])
      queue = enqueueByLane(queue, item);
    expect(queue.map((item) => item.id)).toEqual(['h1', 'h2', 'b1', 'x', 'r1', 'r2']);
  });

  it('不改原数组', () => {
    const queue: Array<{ id: string; source: BotDeliverySource }> = [{ id: 'a', source: 'bot' }];
    expect(enqueueByLane(queue, { id: 'h', source: 'human' })).toHaveLength(2);
    expect(queue).toHaveLength(1);
  });
});
