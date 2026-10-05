import { describe, expect, it } from 'vitest';
import { botBrowserChatId, botBrowserKey, browserSessionKey } from './browser';

describe('bot 聊天共享浏览器', () => {
  it('同一聊天的所有成员会话落到同一个浏览器键', () => {
    const key = botBrowserKey('chat-1');
    expect(browserSessionKey('conv-a', { chatId: 'chat-1' })).toBe(key);
    expect(browserSessionKey('conv-b', { chatId: 'chat-1' })).toBe(key);
    expect(browserSessionKey('conv-c', { chatId: 'chat-2' })).not.toBe(key);
  });

  it('委派子会话按委派记录归到发起聊天', () => {
    const chatOf = (id: string) => (id === 'd1' ? 'chat-1' : null);
    expect(browserSessionKey('child', { chatId: null, delegationId: 'd1' }, chatOf)).toBe(
      botBrowserKey('chat-1')
    );
    expect(browserSessionKey('child', { chatId: null, delegationId: 'd2' }, chatOf)).toBe('child');
  });

  it('非 Bot 会话保持按会话隔离', () => {
    expect(browserSessionKey('conv-a')).toBe('conv-a');
  });

  it('能从键反解出聊天 id，普通会话 id 不误判', () => {
    expect(botBrowserChatId(botBrowserKey('chat-1'))).toBe('chat-1');
    expect(botBrowserChatId('conv-a')).toBeNull();
    expect(botBrowserChatId(botBrowserKey(''))).toBeNull();
  });
});
