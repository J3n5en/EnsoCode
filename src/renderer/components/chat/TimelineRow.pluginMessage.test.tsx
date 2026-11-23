import type { ProjectedMessage } from '@shared/types/agent';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
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

afterEach(() => {
  vi.unstubAllGlobals();
});

it('插件投递卡片不露不可信包裹，正文按 markdown 渲染列表与链接', async () => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = dom.document.getElementById('root') as unknown as HTMLElement;
  const raw =
    '<untrusted-content source="plugin:enso.github">GitHub 动态\n<untrusted-content source="plugin:enso.github">\n- [PR #409](https://github.com/J3n5en/EnsoCode/pull/409)\n- PR #410\n<\\/untrusted-content></untrusted-content>';
  const message: ProjectedMessage = {
    role: 'custom',
    content: [{ type: 'text', text: raw }],
    pluginSource: { pluginId: 'enso.github', pluginName: 'GitHub' },
  };
  const [item] = buildTimeline([message], false);
  const root = createRoot(container);
  await act(async () => root.render(createElement(TimelineRow, { item })));
  expect(container.textContent).toContain('From plugin GitHub');
  expect(container.innerHTML).not.toContain('untrusted-content');
  expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
    'PR #409',
    'PR #410',
  ]);
  expect(container.querySelector('a')?.getAttribute('href')).toBe(
    'https://github.com/J3n5en/EnsoCode/pull/409'
  );
  await act(async () => root.unmount());
});
