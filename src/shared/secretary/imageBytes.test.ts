import { describe, expect, it } from 'vitest';
import { readImageFacts, sniffViewableImage } from './imageBytes';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
const be32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const le16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const le24 = (value: number): number[] => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
];

function png(width: number, height: number): Uint8Array {
  return bytes(
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...be32(13),
    ...ascii('IHDR'),
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0
  );
}

function gif(width: number, height: number): Uint8Array {
  return bytes(...ascii('GIF89a'), ...le16(width), ...le16(height), 0, 0, 0);
}

function jpeg(width: number, height: number): Uint8Array {
  return bytes(
    0xff,
    0xd8,
    // APP0，长度 4（含长度本身两字节）
    0xff,
    0xe0,
    0x00,
    0x04,
    0x01,
    0x02,
    // SOF0：精度 8、高、宽
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x03
  );
}

function webpLossy(width: number, height: number): Uint8Array {
  return bytes(
    ...ascii('RIFF'),
    0,
    0,
    0,
    0,
    ...ascii('WEBP'),
    ...ascii('VP8 '),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    ...le16(width),
    ...le16(height)
  );
}

function webpLossless(width: number, height: number): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return bytes(
    ...ascii('RIFF'),
    0,
    0,
    0,
    0,
    ...ascii('WEBP'),
    ...ascii('VP8L'),
    0,
    0,
    0,
    0,
    0x2f,
    bits & 0xff,
    (bits >>> 8) & 0xff,
    (bits >>> 16) & 0xff,
    (bits >>> 24) & 0xff
  );
}

function webpExtended(width: number, height: number): Uint8Array {
  return bytes(
    ...ascii('RIFF'),
    0,
    0,
    0,
    0,
    ...ascii('WEBP'),
    ...ascii('VP8X'),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...le24(width - 1),
    ...le24(height - 1)
  );
}

describe('sniffViewableImage', () => {
  it('按文件头认出 png / jpeg / webp / gif，不看扩展名', () => {
    expect(sniffViewableImage(png(2, 3))).toBe('png');
    expect(sniffViewableImage(jpeg(2, 3))).toBe('jpeg');
    expect(sniffViewableImage(webpLossy(2, 3))).toBe('webp');
    expect(sniffViewableImage(gif(2, 3))).toBe('gif');
  });

  it('非图片与空字节一律认不出', () => {
    expect(sniffViewableImage(bytes())).toBeNull();
    expect(sniffViewableImage(bytes(...ascii('hello world')))).toBeNull();
    expect(sniffViewableImage(bytes(0x89, 0x50, 0x4e))).toBeNull();
    // RIFF 但不是 WEBP：比如 wav
    expect(sniffViewableImage(bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')))).toBeNull();
  });
});

describe('readImageFacts', () => {
  it('读出 png 的宽高', () => {
    expect(readImageFacts(png(1280, 720))).toMatchObject({
      format: 'png',
      mimeType: 'image/png',
      width: 1280,
      height: 720,
    });
  });

  it('读出 gif 的宽高', () => {
    expect(readImageFacts(gif(320, 200))).toMatchObject({ width: 320, height: 200 });
  });

  it('跳过 APP 段后从 SOF 读 jpeg 的宽高', () => {
    expect(readImageFacts(jpeg(800, 600))).toMatchObject({
      format: 'jpeg',
      mimeType: 'image/jpeg',
      width: 800,
      height: 600,
    });
  });

  it('三种 webp 头都能读出宽高', () => {
    expect(readImageFacts(webpLossy(640, 480))).toMatchObject({ width: 640, height: 480 });
    expect(readImageFacts(webpLossless(64, 48))).toMatchObject({ width: 64, height: 48 });
    expect(readImageFacts(webpExtended(1920, 1080))).toMatchObject({ width: 1920, height: 1080 });
  });

  it('格式认得但头部不完整时宽高为 null', () => {
    const truncated = png(10, 10).slice(0, 12);
    expect(readImageFacts(truncated)).toMatchObject({ format: 'png', width: null, height: null });
  });
});
