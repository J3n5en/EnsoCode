import { translate } from '@shared/i18n';
import type { ProjectedMessage } from '@shared/types/agent';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyHistoryPage, emptyProjection } from '@/stores/sessions/reducer';
import { buildTimeline, type TimelineItem } from '@/stores/sessions/timeline';
import { quoteButtonPosition } from './quoteSelection';
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

const thinking = (
  streaming: boolean,
  text = BODY
): Extract<TimelineItem, { kind: 'thinking' }> => ({
  kind: 'thinking',
  key: '3-0',
  text,
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

  it('用户手动展开过的思考块，在流式更新期间不会被强行收起', async () => {
    const view = mount();
    try {
      await view.render(thinking(true));
      await act(async () => view.head().click());
      await act(async () => view.head().click());
      expect(view.container.textContent).toContain(BODY);
      await view.render(thinking(true, `${BODY}\n第二步继续推导`));
      expect(view.container.textContent).toContain('第二步继续推导');
      await view.render(thinking(false, `${BODY}\n第二步继续推导`));
      expect(view.container.textContent).toContain('第二步继续推导');
      expect(view.collapse()).toBeDefined();
    } finally {
      await view.unmount();
    }
  });

  it('顶部与底部收起按钮标记 data-quote-skip，避免被 #410 引用按钮遮挡或带入引用文本', async () => {
    const view = mount();
    try {
      await view.render(thinking(false));
      await act(async () => view.head().click());
      const head = view.head();
      const bottom = view.collapse();
      expect(head.hasAttribute('data-quote-skip')).toBe(true);
      expect(bottom?.hasAttribute('data-quote-skip')).toBe(true);
      expect(bottom?.className).toContain('select-none');

      // 窄屏（390px）移动端选区紧贴思考块底部：引用按钮优先放下方，
      // 底部收起按钮作为 obstacle 时应避让而不压在按钮上
      const selectionRect = { top: 200, bottom: 220, left: 40, right: 200 };
      const collapseObstacle = { top: 224, bottom: 248, left: 47, right: 160 };
      const pos = quoteButtonPosition(
        selectionRect,
        { width: 390, height: 844 },
        { width: 72, height: 28 },
        true,
        [collapseObstacle]
      );
      const overlaps =
        pos.left < collapseObstacle.right &&
        pos.left + 72 > collapseObstacle.left &&
        pos.top < collapseObstacle.bottom &&
        pos.top + 28 > collapseObstacle.top;
      expect(overlaps).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it('长思考块顶部滚出视口上方时，点底部收起会把滚动位置拉回思考行顶部附近；短思考块不乱滚', async () => {
    const dom = parseHTML(
      '<html><body><div id="scroller" data-virtuoso-scroller="true" style="overflow-y:auto"><div id="root"></div></div></body></html>'
    );
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const scroller = dom.document.getElementById('scroller') as unknown as HTMLElement;
    const container = dom.document.getElementById('root') as unknown as HTMLElement;
    scroller.scrollTop = 1500;
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      value: () => ({ top: 0, bottom: 600, left: 0, right: 390, width: 390, height: 600 }),
    });
    const root = createRoot(container);
    const buttons = () => [...container.querySelectorAll('button')] as HTMLButtonElement[];
    try {
      await act(async () => root.render(createElement(TimelineRow, { item: thinking(false) })));
      await act(async () => buttons()[0].click());
      const row = container.querySelector('[data-enso="thinking"]') as HTMLElement;
      // 模拟长思考块：用户滚到底部，行头已滚出视口上方 900px
      Object.defineProperty(row, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top: -900, bottom: -876, left: 16, right: 374, width: 358, height: 24 }),
      });
      const bottom = buttons().find((b) => b.textContent?.includes(COLLAPSE));
      await act(async () => bottom?.click());
      expect(scroller.scrollTop).toBe(584);

      // 短思考块：行头仍在视口内，点底部收起不动 scrollTop
      await act(async () => buttons()[0].click());
      scroller.scrollTop = 300;
      Object.defineProperty(row, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top: 120, bottom: 144, left: 16, right: 374, width: 358, height: 24 }),
      });
      const bottom2 = buttons().find((b) => b.textContent?.includes(COLLAPSE));
      await act(async () => bottom2?.click());
      expect(scroller.scrollTop).toBe(300);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('底部收起文案在中英文环境下均有对应文本', () => {
    expect(translate('en', 'Collapse thinking')).toBe('Collapse thinking');
    expect(translate('zh', 'Collapse thinking')).toBe('收起思考过程');
  });
});
