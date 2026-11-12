import { FrameError } from './errors';

export interface CaptureFrame {
  target: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  originX: number;
  originY: number;
}

/**
 * 截图坐标允许越出截图边缘的幅度（按截图宽高的倍数）：拖拽终点、拖窗口边缘可能落在目标窗口外；
 * 再远就是坐标系弄错或离谱的数，原样映射会让后台拖拽插值点数与耗时随之暴涨。
 */
const SCREENSHOT_OVERSHOOT = 1;

function farOutside(value: number, size: number): boolean {
  return value < -size * SCREENSHOT_OVERSHOOT || value > size * (1 + SCREENSHOT_OVERSHOOT);
}

/** 像素坐标属于「同一 target 的最近一张截图」。缩放过则按比例映回源尺寸。 */
export function mapScreenshotPoint(
  frames: Map<string, CaptureFrame>,
  target: string,
  x: number,
  y: number
): { screenX: number; screenY: number } {
  const frame = frames.get(target);
  if (!frame) {
    throw new FrameError(`screenshot the target '${target}' before using pixel coordinates`);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new FrameError('coordinates must be finite numbers in the latest screenshot');
  }
  if (frame.width > 0 && frame.height > 0) {
    if (farOutside(x, frame.width) || farOutside(y, frame.height)) {
      throw new FrameError(
        `coordinates (${x}, ${y}) are far outside the latest ${frame.width}×${frame.height} screenshot of '${target}'; use pixels from that screenshot`
      );
    }
  }
  const scaleX = frame.width > 0 ? frame.sourceWidth / frame.width : 1;
  const scaleY = frame.height > 0 ? frame.sourceHeight / frame.height : 1;
  return {
    screenX: frame.originX + x * scaleX,
    screenY: frame.originY + y * scaleY,
  };
}

export function scaleCaptureSize(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  if (sourceWidth <= maxWidth && sourceHeight <= maxHeight) {
    return { width: sourceWidth, height: sourceHeight };
  }
  const ratio = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: Math.max(1, Math.round(sourceWidth * ratio)),
    height: Math.max(1, Math.round(sourceHeight * ratio)),
  };
}

export function screenshotCaption(shot: {
  target: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  hash?: string;
}): string {
  const scale = shot.width > 0 ? shot.sourceWidth / shot.width : 1;
  const hash = shot.hash ? ` hash ${shot.hash}` : '';
  return `${shot.target} ${shot.width}×${shot.height} (source ${shot.sourceWidth}×${shot.sourceHeight}, scale ${scale.toFixed(2)}${hash}). click(x,y) uses these screenshot pixels.`;
}

export function pixelFingerprint(data: string): string {
  let hash = 2166136261;
  for (let i = 0; i < data.length; i++) {
    hash ^= data.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function captureSourceRect(input: {
  target: string;
  thumbnailWidth: number;
  thumbnailHeight: number;
  window?: { x: number; y: number; width: number; height: number };
  display?: { x: number; y: number; width: number; height: number };
}): { originX: number; originY: number; sourceWidth: number; sourceHeight: number } {
  if (input.target === 'desktop' && input.display && input.display.width > 0) {
    return {
      originX: input.display.x,
      originY: input.display.y,
      sourceWidth: input.display.width,
      sourceHeight: input.display.height,
    };
  }
  if (input.window && input.window.width > 0 && input.window.height > 0) {
    return {
      originX: input.window.x,
      originY: input.window.y,
      sourceWidth: input.window.width,
      sourceHeight: input.window.height,
    };
  }
  return {
    originX: 0,
    originY: 0,
    sourceWidth: input.thumbnailWidth,
    sourceHeight: input.thumbnailHeight,
  };
}
