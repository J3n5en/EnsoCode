export const SIDE_PANEL_DEFAULT_WIDTH = 360;
export const SIDE_PANEL_MIN_WIDTH = 280;
export const CHAT_MIN_WIDTH = 360;
export const SIDE_PANEL_HANDLE_WIDTH = 1;
/** 卡片外壳下手柄就是卡片间的画布缝，整宽占位 */
export const SIDE_PANEL_GAP_WIDTH = 8;

export const FILES_TREE_DEFAULT_WIDTH = 224;
export const FILES_TREE_MIN_WIDTH = 160;
export const FILES_TREE_MAX_WIDTH = 480;
/** 拖宽文件树时编辑区至少保留的宽度 */
export const FILES_EDITOR_MIN_WIDTH = 240;

/** 持久化读回的值可能是脏数据，非有限数字回落默认宽度 */
export function clampFilesTreeWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return FILES_TREE_DEFAULT_WIDTH;
  return Math.min(FILES_TREE_MAX_WIDTH, Math.max(FILES_TREE_MIN_WIDTH, width));
}

/**
 * 文件树可见宽度：给编辑区留 FILES_EDITOR_MIN_WIDTH，但上限不低于原先固定的默认宽度；
 * 只限制显示，不覆盖偏好。paneWidth 未量到（0）时只按 160–480 夹。
 */
export function resolveFilesTreeWidth(width: unknown, paneWidth: number): number {
  const preferred = clampFilesTreeWidth(width);
  if (paneWidth <= 0) return preferred;
  const max = Math.max(
    FILES_TREE_DEFAULT_WIDTH,
    paneWidth - FILES_EDITOR_MIN_WIDTH - SIDE_PANEL_HANDLE_WIDTH
  );
  return Math.min(preferred, max);
}

/** 从可见宽度开始拖，面板变窄后反向拖动没有死区；可见宽度没变时保留偏好 */
export function resizeFilesTreeWidth(width: unknown, delta: number, paneWidth: number): number {
  const visible = resolveFilesTreeWidth(width, paneWidth);
  const next = resolveFilesTreeWidth(visible + delta, paneWidth);
  return next === visible ? clampFilesTreeWidth(width) : next;
}

/**
 * 只限制显示宽度，不覆盖会话偏好；窄窗口优先保留聊天区，允许面板小于通常的最小宽度。
 */
export function resolveSidePanelWidth(
  width: number,
  workspaceWidth: number,
  handleWidth = SIDE_PANEL_HANDLE_WIDTH
): number {
  const preferred = Math.max(SIDE_PANEL_MIN_WIDTH, width);
  if (workspaceWidth <= 0) return preferred;
  const max = Math.max(0, workspaceWidth - CHAT_MIN_WIDTH - handleWidth);
  return Math.min(max, preferred);
}

/**
 * 从可见宽度开始拖动，避免窗口变窄后反向拖动时出现隐藏的超限距离。
 */
export function resizeSidePanelWidth(
  width: number,
  delta: number,
  workspaceWidth: number,
  handleWidth = SIDE_PANEL_HANDLE_WIDTH
): number {
  const visible = resolveSidePanelWidth(width, workspaceWidth, handleWidth);
  const next = resolveSidePanelWidth(visible + delta, workspaceWidth, handleWidth);
  return next === visible ? width : next;
}
