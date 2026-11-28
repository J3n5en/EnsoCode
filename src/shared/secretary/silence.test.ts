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
    const trigger =
      '<secretary-trigger>\n- [trigger id=trg-123456 name="微信群"]\n<untrusted-content source="trigger:trg-123456">闲聊</untrusted-content>\n</secretary-trigger>';
    expect(shouldSilenceTurn(trigger, '', true)).toBe(true);
    expect(isPureSessionUpdate(trigger)).toBe(true);
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

  it('插件投递与 agent-notification 触发的静默回合以及 turn_discard 都不通知，用户手打消息不静默', () => {
    const callSilence = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 't1', name: 'silence_turn' }],
    };
    // 插件投递（role: custom + pluginSource）+ silence_turn：即便模型多吐了文本也判静默
    expect(
      turnRequestedSilence([
        {
          role: 'custom',
          pluginSource: { pluginId: 'enso.tgclient', name: 'Telegram' },
          content: [{ type: 'text', text: '[Telegram] 群聊闲聊' }],
        },
        callSilence,
        { role: 'toolResult', toolName: 'silence_turn', content: [{ type: 'text', text: 'ok' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Silenced.' }] },
      ])
    ).toBe(true);

    // <agent-notification> 提醒触发 + silence_turn
    expect(
      turnRequestedSilence([
        {
          role: 'user',
          content: [
            { type: 'text', text: '<agent-notification>Reminder due</agent-notification>' },
          ],
        },
        callSilence,
      ])
    ).toBe(true);

    // 插件投递 + turn_discard 成功：不打扰用户；若 turn_discard 报错则不静默
    expect(
      turnRequestedSilence([
        {
          role: 'custom',
          pluginSource: { pluginId: 'enso.github', name: 'GitHub' },
          content: [{ type: 'text', text: '[GitHub] noise' }],
        },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'd1', name: 'turn_discard' }] },
        { role: 'toolResult', toolName: 'turn_discard', isError: false, content: [] },
      ])
    ).toBe(true);
    expect(
      turnRequestedSilence([
        {
          role: 'custom',
          pluginSource: { pluginId: 'enso.github', name: 'GitHub' },
          content: [{ type: 'text', text: '[GitHub] noise' }],
        },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'd1', name: 'turn_discard' }] },
        { role: 'toolResult', toolName: 'turn_discard', isError: true, content: [] },
      ])
    ).toBe(false);

    // 用户自己打字触发 + turn_discard：仍应正常通知（因为模型可能在同一轮回答了用户）
    expect(
      turnRequestedSilence([
        { role: 'user', content: [{ type: 'text', text: '今天周几' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '周六' },
            { type: 'toolCall', id: 'd1', name: 'turn_discard' },
          ],
        },
        { role: 'toolResult', toolName: 'turn_discard', isError: false, content: [] },
      ])
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
