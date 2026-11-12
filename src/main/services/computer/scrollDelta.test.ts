import { describe, expect, it } from 'vitest';
import { normalizeScrollDelta } from './scrollDelta';

describe('normalizeScrollDelta', () => {
  it('认 dy / deltaY / amount，以及位置参数 dx,dy', () => {
    expect(normalizeScrollDelta({ dy: 40 })).toEqual({ dx: 0, dy: 40 });
    expect(normalizeScrollDelta({ deltaY: -80, deltaX: 10 })).toEqual({ dx: 10, dy: -80 });
    expect(normalizeScrollDelta({ amount: 30 })).toEqual({ dx: 0, dy: 30 });
    expect(normalizeScrollDelta({ dx: 2, dy: 3 })).toEqual({ dx: 2, dy: 3 });
  });

  it('缺省是 0', () => {
    expect(normalizeScrollDelta({})).toEqual({ dx: 0, dy: 0 });
  });

  // 审计发现：只检查是否为有限数，win.scroll(x, y, 0, 1e10) 在 Windows 按 120 拆成上亿步，
  // macOS 则超出 CGEvent 的 int32 滚动量
  it('离谱的滚动量收到单次上限，保留方向', () => {
    expect(normalizeScrollDelta({ dx: -1e10, dy: 1e10 })).toEqual({ dx: -10_000, dy: 10_000 });
  });
});
