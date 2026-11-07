import { describe, expect, it } from 'vitest';
import { imageGenerationPreviewPaths, parseGeneratedImagePaths } from './imageGenerationResults';

describe('ImageGen 图片预览路径', () => {
  it('部分成功只预览成功落盘的图片，保留顺序并去重', () => {
    expect(
      imageGenerationPreviewPaths(
        JSON.stringify({
          items: [
            { status: 'success', path: '/tmp/a.png', mimeType: 'image/png' },
            { status: 'error', path: '/tmp/b.png', mimeType: 'image/png' },
            { status: 'cancelled', path: null, mimeType: null },
            { status: 'success', path: 'C:\\scratch\\图 #1.webp', mimeType: 'image/webp' },
            { status: 'success', path: '/tmp/a.png', mimeType: 'image/png' },
          ],
        })
      )
    ).toEqual(['/tmp/a.png', 'C:\\scratch\\图 #1.webp']);
  });

  it('坏 JSON、脏条目、相对路径、共享路径和非图片不产生预览', () => {
    for (const value of ['', 'oops', 'null', '{}', '{"items":[null,1,{}]}']) {
      expect(imageGenerationPreviewPaths(value)).toEqual([]);
    }
    for (const path of [
      'a.png',
      'https://a/a.png',
      '//server/a.png',
      '\\\\server\\a.png',
      '/tmp/a.html',
    ]) {
      expect(
        imageGenerationPreviewPaths(
          JSON.stringify({ items: [{ status: 'success', path, mimeType: 'image/png' }] })
        )
      ).toEqual([]);
      expect(parseGeneratedImagePaths([path])).toBeNull();
    }
    expect(parseGeneratedImagePaths([null])).toBeNull();
    expect(parseGeneratedImagePaths('bad')).toBeNull();
  });
});
