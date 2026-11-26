import { describe, expect, it } from 'vitest';
import { newTabAutoPopOpen } from './newTabPromptGate';

describe('auto-pop 放行时机', () => {
  it('有信号且动画已停：弹出', () => {
    expect(newTabAutoPopOpen({ promptAt: 1, layoutAnimating: false })).toBe(true);
  });

  it('有信号但展开动画进行中：按住不弹（floating-ui 首帧测量会撞上动画中途几何）', () => {
    expect(newTabAutoPopOpen({ promptAt: 1, layoutAnimating: true })).toBe(false);
  });

  it('无信号：永远不弹', () => {
    expect(newTabAutoPopOpen({ promptAt: null, layoutAnimating: false })).toBe(false);
    expect(newTabAutoPopOpen({ promptAt: undefined, layoutAnimating: false })).toBe(false);
    expect(newTabAutoPopOpen({ promptAt: null, layoutAnimating: true })).toBe(false);
  });
});
