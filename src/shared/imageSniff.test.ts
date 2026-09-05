import { describe, expect, it } from 'vitest';
import { looksLikeSvg, sniffImageMime } from './imageSniff';

describe('sniffImageMime', () => {
  it('识别 PNG/JPEG/GIF/WEBP/BMP/ICO 的魔数', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png'
    );
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(
      sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))
    ).toBe('image/webp');
    expect(sniffImageMime(Buffer.from([0x42, 0x4d, 0, 0]))).toBe('image/bmp');
    expect(sniffImageMime(Buffer.from([0, 0, 1, 0]))).toBe('image/x-icon');
  });

  it('SVG 文本内容识别为 image/svg+xml（只通过 <img> 标签渲染，浏览器会按图片上下文禁脚本，见 imageSniff.ts 注释）', () => {
    expect(sniffImageMime(Buffer.from('<svg onload="alert(1)"></svg>'))).toBe('image/svg+xml');
    expect(sniffImageMime(Buffer.from('<?xml version="1.0"?><svg><script>x</script></svg>'))).toBe(
      'image/svg+xml'
    );
  });

  it('不是 svg 的文本内容（如单独的 script 标签）识别不出位图魔数', () => {
    expect(sniffImageMime(Buffer.from('<script>alert(1)</script>'))).toBeNull();
    expect(sniffImageMime(Buffer.from('<html><body>not svg</body></html>'))).toBeNull();
  });

  it('空/过短内容返回 null', () => {
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
    expect(sniffImageMime(Buffer.from([0x89]))).toBeNull();
  });
});

describe('looksLikeSvg', () => {
  it('容忍开头空白、xml 声明、注释后接 <svg', () => {
    expect(looksLikeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(true);
    expect(looksLikeSvg(Buffer.from('  \n<svg></svg>'))).toBe(true);
    expect(looksLikeSvg(Buffer.from('<?xml version="1.0"?>\n<svg></svg>'))).toBe(true);
    expect(looksLikeSvg(Buffer.from('<?xml version="1.0"?><!-- c --><svg></svg>'))).toBe(true);
  });

  it('svg 不在开头时不算（避免把任意内嵌了 <svg> 字样的文本误当图片）', () => {
    expect(looksLikeSvg(Buffer.from('<html><body><svg></svg></body></html>'))).toBe(false);
    expect(looksLikeSvg(Buffer.from('not svg at all'))).toBe(false);
  });
});
