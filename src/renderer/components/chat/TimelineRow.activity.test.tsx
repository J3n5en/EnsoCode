import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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
vi.mock('./Markdown', () => ({ Markdown: () => null }));
vi.mock('./EditDiff', () => ({ EditDiff: () => null }));
vi.mock('./ReadFileView', () => ({ ReadFileView: () => null }));

const group = (live?: boolean): TimelineItem =>
  ({
    kind: 'tool-group',
    key: 'group-a',
    expanded: false,
    count: 2,
    stats: { commands: 1, reads: 1, searches: 0, others: 0 },
    exploring: false,
    ...(live ? { live: true } : {}),
    activity: { thinking: 1, workedMs: 100_000 },
    summary: 'checked auth',
    children: [],
  }) as TimelineItem;

const html = (item: TimelineItem) => renderToStaticMarkup(createElement(TimelineRow, { item }));

describe('进行中的已工作行', () => {
  it('这一轮还在跑时标题和摘要一起呼吸，结束后静止', () => {
    const live = html(group(true));
    expect(live).toContain('animate-pulse');
    expect(live).toContain('Worked for 1m40s');
    expect(live).toContain('checked auth');
    expect(html(group())).not.toContain('animate-pulse');
  });
});

const tool = (state: 'running' | 'ok'): TimelineItem =>
  ({
    kind: 'tool',
    key: 'bash-1',
    name: 'bash',
    summary: 'pnpm test',
    output: null,
    state,
    edits: null,
    writeContent: null,
    todos: null,
    durationMs: state === 'ok' ? 1200 : null,
    agentMeta: null,
  }) as TimelineItem;

describe('进行中的状态统一用呼吸', () => {
  it('探索中的组头呼吸，不再流光', () => {
    const exploring = html({
      ...(group() as Extract<TimelineItem, { kind: 'tool-group' }>),
      activity: undefined,
      summary: undefined,
      exploring: true,
    });
    expect(exploring).toContain('animate-pulse');
    expect(exploring).not.toContain('t-shimmer');
  });

  it('运行中的工具调用呼吸，结束后静止', () => {
    expect(html(tool('running'))).toContain('animate-pulse');
    expect(html(tool('ok'))).not.toContain('animate-pulse');
  });

  it('思考中呼吸，不再流光', () => {
    const thinking = html({
      kind: 'thinking',
      key: 't1',
      text: '',
      streaming: true,
      durationMs: null,
    } as TimelineItem);
    expect(thinking).toContain('Thinking…');
    expect(thinking).not.toContain('t-shimmer');
  });
});
