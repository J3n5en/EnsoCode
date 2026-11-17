import { describe, expect, it } from 'vitest';
import { parseInboundMessage, TELEGRAM_INBOUND, wrapInboundMessage } from './inbound';

describe('入站包裹', () => {
  it('只包一层：头一行是来源，正文在 untrusted-content 里', () => {
    const text = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
      chatId: '42',
      senderId: '42',
      senderName: '@j3n5en',
      at: new Date(2026, 4, 20, 14, 32).getTime(),
      text: '把登录修一下',
    });
    expect(text.split('\n')).toHaveLength(2);
    expect(text.split('\n')[0]).toBe('[来自 Telegram chatId=42 senderId=42 @j3n5en · 14:32]');
    expect(text.split('\n')[1]).toBe(
      '<untrusted-content source="telegram chatId=42 senderId=42">把登录修一下</untrusted-content>'
    );
    expect(text.match(/<untrusted-content/gu)).toHaveLength(1);
  });

  it('没有用户名和时间也能包', () => {
    const text = wrapInboundMessage(TELEGRAM_INBOUND, 'en', { text: 'hi' });
    expect(text).toBe(
      '[From Telegram sender unknown]\n<untrusted-content source="telegram sender=unknown">hi</untrusted-content>'
    );
  });

  it('把上一条渲染结果整段粘回来，不会再套一层', () => {
    const once = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
      senderName: '@j3n5en',
      text: '第一句',
    });
    const twice = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
      senderName: '@j3n5en',
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
      senderId: '7',
      senderName: '@jas0n_Ng',
      at: new Date(2026, 4, 20, 9, 5).getTime(),
      text: '**粗体** 和 `代码`',
    });
    expect(parseInboundMessage(text)).toEqual({
      channel: 'telegram',
      title: 'Telegram',
      senderId: '7',
      username: 'jas0n_Ng',
      time: '09:05',
      body: '**粗体** 和 `代码`',
    });
  });

  it('旧格式（只有名字）照样能拆回来', () => {
    const old =
      '[来自 Telegram @j3n5en · 14:32]\n<untrusted-content source="telegram:@j3n5en">在吗</untrusted-content>';
    expect(parseInboundMessage(old)).toEqual({
      channel: 'telegram',
      title: 'Telegram',
      username: 'j3n5en',
      time: '14:32',
      body: '在吗',
    });
    expect(
      parseInboundMessage(
        '[来自 微信 @小明 家 · 08:01]\n<untrusted-content source="enso.clawbot:wechat:@小明 家">在吗</untrusted-content>'
      )?.channel
    ).toBe('enso.clawbot:wechat');
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

  it('旧调用只有名字没有 senderId：标明发送者未知，不编 id', () => {
    const text = wrapInboundMessage(wechat, 'zh', {
      senderName: '小明 [家]',
      at: new Date(2026, 4, 20, 8, 1).getTime(),
      text: '在吗',
    });
    expect(text.split('\n')[0]).toBe('[来自 微信 发送者未知 @小明 家 · 08:01]');
    expect(text.split('\n')[1]).toBe(
      '<untrusted-content source="enso.clawbot:wechat sender=unknown">在吗</untrusted-content>'
    );
    expect(text).not.toContain('senderId=');
    expect(parseInboundMessage(text)).toEqual({
      channel: 'enso.clawbot:wechat',
      title: '微信',
      senderUnknown: true,
      username: '小明 家',
      time: '08:01',
      body: '在吗',
    });
  });

  it('只带 peerId 的旧入站：有 chatId，发送者未知', () => {
    const text = wrapInboundMessage(wechat, 'zh', { chatId: 'wxid_a@im.wechat', text: '在吗' });
    expect(text.split('\n')[0]).toBe('[来自 微信 chatId=wxid_a@im.wechat 发送者未知]');
    expect(text).toContain('source="enso.clawbot:wechat chatId=wxid_a@im.wechat sender=unknown"');
    expect(text).not.toContain('senderId=');
  });

  it('粘回别的渠道的包裹也只留一层', () => {
    const once = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', { text: '第一句' });
    const twice = wrapInboundMessage(wechat, 'zh', { text: `${once}\n第二句` });
    expect(twice.match(/<untrusted-content/gu)).toHaveLength(1);
    expect(parseInboundMessage(twice)?.body).toBe('第一句\n第二句');
  });
});

