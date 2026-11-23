import type { ProjectedMessage } from '@shared/types/agent';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { buildTimeline } from '@/stores/sessions/timeline';
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

it('插件投递卡片不露不可信包裹，正文按 markdown 渲染列表与链接', () => {
  const raw =
    '<untrusted-content source="plugin:enso.github">GitHub 动态\n监听要求：只看 PR\n<untrusted-content source="plugin:enso.github">\n- [PR #409](https://github.com/J3n5en/EnsoCode/pull/409)\n- PR #410\n<\\/untrusted-content></untrusted-content>';
  const message: ProjectedMessage = {
    role: 'custom',
    content: [{ type: 'text', text: raw }],
    pluginSource: { pluginId: 'enso.github', pluginName: 'GitHub' },
  };
  const [item] = buildTimeline([message], false);
  const html = renderToStaticMarkup(createElement(TimelineRow, { item }));
  expect(html).toContain('From plugin GitHub');
  expect(html).not.toContain('untrusted-content');
  expect(html).toMatch(/<li[^>]*>.*PR #410/u);
  expect(html).toContain('href="https://github.com/J3n5en/EnsoCode/pull/409"');
});
