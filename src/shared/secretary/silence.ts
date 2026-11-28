/** 回复只有这一句时，表示这批 session-updates 已处理、不用打扰用户。旧写法，新回合用 silence_turn。 */
export const SILENT_MARKER = '<secretary-silent/>';

/** 秘书内置工具：调用后结束本轮，表示系统推送不需要打扰用户。 */
export const SILENCE_TURN_TOOL = 'silence_turn';
export const TURN_DISCARD_TOOL = 'turn_discard';

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
  if (
    !/<session-updates>|<secretary-schedule>|<secretary-message>|<secretary-trigger>|<agent-notification>/.test(
      text
    )
  )
    return false;
  const stripped = text
    .replace(/<session-updates>[\s\S]*?<\/session-updates>/g, '')
    .replace(/<secretary-schedule>[\s\S]*?<\/secretary-schedule>/g, '')
    .replace(/<secretary-message>[\s\S]*?<\/secretary-message>/g, '')
    .replace(/<secretary-trigger>[\s\S]*?<\/secretary-trigger>/g, '')
    .replace(/<agent-notification>[\s\S]*?<\/agent-notification>/g, '')
    .trim();
  return stripped.length === 0;
}

export function isSilentMarker(text: string): boolean {
  return text.trim() === SILENT_MARKER;
}

export function calledSilenceTurn(message: {
  role?: string;
  toolName?: string;
  content?: unknown;
}): boolean {
  if (message.toolName === SILENCE_TURN_TOOL) return true;
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return false;
  return message.content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const record = part as { type?: unknown; name?: unknown };
    return record.type === 'toolCall' && record.name === SILENCE_TURN_TOOL;
  });
}

function calledTurnDiscardSuccessfully(
  turn: readonly { role?: string; toolName?: string; isError?: boolean; content?: unknown }[]
): boolean {
  return turn.some(
    (message) =>
      message.role === 'toolResult' &&
      message.toolName === TURN_DISCARD_TOOL &&
      message.isError !== true
  );
}

/** 本轮调用过 silence_turn。不要求用户消息是系统回传。 */
export function turnCalledSilenceTurn(
  messages: readonly { role?: string; toolName?: string; content?: unknown }[],
  fromIndex = 0
): boolean {
  return messages.slice(Math.max(0, fromIndex)).some((message) => calledSilenceTurn(message));
}

/**
 * 只有系统注入的回传，并且本轮调用了 silence_turn 或回复只有静默标记，才折叠、不通知。
 * 用户自己打的字即使调用了工具也不算。
 */
export function shouldSilenceTurn(
  userText: string,
  assistantText: string,
  calledSilence = false
): boolean {
  return isPureSessionUpdate(userText) && (calledSilence || isSilentMarker(assistantText));
}

/** 从本轮消息判断该不该静默。用户文本取原始正文，不走标题清洗。 */
export function turnRequestedSilence(
  messages: readonly {
    role?: string;
    toolName?: string;
    isError?: boolean;
    pluginSource?: unknown;
    content?: unknown;
  }[],
  fromIndex = 0
): boolean {
  const turn = messages.slice(Math.max(0, fromIndex));
  let userText = '';
  let assistantText = '';
  let called = false;
  let hasNonUserTrigger = false;
  for (const message of turn) {
    if (calledSilenceTurn(message)) called = true;
    if (message.role === 'user') {
      const text = messageText(message);
      if (text) userText = userText ? `${userText}\n${text}` : text;
    } else if (message.role === 'assistant') {
      const text = messageText(message).trim();
      if (text) assistantText = text;
    } else if (message.role === 'custom' && message.pluginSource) {
      hasNonUserTrigger = true;
    }
  }
  if (shouldSilenceTurn(userText, assistantText, called)) return true;
  const noTypedUserInput = userText.length === 0;
  // 插件投递（Telegram / GitHub watch / Scheduler 等）在消息流里是 role:'custom' 而非 user；
  // 没有用户手打正文时，调用 silence_turn 或成功调用 turn_discard 都不应弹桌面/手机通知。
  if (called && noTypedUserInput) return true;
  if (
    hasNonUserTrigger &&
    noTypedUserInput &&
    (isSilentMarker(assistantText) || calledTurnDiscardSuccessfully(turn))
  ) {
    return true;
  }
  return false;
}

export function sessionIdsInUpdates(text: string): string[] {
  return [...text.matchAll(/session:([0-9a-z-]+)/gi)].map((match) => match[1]);
}

/** 静默回合从触发它的用户消息一直到这条回复，中间的工具结果一并隐藏 */
export function silentMessageIndexes(
  messages: readonly { role: string; content?: unknown }[]
): number[] {
  const hidden = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const marked = isSilentMarker(messageText(message));
    const called = calledSilenceTurn(message);
    if (!marked && !called) continue;
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
    let end = index;
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      if (messages[cursor]?.role === 'user') break;
      end = cursor;
    }
    for (let cursor = userIndex; cursor <= end; cursor += 1) hidden.add(cursor);
  }
  return [...hidden];
}
