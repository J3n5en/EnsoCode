import { describe, expect, it } from 'vitest';
import { describeForwardedImages, formatAttachmentBlock } from './attachments';

const IMAGES = [
  { path: '/tmp/a.png', size: 2048 },
  { path: '/tmp/b.jpg', size: 3 * 1024 * 1024 },
];

describe('formatAttachmentBlock', () => {
  it('逐张写出路径，并让目标会话自己用 image_view 看', () => {
    expect(formatAttachmentBlock(IMAGES, true).split('\n')).toEqual([
      '[图片 1] /tmp/a.png',
      '[图片 2] /tmp/b.jpg',
      '用 image_view 查看这些图片。',
    ]);
  });

  it('目标会话没有 image_view 时说明看不了图', () => {
    const block = formatAttachmentBlock([IMAGES[0]!], false);
    expect(block).toContain('[图片 1] /tmp/a.png');
    expect(block).toContain('当前会话无法查看图片');
  });
});

describe('describeForwardedImages', () => {
  it('审计摘要只写路径与大小', () => {
    expect(describeForwardedImages(IMAGES)).toBe('/tmp/a.png (2.0 KB), /tmp/b.jpg (3.0 MB)');
  });

  it('小于 1KB 时按字节写', () => {
    expect(describeForwardedImages([{ path: '/tmp/c.png', size: 12 }])).toBe('/tmp/c.png (12 B)');
  });
});
