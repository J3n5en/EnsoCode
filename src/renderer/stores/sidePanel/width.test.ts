import { describe, expect, it } from 'vitest';
import {
  CHAT_MIN_WIDTH,
  resizeSidePanelWidth,
  resolveSidePanelWidth,
  SIDE_PANEL_HANDLE_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
} from './width';

const chatReserve = CHAT_MIN_WIDTH + SIDE_PANEL_HANDLE_WIDTH;

describe('resolveSidePanelWidth', () => {
  it('工作区尚未量到时保留偏好，不夹成 0', () => {
    expect(resolveSidePanelWidth(480, 0)).toBe(480);
    expect(resolveSidePanelWidth(200, 0)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it('宽工作区把宽度夹在最小宽度和聊天预留下限之间', () => {
    expect(resolveSidePanelWidth(400, 1200)).toBe(400);
    expect(resolveSidePanelWidth(200, 1200)).toBe(SIDE_PANEL_MIN_WIDTH);
    expect(resolveSidePanelWidth(900, 1200)).toBe(1200 - chatReserve);
  });

  it('不再使用 800px 硬顶', () => {
    expect(resolveSidePanelWidth(900, 2000)).toBe(900);
  });

  it('窄窗口优先保留聊天区，允许面板小于通常最小宽度', () => {
    expect(resolveSidePanelWidth(480, 500)).toBe(500 - chatReserve);
  });
});

describe('resizeSidePanelWidth', () => {
  it('从可见宽度起算，消掉缩窗后的反向拖死区', () => {
    // 偏好 800，工作区 1000 → 可见 639；向左加宽 50 仍顶住上限，不能把偏好写成 639
    expect(resizeSidePanelWidth(800, 50, 1000)).toBe(800);
    // 从可见宽度往回拖，立刻改窄
    expect(resizeSidePanelWidth(800, -50, 1000)).toBe(639 - 50);
  });

  it('可见宽度没变时不覆盖会话偏好', () => {
    // 窄到面板只能显示 139，任何拖动都改变不了可见宽度
    expect(resizeSidePanelWidth(800, -10, 500)).toBe(800);
    expect(resizeSidePanelWidth(800, 10, 500)).toBe(800);
  });

  it('正常拖动写入新宽度，并守住最小宽度', () => {
    expect(resizeSidePanelWidth(400, 20, 1200)).toBe(420);
    expect(resizeSidePanelWidth(SIDE_PANEL_MIN_WIDTH, -40, 1200)).toBe(SIDE_PANEL_MIN_WIDTH);
  });

  it('工作区尚未量到时按偏好加减，不夹成 0', () => {
    expect(resizeSidePanelWidth(480, 20, 0)).toBe(500);
  });
});
