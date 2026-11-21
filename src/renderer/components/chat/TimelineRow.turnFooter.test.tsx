import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars?.[name] ?? ''),
  }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select({}),
}));
const sessions = { activeId: 's1', conversations: { s1: { id: 's1' } } };
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: object) => unknown) => select(sessions),
}));
vi.mock('./Markdown', () => ({ Markdown: () => null }));

const item: Extract<TimelineItem, { kind: 'text' }> = {
  kind: 'text',
  key: '3-0',
  text: 'hello',
  streaming: false,
  turnEnd: true,
  turnDurationMs: 306_000,
  perf: { runMs: 4_200, turnMs: 306_000, ttftMs: 1_800, tps: 134 },
};

describe('回合结束操作条的用时', () => {
  it('用时与 末步耗时 · TTFT · tok/s 都是纯文本，没有展开入口', () => {
    const html = renderToStaticMarkup(createElement(TimelineRow, { item }));
    expect(html).toContain('<span>took 5m6s</span>');
    expect(html).toContain('<span>· 4.2s · TTFT 1.8s · 134 tok/s</span>');
    expect(html).not.toContain('aria-expanded');
  });
});
