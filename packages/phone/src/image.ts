import type { AttachedImage } from '@enso/pair';

/** 单帧上限 1MB（与中继一致），留出 JSON/base64 膨胀余量 */
const MAX_BYTES = 700_000;
const MAX_EDGE = 1600;

/** 手机拍照动辄数 MB，先按长边缩放 + JPEG 压缩再编码，超限则提示换图 */
export async function compressImage(
  file: File,
  maxBytes = MAX_BYTES,
  maxEdge = MAX_EDGE
): Promise<AttachedImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画布不可用');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if (base64.length * 0.75 <= maxBytes) {
      return { data: base64, mimeType: 'image/jpeg' };
    }
  }
  throw new Error('图片太大，请换一张更小的图');
}

/** 一次发多张时整帧仍须在中继上限内：每张的预算 */
export const imageBudget = (count: number): number => Math.floor(MAX_BYTES / Math.max(1, count));

/** 压到预算内，压不下再缩小长边 */
export async function compressWithin(file: File, budget: number): Promise<AttachedImage> {
  try {
    return await compressImage(file, budget);
  } catch {
    return compressImage(file, budget, 1024);
  }
}

export async function compressImages(files: readonly File[]): Promise<AttachedImage[]> {
  const budget = imageBudget(files.length);
  const out: AttachedImage[] = [];
  for (const file of files) out.push(await compressWithin(file, budget));
  return out;
}
