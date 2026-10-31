import { describe, expect, it } from 'vitest';
import { pointerPlacement } from './pointerPlacement';

const win = (id: string, x: number, y: number, width = 100, height = 100) => ({
  id,
  app: id,
  title: '',
  pid: Number(id),
  x,
  y,
  width,
  height,
});

describe('pointerPlacement', () => {
  it('落点处最上层就是目标窗口：露出，并给出窗口内比例', () => {
    expect(pointerPlacement([win('2', 0, 0)], '2', { x: 25, y: 50 })).toEqual({
      exposed: true,
      fx: 0.25,
      fy: 0.5,
    });
  });

  it('目标被别的窗口盖住（如用户正在用的 app）：不算露出', () => {
    const list = [win('1', 0, 0, 60, 60), win('2', 0, 0)];
    expect(pointerPlacement(list, '2', { x: 10, y: 10 })).toMatchObject({ exposed: false });
    expect(pointerPlacement(list, '2', { x: 80, y: 80 })).toMatchObject({ exposed: true });
  });

  it('找不到目标窗口时返回 undefined', () => {
    expect(pointerPlacement([win('1', 0, 0)], '2', { x: 1, y: 1 })).toBeUndefined();
    expect(pointerPlacement([win('2', 0, 0, 0, 0)], '2', { x: 0, y: 0 })).toBeUndefined();
  });
});
