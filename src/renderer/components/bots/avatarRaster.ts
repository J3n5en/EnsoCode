/** 头像栅格化：纯浏览器 canvas 工具，不依赖任何 store，设置页与 Bot 面板共用 */

export const AVATAR_EDGE = 512;

export const dataUrlBytes = (url: string): Uint8Array =>
  Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (char) => char.charCodeAt(0));

export function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function canvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const el = document.createElement('canvas');
  el.width = AVATAR_EDGE;
  el.height = AVATAR_EDGE;
  const ctx = el.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  return [el, ctx];
}

/** 源图正方形区域 → 512×512 PNG data URL */
export function renderSquare(
  image: CanvasImageSource,
  sx: number,
  sy: number,
  side: number
): string {
  const [el, ctx] = canvas();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, sx, sy, side, side, 0, 0, AVATAR_EDGE, AVATAR_EDGE);
  return el.toDataURL('image/png');
}

/** 整图居中裁成正方形（人物卡导入、导出时重绘） */
export async function coverSquare(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const side = Math.min(bitmap.width, bitmap.height);
  try {
    return renderSquare(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side);
  } finally {
    bitmap.close();
  }
}