describe('入站身份', () => {
  const at = new Date(2026, 4, 20, 14, 32).getTime();

  it('Telegram 私聊：前缀与 source 都带 chatId 和 senderId', () => {
    const text = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
      chatId: '42',
      chatType: 'private',
      senderId: '42',
      senderName: 'alice',
      at,
      text: '在吗',
    });
    const [head, body] = text.split('\n');
    expect(head).toBe('[来自 Telegram 私聊 chatId=42 senderId=42 @alice · 14:32]');
    expect(body).toBe(
      '<untrusted-content source="telegram chatId=42 senderId=42">在吗</untrusted-content>'
    );
    expect(parseInboundMessage(text)).toEqual({
      channel: 'telegram',
      title: 'Telegram',
      chatId: '42',
      chatType: 'private',
      senderId: '42',
      username: 'alice',
      time: '14:32',
      body: '在吗',
    });
  });

  it('Telegram 群：群 chatId、chatType=group、群名与发送者 id', () => {
    const text = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
      chatId: '-1001234567890',
      chatType: 'group',
      chatTitle: 'Dev [core]',
      senderId: '42',
      senderName: 'alice',
      at,
      text: '看下构建',
    });
    const [head, body] = text.split('\n');
    expect(head).toBe(
      '[来自 Telegram 群「Dev core」 chatId=-1001234567890 senderId=42 @alice · 14:32]'
    );
    expect(body).toContain('source="telegram chatId=-1001234567890 senderId=42"');
    expect(parseInboundMessage(text)).toMatchObject({
      chatId: '-1001234567890',
      chatType: 'group',
      chatTitle: 'Dev core',
      senderId: '42',
    });
  });

  it('论坛话题：同一个群不同话题的前缀与 source 分得开', () => {
    const of = (topicId: string) =>
      wrapInboundMessage(TELEGRAM_INBOUND, 'en', {
        chatId: '-100777',
        chatType: 'group',
        topicId,
        senderId: '42',
        text: 'hi',
      });
    const a = of('3');
    const b = of('9');
    expect(a.split('\n')[0]).toBe('[From Telegram group chatId=-100777 topicId=3 senderId=42]');
    expect(b.split('\n')[0]).toBe('[From Telegram group chatId=-100777 topicId=9 senderId=42]');
    expect(a).toContain('source="telegram chatId=-100777 topicId=3 senderId=42"');
    expect(parseInboundMessage(a)?.topicId).toBe('3');
    expect(parseInboundMessage(b)?.topicId).toBe('9');
  });

  it('没有类型信息时不写私聊也不写群', () => {
    const text = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
      chatId: '42',
      senderId: '42',
      text: 'x',
    });
    expect(text.split('\n')[0]).toBe('[来自 Telegram chatId=42 senderId=42]');
    expect(parseInboundMessage(text)?.chatType).toBeUndefined();
  });

  it('id 里会打断格式的字符被转义，解析时还原', () => {
    const text = wrapInboundMessage(TELEGRAM_INBOUND, 'zh', {
      chatId: 'a b]"<x>',
      senderId: 'wxid_a@im.wechat',
      text: 'x',
    });
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('senderId=wxid_a@im.wechat');
    expect(text).not.toContain('a b]');
    expect(parseInboundMessage(text)).toMatchObject({
      chatId: 'a b]"<x>',
      senderId: 'wxid_a@im.wechat',
    });
  });
});
