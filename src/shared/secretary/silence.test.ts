import { describe, expect, it } from 'vitest';
import {
  isPureSessionUpdate,
  SILENT_MARKER,
  shouldSilenceTurn,
  silentMessageIndexes,
  turnRequestedSilence,
} from './silence';

const updates = '<session-updates>\n- [turn-ended session:c1] 结束了\n</session-updates>';

describe('静默回传', () => {
  it('只有系统注入的回传配上静默标记才隐藏', () => {
    expect(shouldSilenceTurn(updates, SILENT_MARKER)).toBe(true);
    expect(shouldSilenceTurn(`帮我看看\n${updates}`, SILENT_MARKER)).toBe(false);
    expect(shouldSilenceTurn(updates, '做完了')).toBe(false);
    expect(isPureSessionUpdate(updates)).toBe(true);
  });

  it('系统回传里调用 silence_turn 才静默，用户自己的消息不算', () => {
    const schedule = '<secretary-schedule>\n- [schedule] 巡检\n</secretary-schedule>';
    const call = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 't', name: 'silence_turn' }],
    };
    expect(shouldSilenceTurn(schedule, '', true)).toBe(true);
    expect(shouldSilenceTurn('帮我看看', '好', true)).toBe(false);
    expect(
      turnRequestedSilence([
        { role: 'user', content: [{ type: 'text', text: updates }] },
        call,
        { role: 'toolResult', toolName: 'silence_turn', content: [{ type: 'text', text: 'ok' }] },
      ])
    ).toBe(true);
    expect(
      turnRequestedSilence([{ role: 'user', content: [{ type: 'text', text: '帮我看看' }] }, call])
    ).toBe(false);
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

  it('silence_turn 把系统回传和随后的工具结果一起算进静默区间', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: updates }] },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't', name: 'silence_turn' }],
      },
      { role: 'toolResult', toolName: 'silence_turn', content: [] },
    ];
    expect(silentMessageIndexes(messages)).toEqual([0, 1, 2]);
  });
});
