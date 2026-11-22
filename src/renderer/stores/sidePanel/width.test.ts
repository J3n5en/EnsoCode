import { describe, expect, it } from 'vitest';
import {
  CHAT_MIN_WIDTH,
  clampFilesTreeWidth,
  FILES_EDITOR_MIN_WIDTH,
  FILES_TREE_DEFAULT_WIDTH,
  FILES_TREE_MAX_WIDTH,
  FILES_TREE_MIN_WIDTH,
  resizeFilesTreeWidth,
  resizeSidePanelWidth,
  resolveFilesTreeWidth,
  resolveSidePanelWidth,
  SIDE_PANEL_GAP_WIDTH,
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

  it('卡片外壳下 8px 缝整宽计入聊天预留', () => {
    expect(resolveSidePanelWidth(900, 1200, SIDE_PANEL_GAP_WIDTH)).toBe(1200 - CHAT_MIN_WIDTH - 8);
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

  it('卡片外壳下拖到上限时聊天区仍留足最小宽度', () => {
    const max = 1000 - CHAT_MIN_WIDTH - SIDE_PANEL_GAP_WIDTH;
    expect(resizeSidePanelWidth(400, 1000, 1000, SIDE_PANEL_GAP_WIDTH)).toBe(max);
  });
});

describe('clampFilesTreeWidth', () => {
  it('默认 224，范围 160–480', () => {
    expect(FILES_TREE_DEFAULT_WIDTH).toBe(224);
    expect(FILES_TREE_MIN_WIDTH).toBe(160);
    expect(FILES_TREE_MAX_WIDTH).toBe(480);
  });

  it('越界夹到边界，范围内原样保留', () => {
    expect(clampFilesTreeWidth(100)).toBe(160);
    expect(clampFilesTreeWidth(900)).toBe(480);
    expect(clampFilesTreeWidth(300)).toBe(300);
  });

  it('持久化脏值回落默认宽度', () => {
    expect(clampFilesTreeWidth(Number.NaN)).toBe(224);
    expect(clampFilesTreeWidth('300')).toBe(224);
    expect(clampFilesTreeWidth(undefined)).toBe(224);
  });
});

describe('resolveFilesTreeWidth', () => {
  const editorReserve = FILES_EDITOR_MIN_WIDTH + SIDE_PANEL_HANDLE_WIDTH;

  it('面板尚未量到时只按 160–480 夹', () => {
    expect(resolveFilesTreeWidth(480, 0)).toBe(480);
    expect(resolveFilesTreeWidth(Number.NaN, 0)).toBe(FILES_TREE_DEFAULT_WIDTH);
  });

  it('面板变窄时给编辑区留出最小宽度', () => {
    expect(resolveFilesTreeWidth(480, 1200)).toBe(480);
    expect(resolveFilesTreeWidth(480, 600)).toBe(600 - editorReserve);
  });

  it('面板很窄时不低于原先固定的默认宽度，也不放大偏好更窄的值', () => {
    expect(resolveFilesTreeWidth(480, 360)).toBe(FILES_TREE_DEFAULT_WIDTH);
    expect(resolveFilesTreeWidth(180, 360)).toBe(180);
  });
});

describe('resizeFilesTreeWidth', () => {
  it('从可见宽度起算，顶到上限时不改偏好', () => {
    // 偏好 480，面板 600 → 可见 359；继续向右拖不变，偏好保留
    expect(resizeFilesTreeWidth(480, 50, 600)).toBe(480);
    // 往回拖立刻变窄，没有死区
    expect(resizeFilesTreeWidth(480, -50, 600)).toBe(600 - FILES_EDITOR_MIN_WIDTH - 1 - 50);
  });

  it('面板尚未量到时按偏好加减并夹在 160–480', () => {
    expect(resizeFilesTreeWidth(224, 40, 0)).toBe(264);
    expect(resizeFilesTreeWidth(224, 1000, 0)).toBe(480);
    expect(resizeFilesTreeWidth(224, -1000, 0)).toBe(160);
  });
});
