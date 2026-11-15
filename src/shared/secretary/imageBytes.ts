/**
 * 秘书看图工具的纯字节工具：只按文件头判断格式，不看扩展名。
 * 认不出格式或读不出尺寸都返回 null，由调用方当成「不是图片」拒绝。
 */

export const VIEWABLE_IMAGE_FORMATS = ['png', 'jpeg', 'webp', 'gif'] as const;

export type ViewableImageFormat = (typeof VIEWABLE_IMAGE_FORMATS)[number];

export interface ImageFacts {
  format: ViewableImageFormat;
  mimeType: string;
  /** 读不出尺寸时为 null：格式认得，但头部信息不完整 */
  width: number | null;
  height: number | null;
}

const MIME: Record<ViewableImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const ascii = (bytes: Uint8Array, from: number, to: number): string => {
  let out = '';
  for (let index = from; index < to && index < bytes.length; index += 1)
    out += String.fromCharCode(bytes[index] ?? 0);
  return out;
};

const be32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) << 24) |
  ((bytes[at + 1] ?? 0) << 16) |
  ((bytes[at + 2] ?? 0) << 8) |
  (bytes[at + 3] ?? 0);

const le16 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);

const le24 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);

export function sniffViewableImage(bytes: Uint8Array): ViewableImageFormat | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value))
    return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP')
    return 'webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/u.test(ascii(bytes, 0, 6))) return 'gif';
  return null;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  // 8 字节签名 + 4 长度 + 4 类型 'IHDR' + 宽高各 4 字节
  if (bytes.length < 24 || ascii(bytes, 12, 16) !== 'IHDR') return null;
  return { width: be32(bytes, 16), height: be32(bytes, 20) };
}

function gifSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10) return null;
  return { width: le16(bytes, 6), height: le16(bytes, 8) };
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1] ?? 0;
    // 填充字节、无长度的标记与重启标记都只占两个字节
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0);
    if (length < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (at + 9 > bytes.length) return null;
      return {
        height: ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0),
        width: ((bytes[at + 7] ?? 0) << 8) | (bytes[at + 8] ?? 0),
      };
    }
    at += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  // RIFF(4) + 长度(4) + WEBP(4) + 块名(4) + 块长度(4) 之后才是块内容
  if (bytes.length < 21) return null;
  const chunk = ascii(bytes, 12, 16);
  if (chunk === 'VP8X') {
    if (bytes.length < 30) return null;
    // 1 字节标志 + 3 字节保留，然后画布宽高各 3 字节，存的是减一后的值
    return { width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1 };
  }
  if (chunk === 'VP8 ') {
    // 3 字节帧标签 + 3 字节同步码 0x9d 0x01 0x2a，然后宽高各 2 字节（低 14 位有效）
    if (bytes.length < 30) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits = le24(bytes, 21) | ((bytes[24] ?? 0) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

export function readImageFacts(bytes: Uint8Array): ImageFacts | null {
  const format = sniffViewableImage(bytes);
  if (!format) return null;
  const size =
    format === 'png'
      ? pngSize(bytes)
      : format === 'gif'
        ? gifSize(bytes)
        : format === 'jpeg'
          ? jpegSize(bytes)
          : webpSize(bytes);
  const width = size && size.width > 0 ? size.width : null;
  const height = size && size.height > 0 ? size.height : null;
  return { format, mimeType: MIME[format], width, height };
}
