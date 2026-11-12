export function isListedCgWindowLayer(layer: number): boolean {
  return layer >= 0 && layer <= 8;
}

export function findCapturerWindowSource<T extends { id: string }>(
  sources: T[],
  target: string
): T | undefined {
  return sources.find(
    (item) =>
      item.id === target || item.id.endsWith(`:${target}:0`) || item.id.includes(`:${target}:`)
  );
}

/**
 * 截图 target 对应的窗口几何。target 总是同一后端 windows() 给出的 id
 * （有原生桥时是 CG 窗口号，否则是 capturer source id），只能精确比较：
 * 子串匹配会让排在前面的 "141" 冒充 "31415"，截图原点错了，后续点击就落到别处。
 */
export function findCaptureWindow<T extends { id: string }>(
  windows: T[],
  target: string
): T | undefined {
  return windows.find((window) => window.id === target);
}

export function thumbnailCropForWindow(input: {
  window: { x: number; y: number; width: number; height: number };
  display: { x: number; y: number; width: number; height: number };
  thumbnailWidth: number;
  thumbnailHeight: number;
}): { x: number; y: number; width: number; height: number } | undefined {
  if (
    input.display.width <= 0 ||
    input.display.height <= 0 ||
    input.window.width <= 0 ||
    input.window.height <= 0
  ) {
    return undefined;
  }
  const scaleX = input.thumbnailWidth / input.display.width;
  const scaleY = input.thumbnailHeight / input.display.height;
  const x = Math.max(0, Math.round((input.window.x - input.display.x) * scaleX));
  const y = Math.max(0, Math.round((input.window.y - input.display.y) * scaleY));
  if (x >= input.thumbnailWidth || y >= input.thumbnailHeight) return undefined;
  return {
    x,
    y,
    width: Math.max(1, Math.min(input.thumbnailWidth - x, Math.round(input.window.width * scaleX))),
    height: Math.max(
      1,
      Math.min(input.thumbnailHeight - y, Math.round(input.window.height * scaleY))
    ),
  };
}
