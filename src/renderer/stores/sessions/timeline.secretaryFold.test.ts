import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { buildTimeline, foldTimeline } from './timeline';
import { user } from './timeline.testUtils';

const read = (id: string): ProjectedMessage => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name: 'session_read', arguments: { conversationId: id } }],
});
const result = (id: string): ProjectedMessage => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'session_read',
  content: [{ type: 'text', text: 'ok' }],
});

describe('秘书回合折叠', () => {
  it('只有工具、没有实质回复时收成一行，有回复则展开', () => {
    const quiet = foldTimeline(
      buildTimeline([user('看看'), read('a'), result('a'), read('b'), result('b')], false),
      false,
      new Set(),
      { foldToolOnlyTurns: true }
    );
    expect(quiet.map((item) => item.kind)).toEqual(['user', 'tool-group']);
    expect(quiet[1]).toMatchObject({ count: 2, expanded: false });

    const answered = foldTimeline(
      buildTimeline(
        [
          user('看看'),
          read('a'),
          result('a'),
          { role: 'assistant', content: [{ type: 'text', text: '登录修好了' }] },
        ],
        false
      ),
      false,
      new Set(),
      { foldToolOnlyTurns: true }
    );
    expect(answered.map((item) => item.kind)).toEqual(['user', 'tool', 'text']);
  });

  it('普通会话不把单张工具卡片折起来', () => {
    const rows = foldTimeline(
      buildTimeline([user('看看'), read('a'), result('a')], false),
      false,
      new Set()
    );
    expect(rows.map((item) => item.kind)).toEqual(['user', 'tool']);
  });

  it('系统回传调用 silence_turn 收成巡检行，用户消息不吞', () => {
    const schedule = '<secretary-schedule>\n- [schedule] 巡检\n</secretary-schedule>';
    const silent = foldTimeline(
      buildTimeline(
        [
          user(schedule),
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 's', name: 'silence_turn' }],
          },
          {
            role: 'toolResult',
            toolCallId: 's',
            toolName: 'silence_turn',
            content: [{ type: 'text', text: 'Silenced.' }],
          },
        ],
        false
      ),
      false,
      new Set()
    );
    expect(silent).toHaveLength(1);
    expect(silent[0]).toMatchObject({ kind: 'tool-group', notice: 'patrol', expanded: false });

    const spoken = foldTimeline(
      buildTimeline(
        [
          user('帮我看看'),
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 's', name: 'silence_turn' },
              { type: 'text', text: '还在跑' },
            ],
          },
        ],
        false
      ),
      false,
      new Set(),
      { foldToolOnlyTurns: true }
    );
    expect(spoken.map((item) => item.kind)).toEqual(['user', 'tool', 'text']);
    expect(spoken.some((item) => item.kind === 'tool-group' && item.notice)).toBe(false);
  });
});
