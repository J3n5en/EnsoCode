import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? '')) : key,
    locale: 'en',
  }),
}));
vi.mock('@/stores/settings', () => {
  const state = {
    autoCollapseTurns: false,
    projects: [],
    compactReadOnlyTools: false,
    expandLiveEdits: false,
  };
  const useSettingsStore = (select: (value: object) => unknown) => select(state);
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});
vi.mock('@/stores/sessions', () => {
  const state = { activeId: null, conversations: {}, selectConversation: () => undefined };
  const useSessionsStore = (select: (value: object) => unknown) => select(state);
  useSessionsStore.getState = () => state;
  return { useSessionsStore };
});
vi.mock('@/stores/secretary', () => {
  const state = { secretary: { board: { todos: [] }, proposals: {} }, resolving: {} };
  const useSecretaryStore = (select: (value: object) => unknown) => select(state);
  useSecretaryStore.getState = () => state;
  return { useSecretaryStore };
});
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));

const GOAL = [
  '<goal-continuation>',
  'Session goal: 修好登录跳转。然后补测试',
  'Continue working toward it. If it is genuinely done, call goal_complete with evidence;',
  '</goal-continuation>',
].join('\n');

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

async function mount(text: string) {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = dom.document.getElementById('root');
  if (!container) throw new Error('Missing test root');
  root = createRoot(container);
  const item = { kind: 'user', key: '0', text, images: [] } as TimelineItem;
  await act(async () => {
    root?.render(createElement(TimelineRow, { item }));
  });
  const card = () => container.querySelector('[data-enso="goal-continuation"]') as HTMLElement;
  const toggle = () => card().querySelector('button') as HTMLElement;
  const click = async () => {
    await act(async () => {
      toggle().click();
    });
  };
  return { container, card, toggle, click };
}

describe('目标续跑卡片', () => {
  it('用 goal 的图标和 goal 的框，不是孤立的圆点、也没有阴影', async () => {
    const ui = await mount(GOAL);
    const card = ui.card();
    const icons = card.querySelectorAll('svg');
    expect(icons).toHaveLength(1);
    expect(icons[0]?.getAttribute('class')).toContain('lucide-target');
    expect(card.className).toContain('bg-muted/20');
    expect(card.className).toContain('border-border/60');
    expect(card.className).not.toContain('shadow');
    expect(card.querySelector('svg.lucide-chevron-right')).toBeNull();
  });

  it('默认收成一行，只露目标首句', async () => {
    const ui = await mount(GOAL);
    expect(ui.card().getAttribute('data-open')).toBe('false');
    expect(ui.toggle().getAttribute('aria-expanded')).toBe('false');
    expect(ui.container.textContent).toContain('Continue goal: 修好登录跳转。');
    expect(ui.container.textContent).not.toContain('然后补测试');
    expect(ui.container.textContent).not.toContain('call goal_complete');
  });

  it('点主体展开完整目标与续跑指令，再点收起', async () => {
    const ui = await mount(GOAL);
    await ui.click();
    expect(ui.card().getAttribute('data-open')).toBe('true');
    expect(ui.toggle().getAttribute('aria-expanded')).toBe('true');
    expect(ui.container.textContent).toContain('修好登录跳转。然后补测试');
    expect(ui.container.textContent).toContain('call goal_complete');
    await ui.click();
    expect(ui.card().getAttribute('data-open')).toBe('false');
    expect(ui.container.textContent).not.toContain('然后补测试');
  });
});

describe('系统注入块统一视觉', () => {
  it('定时、子代理通知、后台任务都用同一个虚线框，且不再画右箭头', async () => {
    const ui = await mount(
      [
        '<secretary-schedule>',
        '- [schedule] 巡检：每天九点看一眼',
        '</secretary-schedule>',
        '<agent-notification>',
        'worker finished',
        'details here',
        '</agent-notification>',
        '<background-task-update>',
        'task done',
        'more output',
        '</background-task-update>',
      ].join('\n')
    );
    const schedule = ui.container.querySelector(
      '[data-enso="secretary-schedule-card"]'
    ) as HTMLElement;
    expect(schedule.className).toContain('border-dashed');
    expect(schedule.className).not.toContain('shadow');
    expect(ui.container.querySelectorAll('svg.lucide-chevron-right')).toHaveLength(0);
  });
});
