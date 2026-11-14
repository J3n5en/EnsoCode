import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select({}),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));
vi.mock('./Markdown', () => ({ Markdown: () => null }));

const RAW_PROMPT = '<plan-mode>\nPlan mode is ON\n</plan-mode>\n\nfix the bug  ';

const user = (
  text: string,
  extra: Partial<Extract<TimelineItem, { kind: 'user' }>> = {}
): Extract<TimelineItem, { kind: 'user' }> => ({
  kind: 'user',
  key: '4',
  text,
  images: [],
  timestamp: 1_700_000_000_000,
  ...extra,
});

const html = (item: TimelineItem) => renderToStaticMarkup(createElement(TimelineRow, { item }));

const copyControl = (markup: string) =>
  markup.includes('data-enso="copy-user-prompt"') && markup.includes('title="Copy"');

describe('用户提示词复制', () => {
  it('有正文时在用户操作条提供悬停复制，按钮使用现有 Copy 文案', () => {
    const markup = html(user('ship the copy button'));
    expect(markup).toContain('data-enso="message-user"');
    expect(copyControl(markup)).toBe(true);
    expect(markup).toContain('group-hover/user:opacity-100');
    expect(markup).toContain('ship the copy button');
  });

  it('折叠后的提示词仍可复制', () => {
    const markup = html(user('still here', { collapsed: true, canCollapse: true }));
    expect(markup).toContain('Expand');
    expect(copyControl(markup)).toBe(true);
  });

  it('只有图片或空白正文时不渲染复制按钮', () => {
    const images = html(
      user('', {
        images: [{ data: 'aGk=', mimeType: 'image/png' }],
      })
    );
    expect(images).toContain('data-enso="message-user"');
    expect(images).toContain('data:image/png;base64,aGk=');
    expect(images).not.toContain('data-enso="copy-user-prompt"');
    expect(images).not.toContain('title="Copy"');

    const blank = html(user(' \n\t'));
    expect(blank).toContain('data-enso="message-user"');
    expect(blank).not.toContain('data-enso="copy-user-prompt"');
  });
});

describe('用户提示词复制写入剪贴板', () => {
  let root: Root | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    vi.unstubAllGlobals();
  });

  it('复制时间线上的原始提示词，而不是去掉前缀后的展示正文', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const dom = parseHTML('<html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = dom.document.getElementById('root');
    if (!container) throw new Error('Missing test root');
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(TimelineRow, { item: user(RAW_PROMPT) }));
    });

    const button = container.querySelector('[data-enso="copy-user-prompt"] button');
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(RAW_PROMPT);
  });
});
