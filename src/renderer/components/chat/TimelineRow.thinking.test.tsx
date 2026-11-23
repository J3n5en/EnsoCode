import type { ProjectedMessage } from '@shared/types/agent';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyHistoryPage, emptyProjection } from '@/stores/sessions/reducer';
import { buildTimeline, type TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? '')) : key,
  }),
}));
// 默认值：流式推理自动展开开启
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: object) => unknown) => select({ expandLiveReasoning: true }),
}));
vi.mock('@/stores/sessions', () => ({ useSessionsStore: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
});

const BODY = '第一步先读配置';
const COLLAPSE = 'Collapse thinking';

const turn = (n: number): ProjectedMessage[] => [
  { role: 'user', content: [{ type: 'text', text: `问题 ${n}` }] },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', text: `${BODY} ${n}` },
      { type: 'text', text: `回答 ${n}` },
    ],
    stopReason: 'stop',
  },
];

const thinking = (streaming: boolean): TimelineItem => ({
  kind: 'thinking',
  key: '3-0',
  text: BODY,
  streaming,
  durationMs: 1200,
});

function mount() {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = dom.document.getElementById('root') as unknown as HTMLElement;
  const root = createRoot(container);
  const buttons = () => [...container.querySelectorAll('button')] as HTMLButtonElement[];
  return {
    container,
    render: (item: TimelineItem) =>
      act(async () => root.render(createElement(TimelineRow, { item }))),
    head: () => buttons()[0],
    collapse: () => buttons().find((button) => button.textContent?.includes(COLLAPSE)),
    unmount: () => act(async () => root.unmount()),
  };
}

describe('历史会话的思考块', () => {
  it('尾窗补水 + 上滑分页后，已完成的思考在任何 running 取值下都不是 streaming', () => {
    const tail = { ...emptyProjection, messages: turn(2), historyBaseIndex: 2 };
    const paged = applyHistoryPage(tail, { baseIndex: 0, messages: turn(1) });
    for (const projection of [tail, paged]) {
      for (const running of [false, true]) {
        const rows = buildTimeline(projection.messages, running, [], undefined, {
          historyBaseIndex: projection.historyBaseIndex,
        }).filter((item) => item.kind === 'thinking');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((item) => item.kind === 'thinking' && !item.streaming)).toBe(true);
      }
    }
  });

  it('首帧即收起：不渲染思考正文，也没有底部收起按钮', () => {
    const [item] = buildTimeline(turn(1), false).filter((row) => row.kind === 'thinking');
    const html = renderToStaticMarkup(createElement(TimelineRow, { item }));
    expect(html).toContain('data-enso="thinking"');
    expect(html).not.toContain(BODY);
    expect(html).not.toContain(COLLAPSE);
  });
});

describe('思考块底部收起入口', () => {
  it('点开后正文底部出现收起按钮，点它与顶部按钮同样收起', async () => {
    const view = mount();
    try {
      await view.render(thinking(false));
      expect(view.collapse()).toBeUndefined();
      await act(async () => view.head().click());
      expect(view.container.textContent).toContain(BODY);
      const bottom = view.collapse();
      expect(bottom).toBeDefined();
      await act(async () => bottom?.click());
      expect(view.container.textContent).not.toContain(BODY);
      expect(view.collapse()).toBeUndefined();
      // 同一份手动状态：顶部按钮仍能再次展开
      await act(async () => view.head().click());
      expect(view.container.textContent).toContain(BODY);
    } finally {
      await view.unmount();
    }
  });

  it('流式中自动展开时不显示底部收起按钮', async () => {
    const view = mount();
    try {
      await view.render(thinking(true));
      expect(view.container.textContent).toContain(BODY);
      expect(view.collapse()).toBeUndefined();
    } finally {
      await view.unmount();
    }
  });

  it('流式结束仍保持手动展开时，底部按钮随之出现', async () => {
    const view = mount();
    try {
      await view.render(thinking(true));
      // 流式中手动收起再展开 → userToggled=true
      await act(async () => view.head().click());
      await act(async () => view.head().click());
      expect(view.collapse()).toBeUndefined();
      await view.render(thinking(false));
      expect(view.container.textContent).toContain(BODY);
      expect(view.collapse()).toBeDefined();
    } finally {
      await view.unmount();
    }
  });
});
