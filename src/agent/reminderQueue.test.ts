import { describe, expect, it } from 'vitest';
import { enqueueReminder } from './reminderQueue';

describe('enqueueReminder', () => {
  it('未满时追加，不驱逐', () => {
    const queue = ['a'];
    expect(enqueueReminder(queue, 'b', 3)).toBe(false);
    expect(queue).toEqual(['a', 'b']);
  });

  it('满了丢最旧，队首留一条溢出告知，新通知总能入队', () => {
    const queue = ['a', 'b', 'c'];
    expect(enqueueReminder(queue, 'd', 3)).toBe(true);
    expect(queue).toHaveLength(3);
    expect(queue.slice(1)).toEqual(['c', 'd']);
    expect(queue[0]).toMatch(/^\[Queue overflow\] 2 earlier background notifications were dropped/);
  });

  it('连续溢出累加丢弃数，告知本身不被当作通知驱逐', () => {
    const queue = ['a', 'b', 'c'];
    enqueueReminder(queue, 'd', 3);
    expect(enqueueReminder(queue, 'e', 3)).toBe(true);
    expect(queue.slice(1)).toEqual(['d', 'e']);
    expect(queue[0]).toMatch(/^\[Queue overflow\] 3 earlier /);
  });
});
