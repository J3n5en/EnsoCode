import { describe, expect, it } from 'vitest';
import { fitWindowBounds } from './windowBounds';

const primary = { x: 0, y: 25, width: 1512, height: 920 };
const isVisible = (b: { x?: number; y?: number; width: number; height: number }) =>
  b.x !== undefined &&
  b.y !== undefined &&
  b.x >= primary.x &&
  b.y >= primary.y &&
  b.x + b.width <= primary.x + primary.width &&
  b.y + b.height <= primary.y + primary.height;

describe('fitWindowBounds', () => {
  it('拔掉副屏后坐标完全在屏幕外：回落到主屏可见区域', () => {
    const state = { x: -1496, y: 138, width: 1454, height: 767, isMaximized: false };
    const fitted = fitWindowBounds(state, [primary], primary);
    expect(fitted).toEqual({ x: 60, y: 85, width: 1452, height: 767, isMaximized: false });
    expect(isVisible(fitted)).toBe(true);
  });

  it('坐标正常时原样返回', () => {
    const state = { x: 100, y: 120, width: 1200, height: 700, isMaximized: true };
    expect(fitWindowBounds(state, [primary], primary)).toEqual(state);
  });

  it('副屏仍在时保留副屏上的位置', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1050 };
    const state = { x: -1496, y: 138, width: 1454, height: 767 };
    expect(fitWindowBounds(state, [primary, left], primary)).toEqual(state);
  });

  it('宽高超过屏幕时收窄并移回屏内', () => {
    const fitted = fitWindowBounds(
      { x: 200, y: 100, width: 2560, height: 1400 },
      [primary],
      primary
    );
    expect(fitted).toEqual({ x: 0, y: 25, width: 1512, height: 920 });
  });

  it('y 略为负数（标题栏被顶出）时修正到 workArea 顶部', () => {
    const fitted = fitWindowBounds(
      { x: 100, y: -20, width: 1200, height: 700 },
      [primary],
      primary
    );
    expect(fitted).toEqual({ x: 100, y: 25, width: 1200, height: 700 });
  });

  it('y 远低于 workArea 时回落主屏', () => {
    const fitted = fitWindowBounds(
      { x: 100, y: -900, width: 1200, height: 700 },
      [primary],
      primary
    );
    expect(fitted).toEqual({ x: 60, y: 85, width: 1200, height: 700 });
  });

  it('只露出窄边、抓不住标题栏时视为不可见', () => {
    const fitted = fitWindowBounds(
      { x: 1480, y: 100, width: 1000, height: 600 },
      [primary],
      primary
    );
    expect(fitted).toMatchObject({ x: 60, y: 85 });
  });

  it('没有保存坐标时只收窄尺寸，位置交给系统居中', () => {
    expect(fitWindowBounds({ width: 3000, height: 600 }, [primary], primary)).toEqual({
      width: 1512,
      height: 600,
    });
  });
});
