import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyProjection } from '@/stores/sessions/reducer';
import { StatsLine } from './StatsLine';

const harness = vi.hoisted(() => ({ mobile: false }));
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
      statusLineSegments: ['model', 'tokens', 'cache', 'context'],
    }),
}));
vi.mock('@/components/ui/popover', () => {
  const Wrap = ({ children, ...props }: { children?: ReactNode }) =>
    createElement('div', props, children);
  return { Popover: Wrap, PopoverPopup: () => null, PopoverTrigger: Wrap };
});
vi.mock('./ContextInspector', () => ({ ContextInspector: () => null }));
vi.mock('./StatusLineSettings', () => ({ StatusLineSettings: () => null }));

const render = () => renderToStaticMarkup(createElement(StatsLine, { conversationId: 'fixture' }));

describe('StatsLine 窄屏布局', () => {
  beforeEach(() => {
    harness.mobile = false;
  });

  it('手机只留上下文百分比摘要，其余段不进状态栏', () => {
    harness.mobile = true;
    const html = render();
    expect(html).toContain('data-slot="status-line-details"');
    expect(html).toContain('62%');
    expect(html).not.toContain('deepseek');
    expect(html).not.toContain('↑22M');
    expect(html).not.toContain('98%');
    expect(html).not.toContain('data-measure');
  });

  it('桌面照旧逐段显示，没有详情按钮', () => {
    const html = render();
    expect(html).not.toContain('data-slot="status-line-details"');
    expect(html).toContain('auto/deepseek-v4.1-flash-1017');
    expect(html).toContain('↑22M ↓20K');
    expect(html).toContain('98%');
  });
});
