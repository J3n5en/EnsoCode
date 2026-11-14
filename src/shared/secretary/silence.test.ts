import { describe, expect, it } from 'vitest';
import {
  isPureSessionUpdate,
  SILENT_MARKER,
  shouldSilenceTurn,
  silentMessageIndexes,
} from './silence';

const updates = '<session-updates>\n- [turn-ended session:c1] 结束了\n</session-updates>';

describe('静默回传', () => {
  it('只有系统注入的回传配上静默标记才隐藏', () => {
    expect(shouldSilenceTurn(updates, SILENT_MARKER)).toBe(true);
    expect(shouldSilenceTurn(`帮我看看\n${updates}`, SILENT_MARKER)).toBe(false);
    expect(shouldSilenceTurn(updates, '做完了')).toBe(false);
    expect(isPureSessionUpdate(updates)).toBe(true);
  });

  it('隐藏从回传消息到静默回复，用户自己的回合留着', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', content: [{ type: 'text', text: '在' }] },
      { role: 'user', content: [{ type: 'text', text: updates }] },
      { role: 'assistant', content: [{ type: 'text', text: ` ${SILENT_MARKER} ` }] },
    ];
    expect(silentMessageIndexes(messages)).toEqual([2, 3]);
  });
});
