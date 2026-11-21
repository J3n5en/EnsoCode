import { describe, expect, it } from 'vitest';
import { subscribeSidebarToggle, toggleSidebar } from './sidebarToggle';

describe('sidebarToggle', () => {
  it('把一次切换分发给当前订阅者，退订后不再收到', () => {
    let count = 0;
    const off = subscribeSidebarToggle(() => {
      count += 1;
    });
    toggleSidebar();
    expect(count).toBe(1);
    off();
    toggleSidebar();
    expect(count).toBe(1);
  });

  it('没有订阅者时是空操作', () => {
    expect(() => toggleSidebar()).not.toThrow();
  });
});
