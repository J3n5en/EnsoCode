import { createElement, Fragment } from 'react';
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
      projects: [
        { id: 'p-sec', name: 'secretary', alias: '', path: '/tmp/sec', kind: 'secretary' },
        { id: 'p-plain', name: 'plain', alias: '', path: '/tmp/plain', kind: 'local' },
      ],
      compactReadOnlyTools: false,
      expandLiveEdits: false,
    }),
}));
/**
 * 全局「当前打开的会话」故意停在秘书会话上：工具行的判断只能看这条时间线自己的
 * 会话类型，不能跟着活动会话走（切标签的一瞬间两者会对不上）。
 */
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: object) => unknown) =>
    select({
      activeId: 'conv-sec',
      conversations: {
        'conv-sec': { projectId: 'p-sec' },
        'conv-plain': { projectId: 'p-plain' },
      },
      selectConversation: () => undefined,
    }),
}));
vi.mock('@/stores/secretary', () => ({
  focusedSecretaryId: () => undefined,
  useSecretaryStore: (select: (state: object) => unknown) =>
    select({ secretary: { board: { todos: [] }, proposals: {} }, resolving: {} }),
}));
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));

function tool(name: string): TimelineItem {
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
  } as TimelineItem;
}

const count = (markup: string, enso: string) =>
  markup.match(new RegExp(`data-enso="${enso}"`, 'g'))?.length ?? 0;

describe('工具行只看自己这条时间线的会话类型', () => {
  it('秘书会话和普通会话同时渲染，各自的工具行与卡片互不影响', () => {
    const name = 'mcp__fast_context__fast_context_search';
    const markup = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(TimelineRow, { key: 'sec', item: tool(name), secretarySession: true }),
        createElement(TimelineRow, { key: 'plain', item: tool(name), secretarySession: false })
      )
    );
    expect(count(markup, 'tool-card')).toBe(1);
    expect(count(markup, 'tool-row')).toBe(1);
  });

  it('活动会话停在别处时，秘书时间线仍画卡片、普通时间线仍画工具行', () => {
    const name = 'mcp__fast_context__fast_context_search';
    const secretary = renderToStaticMarkup(
      createElement(TimelineRow, { item: tool(name), secretarySession: true })
    );
    const plain = renderToStaticMarkup(
      createElement(TimelineRow, { item: tool(name), secretarySession: false })
    );
    expect(secretary).toContain('data-enso="tool-card"');
    expect(secretary).not.toContain('data-enso="tool-row"');
    expect(plain).toContain('data-enso="tool-row"');
    expect(plain).not.toContain('data-enso="tool-card"');
  });

  it('秘书会话里的 bash 也还是普通工具行', () => {
    const markup = renderToStaticMarkup(
      createElement(TimelineRow, { item: tool('bash'), secretarySession: true })
    );
    expect(markup).toContain('data-enso="tool-row"');
    expect(markup).not.toContain('data-enso="tool-card"');
  });
});
