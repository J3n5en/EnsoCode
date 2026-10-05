/** 人物卡 PNG 与成员头像的纯字节工具（renderer / Main 共用，不依赖 node） */

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export type AvatarFormat = 'png' | 'jpeg' | 'webp';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

let table: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function sniffImage(bytes: Uint8Array): AvatarFormat | null {
  if (SIGNATURE.every((value, index) => bytes[index] === value)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (latin1(bytes.subarray(0, 4)) === 'RIFF' && latin1(bytes.subarray(8, 12)) === 'WEBP')
    return 'webp';
  return null;
}

export const checkAvatarImage = (bytes: Uint8Array): boolean =>
  bytes.length > 0 && bytes.length <= AVATAR_MAX_BYTES && sniffImage(bytes) !== null;

interface Chunk {
  type: string;
  data: Uint8Array;
  raw: Uint8Array;
}

/** 结构完整（签名、长度、IEND 收尾）才返回；CRC 不在读时校验，宽容外部卡 */
function readChunks(png: Uint8Array): Chunk[] | null {
  if (sniffImage(png) !== 'png') return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const list: Chunk[] = [];
  for (let at = 8; at + 12 <= png.length; ) {
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > png.length) return null;
    const type = latin1(png.subarray(at + 4, at + 8));
    list.push({ type, data: png.subarray(at + 8, at + 8 + length), raw: png.subarray(at, end) });
    at = end;
    if (type === 'IEND') return list;
  }
  return null;
}

const keywordOf = (chunk: Chunk): string | null => {
  if (chunk.type !== 'tEXt') return null;
  const zero = chunk.data.indexOf(0);
  return zero > 0 ? latin1(chunk.data.subarray(0, zero)) : null;
};

/** 读 tEXt 的 latin1 文本（SillyTavern 的 chara 存 base64，纯 ASCII） */
export function readPngText(png: Uint8Array, keyword: string): string | null {
  const chunk = readChunks(png)?.find((item) => keywordOf(item) === keyword);
  return chunk ? latin1(chunk.data.subarray(keyword.length + 1)) : null;
}

function encodeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** 写入（替换同名，并删掉 drop 里的关键字）一个 tEXt，放在 IEND 前；text 须为 ASCII */
export function writePngText(
  png: Uint8Array,
  keyword: string,
  text: string,
  drop: readonly string[] = []
): Uint8Array | null {
  const list = readChunks(png);
  if (!list) return null;
  const removed = new Set([keyword, ...drop]);
  const kept = list.filter((item) => {
    const key = keywordOf(item);
    return item.type !== 'IEND' && !(key && removed.has(key));
  });
  const body = Uint8Array.from(`${keyword}\0${text}`, (char) => char.charCodeAt(0) & 0xff);
  const parts = [
    Uint8Array.from(SIGNATURE),
    ...kept.map((item) => item.raw),
    encodeChunk('tEXt', body),
    encodeChunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function utf8ToBase64(text: string): string {
  return btoa(latin1(new TextEncoder().encode(text)));
}

export function base64ToUtf8(base64: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(base64.trim()), (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
