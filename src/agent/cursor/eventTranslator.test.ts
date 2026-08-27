import { describe, expect, it } from 'vitest';
import { translateCursorAssistantFrames } from './eventTranslator';

describe('translateCursorAssistantFrames', () => {
  it('文本帧变成非空 assistant text part', () => {
    const message = translateCursorAssistantFrames([{ type: 'text', text: '你好，这是回复' }]);
    expect(message.role).toBe('assistant');
    expect(message.content).toEqual([{ type: 'text', text: '你好，这是回复' }]);
    expect(message.content.some((part) => part.type === 'text' && part.text.length > 0)).toBe(true);
  });

  it('思考帧映射为 thinking part，与其它 provider 的 assistant 结构一致', () => {
    const message = translateCursorAssistantFrames([
      { type: 'thinking', text: '先读文件' },
      { type: 'text', text: '好的' },
    ]);
    expect(message).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', text: '先读文件' },
        { type: 'text', text: '好的' },
      ],
    });
  });
});
