import { describe, expect, it } from 'vitest';
import { newTabAutoPopOpen } from './newTabPromptGate';

describe('auto-pop 放行时机', () => {
  it('有信号且动画已停：弹出', () => {
    expect(newTabAutoPopOpen({ promptAt: 1, layoutAnimating: false, anchorLive: true })).toBe(true);
  });

  it('有信号但展开动画进行中：按住不弹（floating-ui 首帧测量会撞上动画中途几何）', () => {
    expect(newTabAutoPopOpen({ promptAt: 1, layoutAnimating: true, anchorLive: true })).toBe(false);
  });

  it('锚点已脱离文档（dockview 摘掉空 group 后残留的水印实例）：不弹，否则漂到左上角成孤儿', () => {
    expect(newTabAutoPopOpen({ promptAt: 1, layoutAnimating: false, anchorLive: false })).toBe(
      false
    );
  });

  it('无信号：永远不弹', () => {
    expect(newTabAutoPopOpen({ promptAt: null, layoutAnimating: false, anchorLive: true })).toBe(
      false
    );
    expect(
      newTabAutoPopOpen({ promptAt: undefined, layoutAnimating: false, anchorLive: true })
    ).toBe(false);
    expect(newTabAutoPopOpen({ promptAt: null, layoutAnimating: true, anchorLive: true })).toBe(
      false
    );
  });
});
