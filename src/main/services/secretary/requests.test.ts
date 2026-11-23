import { describe, expect, it } from 'vitest';
import {
  parseAvatarRequest,
  parseDismissPendingRequest,
  parseQueuedStartRequest,
} from './requests';

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

describe('parseDismissPendingRequest', () => {
  it('只收非空字符串 pendingId，坏输入一律拒绝', () => {
    expect(parseDismissPendingRequest({ pendingId: 'pend-1' })).toEqual({ pendingId: 'pend-1' });
    for (const request of [null, 'pend-1', [], {}, { pendingId: '' }, { pendingId: 1 }]) {
      expect(parseDismissPendingRequest(request)).toBeNull();
    }
  });
});

describe('parseQueuedStartRequest', () => {
  it('只带会话 id；带上排队期间的消息与图片', () => {
    expect(parseQueuedStartRequest({ conversationId: 'c1' })).toEqual({ conversationId: 'c1' });
    expect(
      parseQueuedStartRequest({
        conversationId: 'c1',
        followUp: { text: '顺便看下日志', images: [{ data: 'AAAA', mimeType: 'image/png' }] },
      })
    ).toEqual({
      conversationId: 'c1',
      followUp: { text: '顺便看下日志', images: [{ data: 'AAAA', mimeType: 'image/png' }] },
    });
  });

  it('空消息当作没带；坏形状整条拒绝', () => {
    expect(parseQueuedStartRequest({ conversationId: 'c1', followUp: { text: '  ' } })).toEqual({
      conversationId: 'c1',
    });
    expect(parseQueuedStartRequest({ conversationId: '' })).toBeNull();
    expect(parseQueuedStartRequest({ conversationId: 'c1', followUp: 'hi' })).toBeNull();
    expect(
      parseQueuedStartRequest({
        conversationId: 'c1',
        followUp: { text: 'x', images: [{ data: 'AAAA', mimeType: 'text/plain' }] },
      })
    ).toBeNull();
  });
});
