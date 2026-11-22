import { STATUS_LINE_PRESETS } from '@shared/statusLine';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyProjection } from '@/stores/sessions/reducer';
import { StatsLine } from './StatsLine';

const harness = vi.hoisted(() => ({
  mobile: false,
  segments: ['model', 'tokens', 'cache', 'context'] as string[],
}));
vi.mock('@/hooks/useViewport', () => ({ useIsMobile: () => harness.mobile }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (select: (state: object) => unknown) =>
    select({
      conversations: {
        fixture: {
          ...emptyProjection,
          id: 'fixture',
          projectId: '',
          title: '',
          started: true,
          spawning: false,
          createdAt: 1,
          lastProviderId: 'p',
          lastModelId: 'auto/deepseek-v4.1-flash-1017',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            {
              role: 'assistant',
              content: [],
              usage: { input: 440_000, output: 20_000, cacheRead: 21_560_000, cacheWrite: 0 },
            },
          ],
          occupancy: {
            buckets: {
              system: 6000,
              instructions: 0,
              skills: 0,
              tools: 0,
              conversation: 118_000,
              compaction: 0,
              projectMemory: 0,
              reminders: 0,
            },
            used: 124_000,
            estimated: false,
            compactedMessageCount: 0,
            compactionModelMismatch: false,
            contextWindow: 200_000,
          },
        },
      },
    }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) =>
    select({
      providers: [],
      virtualModels: [],
      projects: [],
      statusLineSegments: harness.segments,
    }),
}));
vi.mock('@/components/ui/popover', () => {
  const Wrap = ({ children, ...props }: { children?: ReactNode }) =>
    createElement('div', props, children);
  return { Popover: Wrap, PopoverPopup: () => null, PopoverTrigger: Wrap };
});
vi.mock('./ContextInspector', () => ({ ContextInspector: () => null }));
vi.mock('./StatusLineSettings', () => ({ StatusLineSettings: () => null }));

const MEASURE_LAYER =
  /<div aria-hidden="true"[\s\S]*?data-measure="more"[\s\S]*?<\/span><\/div><\/div>/;
/** 去掉隐藏测量层，只看真正显示的那一行 */
const render = () => {
  const html = renderToStaticMarkup(createElement(StatsLine, { conversationId: 'fixture' }));
  expect(html).toMatch(MEASURE_LAYER);
  return html.replace(MEASURE_LAYER, '');
};

describe('StatsLine 窄屏布局', () => {
  beforeEach(() => {
    harness.mobile = false;
    harness.segments = ['model', 'tokens', 'cache', 'context'];
  });

  it('手机逐段放置：首帧按全部放得下排布，不出多余的详情按钮', () => {
    harness.mobile = true;
    const html = render();
    expect(html).not.toContain('data-slot="status-line-details"');
    expect(html).toContain('↑22M ↓20K');
    expect(html).toContain('98%');
    expect(html).toContain('62%');
    // 用户自定义过段位且含模型段：按设置显示
    expect(html).toContain('auto/deepseek-v4.1-flash-1017');
  });

  it('手机默认段位不重复显示输入框工具栏里已有的模型名', () => {
    harness.mobile = true;
    harness.segments = [...STATUS_LINE_PRESETS.default];
    const html = render();
    expect(html).not.toContain('deepseek');
    expect(html).toContain('↑22M ↓20K');
    expect(html).toContain('62%');
  });

  it('桌面照旧逐段显示，没有详情按钮', () => {
    for (const segments of [harness.segments, [...STATUS_LINE_PRESETS.default]]) {
      harness.segments = segments;
      const html = render();
      expect(html).not.toContain('data-slot="status-line-details"');
      expect(html).toContain('auto/deepseek-v4.1-flash-1017');
      expect(html).toContain('↑22M ↓20K');
      expect(html).toContain('98%');
    }
  });
});
