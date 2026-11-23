import { describe, expect, it } from 'vitest';
import { parsePluginInjectOrigin, parsePluginInjectSender } from './protocol';

describe('parsePluginInjectSender', () => {
  it('接受合法发送者，数字 id 收成字符串', () => {
    expect(
      parsePluginInjectSender({
        channel: ' telegram ',
        userId: 7,
        chatId: ' 42 ',
        displayName: '  Ada ',
      })
    ).toEqual({ channel: 'telegram', userId: '7', chatId: '42', displayName: 'Ada' });
    expect(parsePluginInjectSender({ channel: 'tg', chatId: -100 })).toEqual({
      channel: 'tg',
      chatId: '-100',
    });
  });

  it('缺省是未提供，非法字段整单拒绝', () => {
    expect(parsePluginInjectSender(undefined)).toBeUndefined();
    for (const value of [
      null,
      [],
      'telegram',
      { userId: '1' },
      { channel: '' },
      { channel: 'has space' },
      { channel: 'telegram', userId: '' },
      { channel: 'telegram', userId: 1.5 },
      { channel: 'telegram', chatId: '   ' },
      { channel: 'telegram', displayName: 1 },
    ]) {
      expect(parsePluginInjectSender(value)).toBeNull();
    }
  });

  it('剥掉插件自报的 owner / role，显示名过长截断，空显示名不填', () => {
    const parsed = parsePluginInjectSender({
      channel: 'telegram',
      userId: '1',
      displayName: ` ${'名'.repeat(200)} `,
      isOwner: true,
      owner: true,
      role: 'owner',
      trusted: true,
    });
    expect(parsed).toEqual({
      channel: 'telegram',
      userId: '1',
      displayName: '名'.repeat(128),
    });
    expect(parsed && Object.keys(parsed).sort()).toEqual(['channel', 'displayName', 'userId']);
    expect(parsePluginInjectSender({ channel: 'telegram', displayName: '   ' })).toEqual({
      channel: 'telegram',
    });
  });
});

describe('parsePluginInjectOrigin', () => {
  it('只接受 owner 与 external', () => {
    expect(parsePluginInjectOrigin('owner')).toBe('owner');
    expect(parsePluginInjectOrigin('external')).toBe('external');
    expect(parsePluginInjectOrigin(undefined)).toBeUndefined();
    expect(parsePluginInjectOrigin('trusted')).toBeUndefined();
    expect(parsePluginInjectOrigin(true)).toBeUndefined();
  });
});
