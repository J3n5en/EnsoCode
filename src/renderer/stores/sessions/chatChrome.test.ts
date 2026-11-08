import { describe, expect, it } from 'vitest';
import { selectChatChrome, selectEmptyChatState } from './chatChrome';
import type { Conversation } from './index';

const conv = (id: string, extra: Partial<Conversation> = {}): Conversation =>
  ({
    id,
    projectId: 'p',
    title: 't',
    status: 'running',
    spawning: false,
    started: true,
    createdAt: 1,
    messages: [],
    customEntries: [],
    commands: [],
    lastSeq: 0,
    dispatchMainEvents: {},
    activeMs: 0,
    pendingApprovals: [],
    pendingAsks: [],
    backgroundTasks: [],
    subagents: [],
    toolOutputs: {},
    ...extra,
  }) as Conversation;

describe('selectChatChrome', () => {
  it('只改 messages / lastSeq 时切片字段引用不变', () => {
    const parent = conv('parent', {
      messages: [{ role: 'assistant', content: [{ type: 'thinking', text: 'a' }] }],
      lastSeq: 1,
    });
    const first = selectChatChrome({
      activeId: 'parent',
      conversations: { parent },
    });
    const second = selectChatChrome({
      activeId: 'parent',
      conversations: {
        parent: {
          ...parent,
          messages: [{ role: 'assistant', content: [{ type: 'thinking', text: 'ab' }] }],
          lastSeq: 2,
          lastOutputAt: 99,
        },
      },
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const keys = Object.keys(first!) as (keyof NonNullable<typeof first>)[];
    for (const key of keys) {
      expect(second![key]).toBe(first![key]);
    }
  });

  it('水合完成前不把空 chrome 当成未选择会话，水合完成后才显示空会话提示', () => {
    const parent = conv('parent');
    const chrome = selectChatChrome({ activeId: 'parent', conversations: { parent } });
    expect(selectEmptyChatState(null, false)).toBe('hydrating');
    expect(selectEmptyChatState(null, true)).toBe('empty');
    expect(selectEmptyChatState(chrome, false)).toBeNull();
    expect(selectEmptyChatState(chrome, true)).toBeNull();
  });
});
