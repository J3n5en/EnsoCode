import { describe, expect, it } from 'vitest';
import { headerActionsPinned, newTabAutoPopOpen } from './newTabPromptGate';

describe('顶栏按钮收纳成「…」时的强制展开', () => {
  it('空闲：收起，只露「…」', () => {
    expect(headerActionsPinned({ menuOpen: false, promptAt: null })).toBe(false);
  });

  it('新建菜单开着：保持展开，否则 + 被藏起、弹层锚点 rect 归零漂走', () => {
    expect(headerActionsPinned({ menuOpen: true, promptAt: null })).toBe(true);
  });

  it('auto-pop 信号待弹（含动画中按住未弹）：提前展开，让 + 先就位再测量', () => {
    expect(headerActionsPinned({ menuOpen: false, promptAt: 1 })).toBe(true);
    expect(headerActionsPinned({ menuOpen: false, promptAt: undefined })).toBe(false);
  });
});

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
