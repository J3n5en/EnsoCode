import { formatQuoteBlock } from '@shared/quoteBlock';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(vars?.[name])),
  }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select({}),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));
vi.mock('./Markdown', () => ({ Markdown: () => null, LocalFileTrigger: () => null }));
vi.mock('./EditDiff', () => ({ EditDiff: () => null }));
vi.mock('./ReadFileView', () => ({ ReadFileView: () => null }));

const render = (text: string) => {
  const item: TimelineItem = { kind: 'user', key: '0', images: [], text };
  return renderToStaticMarkup(createElement(TimelineRow, { item }));
};

const NO_TAG = /&lt;\/?quote|<\/?quote[\s>]/;

describe('时间线引用块渲染', () => {
  it('引用块渲染成带边框的引用样式，不露原始标签', () => {
    const html = render(`${formatQuoteBlock({ text: 'a < b 的那段' })}\n为什么？`);
    expect(html).toContain('data-enso="quote-block"');
    expect(html).toContain('border-l-2');
    expect(html).toContain('a &lt; b 的那段');
    expect(html).toContain('为什么？');
    expect(html).not.toMatch(NO_TAG);
  });

  it('引用里的代码围栏渲染为代码块，不露 ``` 也不露标签', () => {
    const html = render(formatQuoteBlock({ text: 'see:\n```ts\nconst a = 1;\n```' }));
    expect(html).toContain('data-quote-code');
    expect(html).toContain('const a = 1;');
    expect(html).not.toContain('```');
    expect(html).not.toMatch(NO_TAG);
  });

  it('截断的引用带「原文 N 行」标注', () => {
    const html = render(formatQuoteBlock({ text: 'x', originalLines: 321 }));
    expect(html).toContain('data-quote-truncated');
    expect(html).toContain('321');
    expect(html).not.toMatch(NO_TAG);
  });

  it('slash 命令消息里的引用同样不露标签', () => {
    const html = render(`/review ${formatQuoteBlock({ text: '片段' })}`);
    expect(html).not.toMatch(NO_TAG);
    expect(html).toContain('片段');
  });
});
