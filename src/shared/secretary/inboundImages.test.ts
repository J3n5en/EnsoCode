import { describe, expect, it } from 'vitest';
import { appendInboundImageLines, splitInboundImageBlock } from './inboundImages';

const PATH = '/Users/u/Library/Application Support/enso-code/bot-chats/secretary-images/c/ab.png';
const WIN = 'C:\\Users\\u\\AppData\\Roaming\\enso-code\\bot-chats\\secretary-images\\c\\ab.png';

describe('splitInboundImageBlock', () => {
  it('拆出末尾的路径行与未收下行，正文其余部分原样', () => {
    const text = appendInboundImageLines('照这个改', [{ path: PATH }, { rejected: 'too-large' }]);
    expect(splitInboundImageBlock(text)).toEqual({
      text: '照这个改',
      entries: [
        { index: 1, path: PATH },
        { index: 2, rejected: 'too-large' },
      ],
    });
  });

  it('纯图片消息没有正文；pi 追加的 [Image …] 提示留在正文里', () => {
    expect(splitInboundImageBlock(appendInboundImageLines('', [{ path: WIN }]))).toEqual({
      text: '',
      entries: [{ index: 1, path: WIN }],
    });
    const hinted = `${appendInboundImageLines('看', [{ path: PATH }])}\n\n[Image converted from image/webp to image/png.]`;
    expect(splitInboundImageBlock(hinted)).toEqual({
      text: '看\n\n[Image converted from image/webp to image/png.]',
      entries: [{ index: 1, path: PATH }],
    });
  });

  it('正文中间、编号不连续、路径不在秘书图片目录、原因不是固定文案都不认', () => {
    expect(splitInboundImageBlock(`[图片 1] ${PATH}\n\n后面还有话`)).toBeNull();
    expect(splitInboundImageBlock(`看\n\n[图片 2] ${PATH}`)).toBeNull();
    expect(splitInboundImageBlock('看\n\n[图片 1] /etc/passwd')).toBeNull();
    expect(
      splitInboundImageBlock('看\n\n[图片 1] 相对/bot-chats/secretary-images/a.png')
    ).toBeNull();
    expect(splitInboundImageBlock('看\n\n[图片 1 未收下] 我自己写的')).toBeNull();
    expect(splitInboundImageBlock(`看\n[图片 1] ${PATH}`)).toBeNull();
  });

  it('用户自己写的同样文字在正文中间时保留，只拆末尾那块', () => {
    const typed = `先看 [图片 1] ${PATH}\n\n[图片 1] ${PATH}\n\n再说`;
    const text = appendInboundImageLines(typed, [{ path: PATH }]);
    expect(splitInboundImageBlock(text)?.text).toBe(typed);
  });

  it('秘书转发的图：已有缩略图的那几行接受任意绝对路径，多出来的仍只认秘书图片目录', () => {
    const text = appendInboundImageLines('按图改', [{ path: '/tmp/a.png' }]);
    expect(splitInboundImageBlock(text)).toBeNull();
    expect(splitInboundImageBlock(text, 1)).toEqual({
      text: '按图改',
      entries: [{ index: 1, path: '/tmp/a.png' }],
    });
    const two = appendInboundImageLines('按图改', [{ path: '/tmp/a.png' }, { path: '/tmp/b.png' }]);
    expect(splitInboundImageBlock(two, 1)).toBeNull();
    expect(splitInboundImageBlock('看\n\n[图片 1] 相对/a.png', 1)).toBeNull();
  });
});
