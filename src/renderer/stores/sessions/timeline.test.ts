import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { buildTimeline, foldTimeline, type TimelineItem } from './timeline';

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

  it('merges parent custom notifications by time without converting them into messages', () => {
    const messages: ProjectedMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'before' }],
        timestamp: 10,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'after' }],
        timestamp: 30,
      },
    ];
    const customEntries = [
      {
        kind: 'agent-dispatch' as const,
        child: {
          sessionId: 'parent::cw-child',
          generation: 'child-g1',
          instanceId: '123e4567-e89b-42d3-a456-426614174000',
          instanceName: 'Scout · a1',
          typeKey: 'builtin:scout' as const,
        },
        at: 20,
      },
    ];
    const timeline = buildTimeline(messages, false, customEntries);
    expect(timeline.map((item) => item.kind)).toEqual(['user', 'session-custom', 'text']);
    expect(messages).toHaveLength(2);
    expect(timeline[1]).toMatchObject({
      kind: 'session-custom',
      entry: { kind: 'agent-dispatch' },
    });
  });

  it('keeps the complete child capability receipt in a custom timeline row', () => {
    const receiptEntry = {
      kind: 'capability-receipt' as const,
      receipt: {
        receiptId: '123e4567-e89b-42d3-a456-426614174040',
        operationId: '123e4567-e89b-42d3-a456-426614174041',
        child: {
          sessionId: 'parent::cw-enso',
          generation: 'enso-g1',
          parent: { sessionId: 'parent', generation: 'parent-g1' },
          instanceId: '123e4567-e89b-42d3-a456-426614174042',
          instanceName: 'Enso · a1',
          typeKey: 'agent:enso' as const,
          profileId: 'enso-locked-v1' as const,
        },
        turnId: 'turn-1',
        requestId: '123e4567-e89b-42d3-a456-426614174043',
        capabilityId: 'appearance.theme' as const,
        risk: 'reversible' as const,
        subject: { kind: 'setting' as const, id: 'theme', label: 'Theme' },
        outcome: 'succeeded' as const,
        summary: 'Theme changed to dark',
        changes: [{ field: 'theme', previous: 'light', value: 'dark' }],
        occurredAt: 20,
        sequence: 1,
      },
    };
    const timeline = buildTimeline([], false, [receiptEntry]);
    expect(timeline).toMatchObject([
      {
        kind: 'session-custom',
        entry: {
          kind: 'capability-receipt',
          receipt: {
            outcome: 'succeeded',
            changes: [{ field: 'theme', previous: 'light', value: 'dark' }],
          },
        },
      },
    ]);
  });
});

const toolItem = (key: string, name = 'bash', edits: TimelineItem[] = []): TimelineItem =>
  ({
    kind: 'tool',
    key,
    name,
    summary: name,
    output: null,
    state: 'ok',
    edits: edits.length > 0 ? [{ oldText: 'a', newText: 'b' }] : null,
  }) as TimelineItem;

const userItem = (key: string): TimelineItem => ({ kind: 'user', key, text: 'q', images: [] });
const textItem = (key: string): TimelineItem => ({
  kind: 'text',
  key,
  text: 'a',
  streaming: false,
});
const thinkingItem = (key: string): TimelineItem => ({
  kind: 'thinking',
  key,
  text: 't',
  streaming: false,
  durationMs: null,
});

describe('foldTimeline', () => {
  it('连续 ≥3 条工具收拢为组头，thinking 收进组，统计归类', () => {
    const items = [
      userItem('u0'),
      toolItem('t1', 'bash'),
      thinkingItem('th'),
      toolItem('t2', 'read'),
      toolItem('t3', 'grep'),
      textItem('x'),
    ];
    const folded = foldTimeline(items, false, new Set());
    expect(folded.map((i) => i.kind)).toEqual(['user', 'tool-group', 'text']);
    const group = folded[1] as Extract<TimelineItem, { kind: 'tool-group' }>;
    expect(group.count).toBe(3);
    expect(group.stats).toEqual({ commands: 1, reads: 1, searches: 1, others: 0 });
  });

  it('不足 3 条工具不折叠', () => {
    const items = [toolItem('t1'), toolItem('t2'), textItem('x')];
    expect(foldTimeline(items, false, new Set()).map((i) => i.kind)).toEqual([
      'tool',
      'tool',
      'text',
    ]);
  });

  it('edit(diff)行不进组，平铺在组头之后', () => {
    const items = [
      toolItem('t1'),
      toolItem('e1', 'edit', [{} as TimelineItem]),
      toolItem('t2'),
      toolItem('t3'),
    ];
    const folded = foldTimeline(items, false, new Set());
    expect(folded.map((i) => i.kind)).toEqual(['tool-group', 'tool']);
    expect((folded[1] as Extract<TimelineItem, { kind: 'tool' }>).edits).not.toBeNull();
  });

  it('running 时最后一轮的段不折叠，历史段照折', () => {
    const items = [
      userItem('u0'),
      toolItem('a1'),
      toolItem('a2'),
      toolItem('a3'),
      textItem('x'),
      userItem('u1'),
      toolItem('b1'),
      toolItem('b2'),
      toolItem('b3'),
    ];
    const folded = foldTimeline(items, true, new Set());
    expect(folded.map((i) => i.kind)).toEqual([
      'user',
      'tool-group',
      'text',
      'user',
      'tool',
      'tool',
      'tool',
    ]);
    // 同样的数据 idle 后全部收拢
    expect(foldTimeline(items, false, new Set()).map((i) => i.kind)).toEqual([
      'user',
      'tool-group',
      'text',
      'user',
      'tool-group',
    ]);
  });

  it('展开的组按原始顺序平铺 children', () => {
    const items = [toolItem('t1'), thinkingItem('th'), toolItem('t2'), toolItem('t3')];
    const collapsed = foldTimeline(items, false, new Set());
    const groupKey = collapsed[0].key;
    const expanded = foldTimeline(items, false, new Set([groupKey]));
    expect(expanded.map((i) => i.key)).toEqual([groupKey, 't1', 'th', 't2', 't3']);
  });

  it('todo 行不进组，平铺在组头之后', () => {
    const items = [toolItem('t1'), toolItem('td', 'todo'), toolItem('t2'), toolItem('t3')];
    const folded = foldTimeline(items, false, new Set());
    expect(folded.map((i) => i.kind)).toEqual(['tool-group', 'tool']);
    expect((folded[1] as Extract<TimelineItem, { kind: 'tool' }>).name).toBe('todo');
  });
});

describe('streaming 判定(最后一个有内容的 part)', () => {
  it('thinking 是唯一有内容的 part 且 running 时,thinking 处于流式中', () => {
    const timeline = buildTimeline(
      [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: '思考内容...' },
            { type: 'text', text: '' },
          ],
        },
      ],
      true
    );
    expect(timeline).toMatchObject([{ kind: 'user' }, { kind: 'thinking', streaming: true }]);
  });

  it('thinking 后有非空 text 时,text 流式、thinking 已完结', () => {
    const timeline = buildTimeline(
      [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 't' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
      true
    );
    expect(timeline).toMatchObject([
      { kind: 'thinking', streaming: false },
      { kind: 'text', streaming: true },
    ]);
  });
});
