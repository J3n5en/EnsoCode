import { nativeImage } from 'electron';
import { MEDIA_FILE_MAX } from './media';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export const mediaMime = (mediaId: string): string =>
  MIME[mediaId.slice(mediaId.lastIndexOf('.') + 1)] ?? 'image/png';

function decode(data: Buffer) {
  const image = nativeImage.createFromBuffer(data);
  return image.isEmpty() ? null : image;
}

/** 依次缩小长边 / 降质量，直到 accept 通过；解码失败（GIF/WebP 等）返回 null */
function shrink(
  data: Buffer,
  steps: readonly [number, number][],
  accept: (jpeg: Buffer) => boolean
): Buffer | null {
  const image = decode(data);
  if (!image) return null;
  const { width, height } = image.getSize();
  for (const [edge, quality] of steps) {
    const scale = Math.min(1, edge / Math.max(width, height, 1));
    const resized =
      scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
            quality: 'good',
          })
        : image;
    const jpeg = resized.toJPEG(quality);
    if (jpeg.length > 0 && accept(jpeg)) return jpeg;
  }
  return null;
}

/** 单张超过 10MiB：转 JPEG 并逐级缩小 */
export const compressImage = (data: Buffer): Buffer | null =>
  shrink(
    data,
    [
      [8192, 85],
      [4096, 80],
      [2560, 75],
    ],
    (jpeg) => jpeg.length <= MEDIA_FILE_MAX
  );

/** 缩略图 / 手机大图：data URL 长度不超过 maxChars；缩不下来时小图原样返回，否则 null */
export function fitDataUrl(
  data: Buffer,
  mime: string,
  maxChars: number,
  maxEdge: number
): string | null {
  const raw = `data:${mime};base64,${data.toString('base64')}`;
  const image = decode(data);
  const size = image?.getSize();
  if (raw.length <= maxChars && (!size || Math.max(size.width, size.height) <= maxEdge)) return raw;
  const jpeg = shrink(
    data,
    [
      [maxEdge, 80],
      [Math.round(maxEdge * 0.75), 70],
      [Math.round(maxEdge * 0.5), 60],
      [Math.round(maxEdge * 0.35), 50],
    ],
    (out) => out.length * 1.34 + 32 <= maxChars
  );
  if (jpeg) return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  return raw.length <= maxChars ? raw : null;
}
