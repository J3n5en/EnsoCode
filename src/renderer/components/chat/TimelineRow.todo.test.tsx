import type { TodoItem } from '@shared/types/agent';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { isToolStepRow, TimelineRow } from './TimelineRow';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select({}),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));
vi.mock('./Markdown', () => ({ Markdown: () => null }));
vi.mock('./EditDiff', () => ({ EditDiff: () => null }));
vi.mock('./ReadFileView', () => ({ ReadFileView: () => null }));

const todo = (todos: TodoItem[]): TimelineItem =>
  ({
    kind: 'tool',
    key: 'todo-1',
    name: 'todo',
    summary: JSON.stringify({ todos }),
    output: todos.length === 0 ? 'Todo list cleared' : 'Todos',
    state: 'ok',
    edits: null,
    writeContent: null,
    todos,
    durationMs: 0,
    agentMeta: null,
  }) as TimelineItem;

const html = (item: TimelineItem) => renderToStaticMarkup(createElement(TimelineRow, { item }));

describe('todo 时间线行', () => {
  it('有条目时画清单卡片', () => {
    const markup = html(todo([{ content: '写测试', status: 'pending' }]));
    expect(markup).toContain('data-enso="todo"');
    expect(markup).toContain('0/1');
    expect(markup).toContain('写测试');
    expect(markup).not.toContain('data-enso="tool-row"');
  });

  it('清空后不再画 0/0 卡片，收成一行', () => {
    const markup = html(todo([]));
    expect(markup).toContain('data-enso="tool-row"');
    expect(markup).toContain('Todos');
    expect(markup).toContain('Todo list cleared');
    expect(markup).not.toContain('0/0');
    expect(markup).not.toContain('{"todos":[]}');
    expect(markup).not.toContain('data-enso="todo"');
  });

  it('空清单跟普通工具行贴紧，有条目的卡片不贴', () => {
    expect(isToolStepRow(todo([]))).toBe(true);
    expect(isToolStepRow(todo([{ content: '写测试', status: 'pending' }]))).toBe(false);
  });
});
