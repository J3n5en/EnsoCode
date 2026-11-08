import { describe, expect, it } from 'vitest';
import { navRailEnabled, navRailSideOf } from './navRailVisibility';

describe('navRailEnabled', () => {
  it('阅读宽度且至少两轮时显示', () => {
    expect(navRailEnabled('left', false, 2)).toBe(true);
    expect(navRailEnabled('right', false, 2)).toBe(true);
  });

  it('铺满宽度时不显示，避免感应带盖住左缘正文', () => {
    expect(navRailEnabled('left', true, 8)).toBe(false);
    expect(navRailEnabled('right', true, 8)).toBe(false);
  });

  it('不足两轮时没有可跳目标', () => {
    expect(navRailEnabled('left', false, 1)).toBe(false);
    expect(navRailEnabled('left', false, 0)).toBe(false);
  });

  it('关闭后即使有多轮也不显示', () => {
    expect(navRailEnabled('off', false, 8)).toBe(false);
  });
});

describe('navRailSideOf', () => {
  it('缺省和脏值都回到左边', () => {
    expect(navRailSideOf(undefined)).toBe('left');
    expect(navRailSideOf('nope')).toBe('left');
    expect(navRailSideOf('right')).toBe('right');
    expect(navRailSideOf('off')).toBe('off');
  });
});
