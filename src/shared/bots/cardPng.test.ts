import { describe, expect, it } from 'vitest';
import {
  AVATAR_MAX_BYTES,
  base64ToUtf8,
  checkAvatarImage,
  crc32,
  readPngText,
  sniffImage,
  utf8ToBase64,
  writePngText,
} from './cardPng';

// 1x1 透明 PNG
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  ),
  (c) => c.charCodeAt(0)
);

function chunks(png: Uint8Array): { type: string; crcOk: boolean }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; crcOk: boolean }[] = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    out.push({
      type: String.fromCharCode(...png.subarray(at + 4, at + 8)),
      crcOk: crc32(png.subarray(at + 4, at + 8 + length)) === view.getUint32(at + 8 + length),
    });
    at += 12 + length;
  }
  return out;
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('png text chunks', () => {
  it('writes a tEXt chunk before IEND with a valid CRC and reads it back', () => {
    const out = writePngText(PNG, 'chara', 'aGVsbG8=');
    expect(out).not.toBeNull();
    if (!out) return;
    const list = chunks(out);
    expect(list.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'tEXt', 'IEND']);
    expect(list.every((c) => c.crcOk)).toBe(true);
    expect(readPngText(out, 'chara')).toBe('aGVsbG8=');
  });

  it('replaces an existing chunk instead of duplicating it and drops ccv3', () => {
    const first = writePngText(writePngText(PNG, 'ccv3', 'old3') as Uint8Array, 'chara', 'one');
    const second = writePngText(first as Uint8Array, 'chara', 'two', ['ccv3']) as Uint8Array;
    expect(chunks(second).filter((c) => c.type === 'tEXt')).toHaveLength(1);
    expect(readPngText(second, 'chara')).toBe('two');
    expect(readPngText(second, 'ccv3')).toBeNull();
  });

  it('rejects non-PNG and truncated input', () => {
    expect(writePngText(new Uint8Array([1, 2, 3]), 'chara', 'x')).toBeNull();
    expect(readPngText(PNG.subarray(0, 20), 'chara')).toBeNull();
    expect(readPngText(PNG, 'chara')).toBeNull();
  });
});

describe('base64 utf8', () => {
  it('round-trips non-ASCII text', () => {
    const text = '{"name":"林经理 🚀"}';
    expect(base64ToUtf8(utf8ToBase64(text))).toBe(text);
    expect(base64ToUtf8('%%%')).toBeNull();
  });
});

describe('avatar image check', () => {
  it('sniffs PNG / JPEG / WebP by magic bytes', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffImage(new TextEncoder().encode('<svg></svg>'))).toBeNull();
  });

  it('rejects empty, oversized and unknown data', () => {
    expect(checkAvatarImage(PNG)).toBe(true);
    expect(checkAvatarImage(new Uint8Array())).toBe(false);
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1);
    big.set(PNG);
    expect(checkAvatarImage(big)).toBe(false);
    expect(checkAvatarImage(new TextEncoder().encode('GIF89a'))).toBe(false);
  });
});
