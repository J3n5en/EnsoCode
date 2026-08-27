/** Cursor 助手文本/思考帧 → 与其它 provider 相同的 assistant 投影结构。 */

export type CursorAssistantFrame =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string };

export interface TranslatedAssistantMessage {
  role: 'assistant';
  content: Array<{ type: 'text'; text: string } | { type: 'thinking'; text: string }>;
}

/** 把 Cursor 流里的文本/思考帧收成会话可见的 assistant 消息。 */
export function translateCursorAssistantFrames(
  frames: CursorAssistantFrame[]
): TranslatedAssistantMessage {
  const content: TranslatedAssistantMessage['content'] = [];
  for (const frame of frames) {
    if (frame.type === 'thinking') {
      const text = frame.text ?? '';
      if (text) content.push({ type: 'thinking', text });
      continue;
    }
    const text = frame.text ?? '';
    if (text) content.push({ type: 'text', text });
  }
  return { role: 'assistant', content };
}
