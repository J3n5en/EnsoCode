import { describe, expect, it } from 'vitest';
import { indicatorOffset } from './groupChipIndicator';

describe('indicatorOffset', () => {
  it('相对滚动视口定位，而不是相对页面', () => {
    expect(indicatorOffset({ left: 48, width: 52 }, 14)).toEqual({ x: 34, width: 52 });
  });

  it('标签滚到视口左侧时 x 为负，交给轨道裁切', () => {
    expect(indicatorOffset({ left: -20, width: 40 }, 14)).toEqual({ x: -34, width: 40 });
  });

  it('宽度不会是负数', () => {
    expect(indicatorOffset({ left: 10, width: -1 }, 0)).toEqual({ x: 10, width: 0 });
  });
});
