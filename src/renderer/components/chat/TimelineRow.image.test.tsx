import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { buildTimeline, foldTimeline, type TimelineItem } from '@/stores/sessions/timeline';
import { ReadImagePreview, TimelineRow } from './TimelineRow';

const settings = vi.hoisted(() => ({ compactReadOnlyTools: false, expandLiveEdits: false }));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select(settings),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));
vi.mock('./Markdown', () => ({ Markdown: () => null }));
vi.mock('./EditDiff', () => ({ EditDiff: () => null }));
vi.mock('./ReadFileView', () => ({ ReadFileView: () => null }));

describe('ReadImagePreview', () => {
  it.each(['ImageGen', 'codemode'])('%s 的生成图片默认可见且不被已完成过程折叠隐藏', (name) => {
    const images = ['/tmp/generated.png', 'C:\\scratch\\图 #1.webp'];
    const timeline = buildTimeline(
      [
        { role: 'assistant', content: [{ type: 'toolCall', id: 'gen', name, arguments: {} }] },
        {
          role: 'toolResult',
          toolCallId: 'gen',
          toolName: name,
          content: [{ type: 'text', text: 'result' }],
          generatedImages: images,
        },
      ],
      false
    );
    const item = timeline[0];
    expect(item).toMatchObject({ kind: 'tool', generatedImages: images });
    const folded = foldTimeline(
      [
        { kind: 'thinking', key: 'think', text: 'thinking', streaming: false, durationMs: null },
        item,
      ],
      false,
      new Set(),
      { collapseCompletedActivity: true }
    );
    expect(folded).toContain(item);
    const html = renderToStaticMarkup(createElement(TimelineRow, { item }));
    expect(html).toContain('src="local-image://posix/tmp/generated.png"');
    expect(html).toContain('src="local-image://c/scratch/');
    expect(html).not.toContain('data-slot="tool-details"');
  });

  it('按原文件渲染图片，并限制在卡片内的最大高度', () => {
    const html = renderToStaticMarkup(
      createElement(ReadImagePreview, {
        path: '/tmp/anim.svg',
        fallback: createElement('pre', null, 'code'),
      })
    );
    expect(html).toContain('data-slot="read-image"');
    expect(html).toContain('src="local-image://posix/tmp/anim.svg"');
    expect(html).toContain('max-h-80');
    expect(html).toContain('max-w-full');
    expect(html).toContain('object-contain');
    expect(html).not.toContain('code');
  });
});

const imageRead = (state: 'running' | 'ok'): Extract<TimelineItem, { kind: 'tool' }> => ({
  kind: 'tool',
  key: 'tool-img',
  name: 'read',
  summary: 'shot.png',
  output: 'Read image file [image/png]',
  state,
  edits: null,
  writeContent: null,
  todos: null,
  agentMeta: null,
  durationMs: null,
  imagePath: '/tmp/shot.png',
});

describe('运行中的图片 read', () => {
  it('开启「运行中自动展开文件改动」时展开预览，结束后和关闭开关时不展开', () => {
    settings.expandLiveEdits = true;
    const live = renderToStaticMarkup(createElement(TimelineRow, { item: imageRead('running') }));
    expect(live).toContain('data-slot="read-image"');

    const finished = renderToStaticMarkup(createElement(TimelineRow, { item: imageRead('ok') }));
    expect(finished).not.toContain('data-slot="read-image"');

    settings.expandLiveEdits = false;
    const held = renderToStaticMarkup(createElement(TimelineRow, { item: imageRead('running') }));
    expect(held).not.toContain('data-slot="read-image"');
  });
});
