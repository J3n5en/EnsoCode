import { describe, expect, it, vi } from 'vitest';
import type { DecodedImage } from '../../platform/types';
import { shrinkRemoteAvatar } from './imageShrink';

const bigBytes = (size = 200 * 1024) => new Uint8Array(size).fill(1);

describe('shrinkRemoteAvatar', () => {
  it('非头像 URL、未超阈值（<=128KB）和 GIF/SVG 原样返回，不解码', () => {
    const fromBuffer = vi.fn();
    const images = { fromBuffer };
    const large = bigBytes(200 * 1024);
    const small = bigBytes(128 * 1024);

    expect(
      shrinkRemoteAvatar('local-image://secretary-report/a.png', 'image/png', large, images)
    ).toEqual({ contentType: 'image/png', body: large });
    expect(
      shrinkRemoteAvatar('local-image://secretary-avatar?s=default&v=1', 'image/png', small, images)
    ).toEqual({ contentType: 'image/png', body: small });
    expect(
      shrinkRemoteAvatar('local-image://bot-avatar/b1?v=1', 'image/gif', large, images)
    ).toEqual({ contentType: 'image/gif', body: large });
    expect(
      shrinkRemoteAvatar('local-image://bot-avatar/b1?v=1', 'image/svg+xml', large, images)
    ).toEqual({ contentType: 'image/svg+xml', body: large });
    expect(fromBuffer).not.toHaveBeenCalled();
  });

  it('超大秘书/成员头像按最长边<=256等比缩放并选更小格式输出', () => {
    const resizeCalls: Array<{ width: number; height: number; quality?: string }> = [];
    const jpegOut = Buffer.from('jpeg-small');
    const pngOut = Buffer.from('png-larger-output-bytes');
    const decoded: DecodedImage = {
      getSize: () => ({ width: 1024, height: 512 }),
      resize: (opts) => {
        resizeCalls.push(opts);
        return decoded;
      },
      toJPEG: () => jpegOut,
      toPNG: () => pngOut,
    };
    const body = bigBytes(300 * 1024);

    const shrunk = shrinkRemoteAvatar(
      'local-image://secretary-avatar?s=default&v=2',
      'image/png',
      body,
      { fromBuffer: () => decoded }
    );
    expect(resizeCalls).toEqual([{ width: 256, height: 128, quality: 'better' }]);
    expect(shrunk.contentType).toBe('image/jpeg');
    expect(Buffer.from(shrunk.body).equals(jpegOut)).toBe(true);
  });

  it('PNG 编码更小时优先返回 PNG，bot-avatar 同样生效', () => {
    const decoded: DecodedImage = {
      getSize: () => ({ width: 200, height: 200 }),
      resize: () => decoded,
      toJPEG: () => Buffer.alloc(12_000, 3),
      toPNG: () => Buffer.alloc(4_000, 2),
    };
    const body = bigBytes(200 * 1024);

    const shrunk = shrinkRemoteAvatar('local-image://bot-avatar/bot-1?v=9', 'image/png', body, {
      fromBuffer: () => decoded,
    });
    expect(shrunk.contentType).toBe('image/png');
    expect(shrunk.body.byteLength).toBe(4_000);
  });

  it('平台未提供 images、解码失败或压缩后未变小时回退原图', () => {
    const body = bigBytes(150 * 1024);
    expect(shrinkRemoteAvatar('local-image://bot-avatar/b1?v=1', 'image/jpeg', body, null)).toEqual(
      { contentType: 'image/jpeg', body }
    );

    const largerOut = Buffer.alloc(200 * 1024, 9);
    const decoded: DecodedImage = {
      getSize: () => ({ width: 512, height: 512 }),
      resize: () => decoded,
      toJPEG: () => largerOut,
    };
    expect(
      shrinkRemoteAvatar('local-image://bot-avatar/b1?v=1', 'image/jpeg', body, {
        fromBuffer: () => decoded,
      })
    ).toEqual({ contentType: 'image/jpeg', body });
    expect(
      shrinkRemoteAvatar('local-image://bot-avatar/b1?v=1', 'image/jpeg', body, {
        fromBuffer: () => {
          throw new Error('decode failed');
        },
      })
    ).toEqual({ contentType: 'image/jpeg', body });
  });
});
