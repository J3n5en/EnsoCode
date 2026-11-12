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
  kind: 'discarded-turn',
  key: 'discard-p',
  reason: 'chip news',
  pluginId: 'enso.tgclient',
  pluginName: 'Telegram',
  messages: ['NVIDIA-NEWS'],
  tools: [{ name: 'read', summary: 'README.md' }],
  expanded,
});
const html = (item: TimelineItem) => renderToStaticMarkup(createElement(TimelineRow, { item }));

it('丢弃的一轮收起时只有一行原因，展开才显示投递原文', () => {
  const closed = html(row(false));
  expect(closed).toContain('Turn discard');
  expect(closed).toContain('Telegram · chip news');
  expect(closed).not.toContain('NVIDIA-NEWS');
  expect(closed).not.toContain('README.md');
  const open = html(row(true));
  expect(open).toContain('NVIDIA-NEWS');
  expect(open).toContain('README.md');
});
