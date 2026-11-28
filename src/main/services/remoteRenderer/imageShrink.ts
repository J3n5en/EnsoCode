import type { DecodedImage } from '../../platform/types';

const AVATAR_HOSTS = new Set(['secretary-avatar', 'bot-avatar']);
const MAX_AVATAR_RAW_BYTES = 128 * 1024;
const MAX_AVATAR_DIM = 256;
const JPEG_QUALITY = 82;

function isShrinkableAvatar(rawUrl: string, contentType: string, byteLength: number): boolean {
  if (byteLength <= MAX_AVATAR_RAW_BYTES) return false;
  const mime = contentType.toLowerCase();
  if (!mime.startsWith('image/') || mime.startsWith('image/gif') || mime.startsWith('image/svg')) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'local-image:' && AVATAR_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** 远端展示秘书/成员头像只需小尺寸图：原图 >128KB 时缩至最长边<=256并取更小编码，降首屏图片流量与缓存开销 */
export function shrinkRemoteAvatar(
  rawUrl: string,
  contentType: string,
  body: Uint8Array,
  imageCodec?: { fromBuffer(data: Buffer): DecodedImage | null } | null
): { contentType: string; body: Uint8Array } {
  if (!imageCodec || !isShrinkableAvatar(rawUrl, contentType, body.byteLength)) {
    return { contentType, body };
  }
  try {
    const decoded = imageCodec.fromBuffer(
      Buffer.from(body.buffer, body.byteOffset, body.byteLength)
    );
    if (!decoded) return { contentType, body };
    const { width, height } = decoded.getSize();
    if (width <= 0 || height <= 0) return { contentType, body };

    const longest = Math.max(width, height);
    const target =
      longest > MAX_AVATAR_DIM
        ? decoded.resize({
            width: Math.max(1, Math.round((width * MAX_AVATAR_DIM) / longest)),
            height: Math.max(1, Math.round((height * MAX_AVATAR_DIM) / longest)),
            quality: 'better',
          })
        : decoded;

    const jpeg = target.toJPEG(JPEG_QUALITY);
    const png = target.toPNG?.();
    const usePng = png !== undefined && png.byteLength > 0 && png.byteLength < jpeg.byteLength;
    const pickedMime = usePng ? 'image/png' : 'image/jpeg';
    const pickedBuf = usePng ? png : jpeg;
    if (pickedBuf.byteLength === 0 || pickedBuf.byteLength >= body.byteLength) {
      return { contentType, body };
    }
    return { contentType: pickedMime, body: new Uint8Array(pickedBuf) };
  } catch {
    return { contentType, body };
  }
}
