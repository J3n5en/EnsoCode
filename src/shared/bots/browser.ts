/** Bot 聊天共享浏览器：同一聊天（含其委派子会话）的成员共用一个浏览器会话键 */
const PREFIX = 'bot-chat:';

export const botBrowserKey = (chatId: string): string => `${PREFIX}${chatId}`;

export function botBrowserChatId(key: string): string | null {
  return key.startsWith(PREFIX) && key.length > PREFIX.length ? key.slice(PREFIX.length) : null;
}

export function browserSessionKey(
  sessionId: string,
  bot?: { chatId: string | null; delegationId?: string },
  delegationChatId?: (delegationId: string) => string | null | undefined
): string {
  const chatId =
    bot?.chatId ?? (bot?.delegationId ? delegationChatId?.(bot.delegationId) : undefined);
  return chatId ? botBrowserKey(chatId) : sessionId;
}
