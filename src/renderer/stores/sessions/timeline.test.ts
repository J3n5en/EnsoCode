import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { buildTimeline } from './timeline';

const user = (text: string): ProjectedMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

describe('buildTimeline', () => {
  it('toolResult 折进对应 toolCall 条目，不单独成行', () => {
    const timeline = buildTimeline(
      [
        user('改代码'),
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 't1',
          toolName: 'read',
          isError: false,
          content: [{ type: 'text', text: 'file body' }],
        },
      ],
      false
    );
    expect(timeline).toHaveLength(2);
    expect(timeline[1]).toMatchObject({
      kind: 'tool',
      name: 'read',
      summary: 'a.ts',
      output: 'file body',
      state: 'ok',
    });
  });

  it('无结果的 toolCall 在会话 running 时标为 running', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'pnpm test' } },
          ],
        },
      ],
      true
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', state: 'running', summary: 'pnpm test' });
  });

  it('失败的 toolResult 标为 error', () => {
    const timeline = buildTimeline(
      [
        { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'edit' }] },
        {
          role: 'toolResult',
          toolCallId: 't1',
          isError: true,
          content: [{ type: 'text', text: 'no match' }],
        },
      ],
      false
    );
    expect(timeline[0]).toMatchObject({ kind: 'tool', state: 'error', output: 'no match' });
  });

  it('text 与 thinking 各自成块，最后一块在 running 时标 streaming', () => {
    const timeline = buildTimeline(
      [
        user('hi'),
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: '想一想' },
            { type: 'text', text: '回答' },
          ],
        },
      ],
      true
    );
    expect(timeline).toMatchObject([
      { kind: 'user' },
      { kind: 'thinking', streaming: false },
      { kind: 'text', streaming: true },
    ]);
  });

  it('空内容的 part 不产出条目', () => {
    const timeline = buildTimeline(
      [{ role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'unknown' }] }],
      false
    );
    expect(timeline).toHaveLength(0);
  });
});
