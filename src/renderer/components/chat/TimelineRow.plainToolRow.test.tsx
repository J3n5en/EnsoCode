import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) =>
    select({
      projects: [{ id: 'p1', name: 'proj', alias: '', path: '/tmp/p', kind: 'local' }],
      compactReadOnlyTools: false,
      expandLiveEdits: false,
    }),
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: object) => unknown) =>
    select({
      activeId: 'conv-1',
      conversations: { 'conv-1': { projectId: 'p1' } },
      selectConversation: () => undefined,
    }),
}));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (select: (state: object) => unknown) =>
    select({ secretary: { board: { todos: [] }, proposals: {} }, resolving: {} }),
}));
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));

function tool(name: string, over: Record<string, unknown> = {}): TimelineItem {
  return {
    kind: 'tool',
    key: `tool-${name}`,
    name,
    summary: name,
    output: null,
    state: 'ok',
    edits: null,
    writeContent: null,
    todos: null,
    durationMs: 0,
    agentMeta: null,
    ...over,
  } as TimelineItem;
}

describe('普通会话的工具行', () => {
  it('mcp 和 bash 都走原来的工具行，不画秘书可读卡片', () => {
    for (const name of ['mcp__fast_context__fast_context_search', 'bash']) {
      const markup = renderToStaticMarkup(createElement(TimelineRow, { item: tool(name) }));
      expect(markup, name).toContain('data-enso="tool-row"');
      expect(markup, name).not.toContain('data-enso="tool-card"');
    }
  });
});
