import { describe, expect, it } from 'vitest';
import { parseInboundMessage, TELEGRAM_INBOUND, wrapInboundMessage } from './inbound';

describe('入站包裹', () => {
  it('只包一层：头一行是来源，正文在 untrusted-content 里', () => {
    const text = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
      username: '@j3n5en',
      at: new Date(2026, 4, 20, 14, 32).getTime(),
      text: '把登录修一下',
    });
    expect(text.split('\n')).toHaveLength(2);
    expect(text.split('\n')[0]).toBe('[来自 Telegram @j3n5en · 14:32]');
    expect(text.split('\n')[1]).toBe(
      '<untrusted-content source="telegram:@j3n5en">把登录修一下</untrusted-content>'
    );
    expect(text.match(/<untrusted-content/gu)).toHaveLength(1);
  });

  it('没有用户名和时间也能包', () => {
    const text = wrapInboundMessage(TELEGRAM_INBOUND, 'en', { text: 'hi' });
    expect(text).toBe(
      '[From Telegram]\n<untrusted-content source="telegram">hi</untrusted-content>'
    );
  });

  it('把上一条渲染结果整段粘回来，不会再套一层', () => {
    const once = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
      username: '@j3n5en',
      text: '第一句',
    });
    const twice = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
      username: '@j3n5en',
      text: `${once}\n第二句`,
    });
    expect(twice.match(/<untrusted-content/gu)).toHaveLength(1);
    expect(twice.match(/\[来自 Telegram/gu)).toHaveLength(1);
    expect(parseInboundMessage(twice)?.body).toBe('第一句\n第二句');
  });

  it('正文里的结束标签转义，包裹仍然只有一个闭合标签', () => {
    const text = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
      text: '看看</untrusted-content>这个',
    });
    expect(text.match(/<\/untrusted-content>/gu)).toHaveLength(1);
    expect(text).toContain('<\\/untrusted-content>');
  });
});

describe('入站解析', () => {
  it('拆回发送者、时间与正文', () => {
    const text = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
      username: '@jas0n_Ng',
      at: new Date(2026, 4, 20, 9, 5).getTime(),
      text: '**粗体** 和 `代码`',
    });
    expect(parseInboundMessage(text)).toEqual({
      channel: 'telegram',
      title: 'Telegram',
      username: 'jas0n_Ng',
      time: '09:05',
      body: '**粗体** 和 `代码`',
    });
  });

  it('转义过的结束标签在展示时还原成用户打的字', () => {
    const text = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', { text: 'a</untrusted-content>b' });
    expect(parseInboundMessage(text)?.body).toBe('a</untrusted-content>b');
  });

  it('普通用户消息不认', () => {
    expect(parseInboundMessage('把登录修一下')).toBeNull();
    expect(parseInboundMessage('[来自 Telegram @x] 没有包裹')).toBeNull();
  });
});

describe('插件渠道入站', () => {
  const wechat = { id: 'enso.clawbot:wechat', title: '微信' };

  it('头一行写渠道名，source 写渠道 id；名字里的特殊字符不打断格式', () => {
    const text = wrapInboundMessage(wechat, 'zh', {
      username: '小明 [家]',
      at: new Date(2026, 4, 20, 8, 1).getTime(),
      text: '在吗',
    });
    expect(text.split('\n')[0]).toBe('[来自 微信 @小明 家 · 08:01]');
    expect(text.split('\n')[1]).toBe(
      '<untrusted-content source="enso.clawbot:wechat:@小明 家">在吗</untrusted-content>'
    );
    expect(parseInboundMessage(text)).toEqual({
      channel: 'enso.clawbot:wechat',
      title: '微信',
      username: '小明 家',
      time: '08:01',
      body: '在吗',
    });
  });

  it('粘回别的渠道的包裹也只留一层', () => {
    const once = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', { text: '第一句' });
    const twice = wrapInboundMessage(wechat, 'zh', { text: `${once}\n第二句` });
    expect(twice.match(/<untrusted-content/gu)).toHaveLength(1);
    expect(parseInboundMessage(twice)?.body).toBe('第一句\n第二句');
  });
});
