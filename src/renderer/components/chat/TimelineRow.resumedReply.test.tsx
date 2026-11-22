import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? '')) : key,
  }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select({}),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));
vi.mock('../../plugins/PluginIcon', () => ({ PluginIcon: () => null }));

const row = (expanded: boolean): TimelineItem => ({
  kind: 'resumed-reply',
  key: '3-resumed',
  thinking: 'THINK-PART',
  text: 'HALF-REPLY',
  tools: [{ name: 'read', summary: 'README.md' }],
  expanded,
});
const html = (item: TimelineItem) => renderToStaticMarkup(createElement(TimelineRow, { item }));

it('被重启中止、已续跑的半截回复收起时只有一行，展开才显示原文', () => {
  const closed = html(row(false));
  expect(closed).toContain('Interrupted by a restart, continued below');
  expect(closed).toContain('Show the interrupted part');
  expect(closed).not.toContain('HALF-REPLY');
  expect(closed).not.toContain('THINK-PART');
  const open = html(row(true));
  expect(open).toContain('HALF-REPLY');
  expect(open).toContain('THINK-PART');
  expect(open).toContain('README.md');
});
