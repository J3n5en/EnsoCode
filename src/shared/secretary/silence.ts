/** 回复只有这一句时，表示这批 session-updates 已处理、不用打扰用户。 */
export const SILENT_MARKER = '<secretary-silent/>';

export function messageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const text = (part as { type?: unknown; text?: unknown }).text;
      return (part as { type?: unknown }).type === 'text' && typeof text === 'string' ? text : '';
    })
    .join('');
}

/** 去掉回传包裹后没有别的正文：这是系统注入，不是用户打的字 */
export function isPureSessionUpdate(text: string): boolean {
  if (!/<session-updates>|<secretary-schedule>/.test(text)) return false;
  const stripped = text
    .replace(/<session-updates>[\s\S]*?<\/session-updates>/g, '')
    .replace(/<secretary-schedule>[\s\S]*?<\/secretary-schedule>/g, '')
    .trim();
  return stripped.length === 0;
}

export function isSilentMarker(text: string): boolean {
  return text.trim() === SILENT_MARKER;
}

/** 只有系统注入的回传，并且回复只有静默标记，这一轮才不展示、不通知 */
export function shouldSilenceTurn(userText: string, assistantText: string): boolean {
  return isPureSessionUpdate(userText) && isSilentMarker(assistantText);
}

export function sessionIdsInUpdates(text: string): string[] {
  return [...text.matchAll(/session:([0-9a-z-]+)/gi)].map((match) => match[1]);
}

/** 静默回合从触发它的用户消息一直到这条回复，中间的工具结果一并隐藏 */
export function silentMessageIndexes(
  messages: readonly { role: string; content?: unknown }[]
): number[] {
  const hidden: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !isSilentMarker(messageText(message))) continue;
    let userIndex = -1;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const role = messages[cursor]?.role;
      if (role === 'user') {
        userIndex = cursor;
        break;
      }
      if (role === 'assistant') break;
    }
    if (userIndex < 0 || !isPureSessionUpdate(messageText(messages[userIndex] ?? {}))) continue;
    for (let cursor = userIndex; cursor <= index; cursor += 1) hidden.push(cursor);
  }
  return hidden;
}
