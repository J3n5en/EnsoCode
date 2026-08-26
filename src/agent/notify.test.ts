import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParentNotifier } from './notify';

describe('ParentNotifier', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('去抖窗口内的多条通知合并成一条', () => {
    const delivered: string[] = [];
    const notifier = new ParentNotifier((_id, text) => delivered.push(text));
    notifier.notify('s1', 'a');
    notifier.notify('s1', 'b');
    vi.advanceTimersByTime(200);
    expect(delivered).toEqual(['a\n\n---\n\nb']);
  });

  it('持续到达时受硬顶约束不无限延迟', () => {
    const delivered: string[] = [];
    const notifier = new ParentNotifier((_id, text) => delivered.push(text));
    for (let i = 0; i < 10; i++) {
      notifier.notify('s1', `m${i}`);
      vi.advanceTimersByTime(100); // 每次都续期去抖
    }
    expect(delivered.length).toBeGreaterThan(0); // 1s 硬顶已触发
  });

  it('紧急通知先 flush 积压再立即直投,不同会话互不影响', () => {
    const delivered: [string, string][] = [];
    const notifier = new ParentNotifier((id, text) => delivered.push([id, text]));
    notifier.notify('s1', 'ok1');
    notifier.notify('s2', 'other');
    notifier.notify('s1', 'FAILED', { urgent: true });
    expect(delivered).toEqual([
      ['s1', 'ok1'],
      ['s1', 'FAILED'],
    ]);
    vi.advanceTimersByTime(1100);
    expect(delivered).toContainEqual(['s2', 'other']);
  });
});
