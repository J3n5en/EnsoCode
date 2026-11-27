import type { ProjectedMessage, TodoItem } from '@shared/types/agent';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const conversation: { messages: ProjectedMessage[]; toolTodos?: Record<string, TodoItem[]> } = {
  messages: [],
};

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select({ pinUnfinishedTodos: true }),
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: object) => unknown) =>
    select({ conversations: { c1: conversation } }),
}));

const { TodoBar } = await import('./TodoBar');

describe('TodoBar', () => {
  it('轮中 todo 已收口、toolResult 未落地（agy）时按收口清单固定显示', () => {
    conversation.messages = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        stopReason: 'pending',
        content: [{ type: 'toolCall', id: 'enso_t1', name: 'todo', arguments: {} }],
      },
    ];
    conversation.toolTodos = undefined;
    const render = () => renderToStaticMarkup(createElement(TodoBar, { conversationId: 'c1' }));
    expect(render()).toBe('');
    conversation.toolTodos = {
      enso_t1: [
        { content: 'write tests', status: 'in_progress' },
        { content: 'ship', status: 'pending' },
      ],
    };
    const markup = render();
    expect(markup).toContain('data-enso="todo"');
    expect(markup).toContain('write tests');
  });
});
