import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';
import { ImageViewResult, ToolImagePreview } from './ToolImagePreview';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) =>
    select({ projects: [], compactReadOnlyTools: false, expandLiveEdits: true }),
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: object) => unknown) =>
    select({ conversations: {}, selectConversation: () => undefined }),
}));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (select: (state: object) => unknown) =>
    select({ secretary: { board: { todos: [] }, proposals: {} }, resolving: {} }),
}));
vi.mock('./Markdown', () => ({ Markdown: () => null }));

const image = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };
const output = JSON.stringify({
  path: '/tmp/shot.png',
  size: 2048,
  width: 1280,
  height: 720,
  mimeType: 'image/png',
});

describe('image_view 详情', () => {
  it('用结果里的图片字节出缩略图，下方列路径、像素尺寸和大小', () => {
    const html = renderToStaticMarkup(createElement(ImageViewResult, { image, output }));
    expect(html).toContain(`src="data:image/png;base64,${image.data}"`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('max-h-64');
    expect(html).toContain('object-contain');
    expect(html).toContain('/tmp/shot.png');
    expect(html).toContain('1280 × 720');
    expect(html).toContain('2 KB');
  });

  it('结果里没有图片字节时按工具回报的路径走 local-image 通道', () => {
    const html = renderToStaticMarkup(createElement(ImageViewResult, { output }));
    expect(html).toContain('src="local-image://posix/tmp/shot.png"');
  });

  it('既没有图片也没有路径时显示文字，不出破图', () => {
    const html = renderToStaticMarkup(createElement(ToolImagePreview, { path: null, alt: 'x' }));
    expect(html).toContain('Image unavailable');
    expect(html).not.toContain('<img');
  });
});

function imageViewItem(state: 'ok' | 'error', withImage: boolean): TimelineItem {
  return {
    kind: 'tool',
    key: `iv-${state}`,
    name: 'image_view',
    summary: '/tmp/shot.png',
    output: state === 'ok' ? output : 'path is out of scope',
    state,
    edits: null,
    writeContent: null,
    todos: null,
    durationMs: 1,
    agentMeta: null,
    ...(withImage ? { image } : {}),
  } as TimelineItem;
}

describe('折叠时不解码图片', () => {
  it.each([false, true])('secretarySession=%s：收起的行里没有图片数据', (secretarySession) => {
    const html = renderToStaticMarkup(
      createElement(TimelineRow, { item: imageViewItem('ok', true), secretarySession })
    );
    expect(html).not.toContain(image.data);
    expect(html).not.toContain('<img');
    expect(html).toContain(secretarySession ? 'data-enso="tool-card"' : 'data-enso="tool-row"');
  });

  it('失败行只显示工具返回的错误文字', () => {
    const html = renderToStaticMarkup(
      createElement(TimelineRow, { item: imageViewItem('error', false) })
    );
    expect(html).toContain('data-enso="tool-row"');
    expect(html).toContain('path is out of scope');
    expect(html).not.toContain('<img');
  });
});
