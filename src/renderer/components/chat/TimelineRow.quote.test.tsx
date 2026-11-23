import { formatQuoteBlock } from '@shared/quoteBlock';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { QuoteBlock, TimelineRow } from './TimelineRow';

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

describe('时间线引用块超高折叠', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function mount(contentHeight: number) {
    const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
    Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight,
    });
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = window.document.getElementById('root') as unknown as HTMLElement;
    const root = createRoot(host);
    await act(async () => root.render(createElement(QuoteBlock, { text: '很长的引用' })));
    const toggle = () => host.querySelector('[data-quote-toggle]') as HTMLElement | null;
    const body = () => host.querySelector('[data-quote-body]') as HTMLElement;
    return { toggle, body, unmount: () => act(async () => root.unmount()) };
  }

  it('超过限高：底部渐隐并给「展开」，点开显示全文，再点收起', async () => {
    const { toggle, body, unmount } = await mount(800);
    expect(toggle()?.textContent).toBe('Show more');
    expect(toggle()?.hasAttribute('data-quote-skip')).toBe(true);
    expect(body().hasAttribute('data-clipped')).toBe(true);
    expect(body().className).toContain('mask-b-from');
    await act(async () => toggle()?.click());
    expect(toggle()?.textContent).toBe('Show less');
    expect(body().hasAttribute('data-clipped')).toBe(false);
    expect(body().getAttribute('style') ?? '').not.toMatch(/max-height:\s*\d/);
    await act(async () => toggle()?.click());
    expect(toggle()?.textContent).toBe('Show more');
    expect(body().hasAttribute('data-clipped')).toBe(true);
    await unmount();
  });

  it('没超高：不显示展开入口，也不渐隐', async () => {
    const { toggle, body, unmount } = await mount(80);
    expect(toggle()).toBeNull();
    expect(body().hasAttribute('data-clipped')).toBe(false);
    await unmount();
  });

  it('引用块和下面的提问之间留出间距', () => {
    const html = renderToStaticMarkup(createElement(QuoteBlock, { text: 'x' }));
    expect(html).toContain('data-enso="quote-block"');
    expect(html).toMatch(/data-enso="quote-block"[^>]*class="[^"]*\bmb-/);
  });
});
