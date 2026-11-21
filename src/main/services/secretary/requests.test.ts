import { describe, expect, it } from 'vitest';
import { parseAvatarRequest } from './requests';

const bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

describe('parseAvatarRequest', () => {
  it('秘书头像收 PNG / GIF87a / GIF89a 原字节，null 表示移除', () => {
    const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0);
    expect(parseAvatarRequest({ image: png })).toEqual({ image: png });
    for (const magic of ['GIF89a', 'GIF87a']) {
      const gif = bytes(`${magic}\x01\x00\x01\x00`);
      expect(parseAvatarRequest({ image: gif })?.image).toBe(gif);
    }
    expect(parseAvatarRequest({ image: null })).toEqual({ image: null });
  });

  it('坏输入、伪 GIF 与超过 2MB 的 GIF 一律拒绝', () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(bytes('GIF89a'));
    for (const request of [
      null,
      [],
      { image: 'GIF89a' },
      { image: bytes('GIF88a\x01') },
      { image: bytes('<svg/>') },
      { image: new Uint8Array() },
      { image: big },
    ]) {
      expect(parseAvatarRequest(request)).toBeNull();
    }
  });
});
