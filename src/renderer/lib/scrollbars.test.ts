import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installScrollbarActivity } from './scrollbars';

describe('installScrollbarActivity', () => {
  afterEach(() => vi.useRealTimers());

  it('marks the scrolled element only while scrolling', () => {
    vi.useFakeTimers();
    const { document, Event } = parseHTML(
      '<html><body><div id="a"></div><div id="b"></div></body></html>'
    );
    const dispose = installScrollbarActivity(document as unknown as Document, 600);
    const a = document.getElementById('a') as unknown as HTMLElement;
    const b = document.getElementById('b') as unknown as HTMLElement;
    // linkedom 不走捕获阶段，用冒泡事件让它到达 document 上的监听
    const scroll = () => new Event('scroll', { bubbles: true });

    a.dispatchEvent(scroll());
    expect(a.hasAttribute('data-scrolling')).toBe(true);
    expect(b.hasAttribute('data-scrolling')).toBe(false);

    vi.advanceTimersByTime(400);
    a.dispatchEvent(scroll());
    vi.advanceTimersByTime(400);
    expect(a.hasAttribute('data-scrolling')).toBe(true);

    vi.advanceTimersByTime(300);
    expect(a.hasAttribute('data-scrolling')).toBe(false);

    dispose();
    a.dispatchEvent(scroll());
    expect(a.hasAttribute('data-scrolling')).toBe(false);
  });
});
