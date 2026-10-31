import type { ComputerWindowInfo } from '@shared/computer/types';

/**
 * 后台点击落点在目标窗口里的位置，以及屏幕上这一点是否真能看到目标窗口。
 * 窗口列表按层级从前到后；被别的窗口（比如用户正在用的 app）盖住时不算露出。
 */
export function pointerPlacement(
  windows: ComputerWindowInfo[],
  targetId: string,
  point: { x: number; y: number }
): { exposed: boolean; fx: number; fy: number } | undefined {
  const target = windows.find((item) => item.id === targetId);
  if (!target || target.width <= 0 || target.height <= 0) return undefined;
  const top = windows.find(
    (item) =>
      point.x >= item.x &&
      point.y >= item.y &&
      point.x < item.x + item.width &&
      point.y < item.y + item.height
  );
  return {
    exposed: top?.id === targetId,
    fx: (point.x - target.x) / target.width,
    fy: (point.y - target.y) / target.height,
  };
}
