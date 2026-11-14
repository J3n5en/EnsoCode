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
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));

const user = (text: string): TimelineItem => ({ kind: 'user', key: 'u', text, images: [] });
const html = (item: TimelineItem) => renderToStaticMarkup(createElement(TimelineRow, { item }));

it('秘书收到的回传渲染成通知卡片，标签与不可信包裹都不露出', () => {
  const out = html(
    user(
      '<session-updates>\n- [goal-complete session:c1] app · 修登录 · 目标完成\n' +
        '<untrusted-content source="session:c1">登录已修好</untrusted-content>\n' +
        '- [proposal] 提案已执行\n</session-updates>'
    )
  );
  expect(out).toContain('app · 修登录 · 目标完成');
  expect(out).toContain('提案已执行');
  expect(out).not.toContain('session-updates');
  expect(out).not.toContain('untrusted-content');
  expect(out).not.toContain('登录已修好');
});

it('普通用户消息仍是气泡原文', () => {
  expect(html(user('帮我看看进展'))).toContain('帮我看看进展');
});
