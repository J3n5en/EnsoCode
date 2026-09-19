export const SIDE_PANEL_DEFAULT_WIDTH = 360;
export const SIDE_PANEL_MIN_WIDTH = 280;
export const CHAT_MIN_WIDTH = 360;
export const SIDE_PANEL_HANDLE_WIDTH = 1;

/**
 * 只限制显示宽度，不覆盖会话偏好；窄窗口优先保留聊天区，允许面板小于通常的最小宽度。
 *
 * Clamp the displayed width without overwriting the conversation preference. On narrow
 * windows, reserve chat space even when the panel must fall below its usual minimum.
 */
export function resolveSidePanelWidth(width: number, workspaceWidth: number): number {
  const max = Math.max(0, workspaceWidth - CHAT_MIN_WIDTH - SIDE_PANEL_HANDLE_WIDTH);
  return Math.min(max, Math.max(SIDE_PANEL_MIN_WIDTH, width));
}

/**
 * 从可见宽度开始拖动，避免窗口变窄后反向拖动时出现隐藏的超限距离。
 *
 * Resize from the visible width to avoid a hidden overshoot dead zone after window shrinkage.
 */
export function resizeSidePanelWidth(width: number, delta: number, workspaceWidth: number): number {
  return resolveSidePanelWidth(
    resolveSidePanelWidth(width, workspaceWidth) + delta,
    workspaceWidth
  );
}
