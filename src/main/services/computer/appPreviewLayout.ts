/** 预览底部标题栏高度（app 名 + 关闭按钮） */
export const PREVIEW_BAR = 28;
export const PREVIEW_MIN_WIDTH = 120;
const MAX_WIDTH = 320;
const MAX_HEIGHT = 240;
const MARGIN = 16;

type Size = { width: number; height: number };
type Rect = Size & { x: number; y: number };

/** 按目标窗口比例缩进上限；画面区域之下留标题栏 */
export function previewSize(source: Size | undefined): Size {
  const valid = source && source.width > 0 && source.height > 0;
  const { width, height } = valid ? source : { width: 16, height: 10 };
  const scale = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height);
  const w = Math.max(PREVIEW_MIN_WIDTH, Math.round(width * scale));
  return { width: w, height: Math.round(height * scale) + PREVIEW_BAR };
}

/** 以右下角为锚点放置（默认贴工作区右下角），并收回到工作区内 */
export function placePreview(
  area: Rect,
  size: Size,
  anchor?: { right: number; bottom: number }
): Rect {
  const right = anchor?.right ?? area.x + area.width - MARGIN;
  const bottom = anchor?.bottom ?? area.y + area.height - MARGIN;
  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), Math.max(min, max));
  return {
    x: clamp(right - size.width, area.x, area.x + area.width - size.width),
    y: clamp(bottom - size.height, area.y, area.y + area.height - size.height),
    ...size,
  };
}
