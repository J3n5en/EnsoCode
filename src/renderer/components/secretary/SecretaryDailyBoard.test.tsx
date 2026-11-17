import type {
  SecretaryDaily,
  SecretaryDailyGroup,
  SecretaryDailyItem,
} from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translate = (key: string, params?: Record<string, string | number>) =>
  params
    ? key.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(params[token] ?? ''))
    : `[${key}]`;

const h = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  stateListeners: [] as (() => void)[],
  daily: {} as Record<string, SecretaryDaily>,
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: translate, locale: 'zh' }) }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      conversations: {},
      selectConversation: (id: string) => h.calls.push({ name: 'selectConversation', args: id }),
    }),
}));

const { SecretaryDailyBoard } = await import('./SecretaryDailyBoard');

const NOW = new Date(2024, 4, 15, 15, 0).getTime();
const TODAY = '2024-05-15';
const YESTERDAY = '2024-05-14';

const item = (over: Partial<SecretaryDailyItem> = {}): SecretaryDailyItem => ({
  id: 'session:c1',
  at: new Date(2024, 4, 15, 12, 30).getTime(),
  dispatchedAt: new Date(2024, 4, 15, 12, 0).getTime(),
  title: '重构登录流程',
  projectName: 'enso-code',
  label: 'Goal complete',
  summary: '登录流程拆成三步',
  detail: '登录流程拆成三步\nbranch: feat/login\ncommit: a1b2c3d4',
  branch: 'feat/login',
  commit: 'a1b2c3d4',
  conversationId: 'c1',
  ...over,
});

const daily = (over: Partial<SecretaryDaily> = {}): SecretaryDaily => ({
  day: TODAY,
  today: true,
  counts: {
    dispatched: 2,
    completed: 1,
    failed: 0,
    needsYou: 1,
    todosDone: 3,
    merged: 1,
  },
  groups: [{ key: 'done', items: [item()] }],
  retentionDays: 180,
  ...over,
});

let root: Root;
let container: HTMLElement;

async function render(node: ReactElement) {
  await act(async () => {
    root.render(node);
  });
  await flush();
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function click(selector: string) {
  const node = container.querySelector(selector);
  expect(node, selector).not.toBeNull();
  act(() => {
    (node as unknown as HTMLElement).click();
  });
}

function text(selector: string): string {
  return container.querySelector(selector)?.textContent ?? '';
}

function dailyCalls(): string[] {
  return h.calls.filter((call) => call.name === 'daily').map((call) => String(call.args));
}

/** 列：data-group → 列头计数与卡片数 */
function columns(): { group: string; count: string; cards: number }[] {
  return [...container.querySelectorAll('[data-enso="secretary-daily-column"]')].map((node) => ({
    group: node.getAttribute('data-group') ?? '',
    count: node.querySelector('[data-enso="secretary-daily-count"]')?.textContent ?? '',
    cards: node.querySelectorAll('[data-enso="secretary-daily-card"]').length,
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.calls = [];
  h.stateListeners = [];
  h.daily = { [TODAY]: daily(), [YESTERDAY]: daily({ day: YESTERDAY, today: false }) };
  const api = {
    secretary: {
      daily: async (day?: string) => {
        h.calls.push({ name: 'daily', args: day });
        return { ok: true, daily: h.daily[day ?? TODAY] ?? daily({ groups: [] }) };
      },
      onStateChanged: (listener: () => void) => {
        h.stateListeners.push(listener);
        return () => {
          h.stateListeners = h.stateListeners.filter((entry) => entry !== listener);
        };
      },
      markResult: async (conversationId: string, action: string) => {
        h.calls.push({ name: 'markResult', args: [conversationId, action] });
        return { ok: true };
      },
      stopTasks: async (conversationId: string) => {
        h.calls.push({ name: 'stopTasks', args: conversationId });
        return { ok: true, stopped: ['t1'] };
      },
    },
  };
  (dom.window as unknown as Record<string, unknown>).electronAPI = api;
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SecretaryDailyBoard', () => {
  it('默认打开今天，列按状态排，列头计数与卡片数一致', async () => {
    h.daily[TODAY] = daily({
      groups: [
        { key: 'running', items: [item({ id: 'r1', conversationId: 'c3' })] },
        { key: 'needsYou', items: [item({ id: 'n1', conversationId: 'c4' })] },
        { key: 'failed', items: [item({ id: 'f1', conversationId: 'c5' })] },
        {
          key: 'done',
          items: [item({ id: 'x1' }), item({ id: 'x2', conversationId: 'c6' })],
        },
        { key: 'todos', items: [item({ id: 't1', conversationId: undefined })] },
        { key: 'changes', items: [item({ id: 'g1', conversationId: undefined })] },
      ],
    });
    await render(createElement(SecretaryDailyBoard));
    expect(dailyCalls()).toEqual([TODAY]);
    expect(
      (container.querySelector('[data-enso="secretary-daily-date"]') as HTMLInputElement).value
    ).toBe(TODAY);
    expect(columns()).toEqual([
      { group: 'running', count: '1', cards: 1 },
      { group: 'stopped', count: '0', cards: 0 },
      { group: 'needsYou', count: '1', cards: 1 },
      { group: 'done', count: '2', cards: 2 },
      { group: 'failed', count: '1', cards: 1 },
      { group: 'todos', count: '1', cards: 1 },
      { group: 'changes', count: '1', cards: 1 },
    ]);
    // 没有「新派出」列：一张卡只在一列，派出数量进顶部统计
    expect(columns().map((column) => column.group)).not.toContain('dispatched');
    expect(text('[data-enso="secretary-daily-stat"]')).toBe('[Dispatched] 2 · 2/7');
  });

  it('空列照 kanban 显示图标和「暂无卡片」，不是整块隐藏', async () => {
    h.daily[TODAY] = daily({ groups: [] });
    await render(createElement(SecretaryDailyBoard));
    expect(columns().every((column) => column.count === '0' && column.cards === 0)).toBe(true);
    expect(container.querySelectorAll('[data-enso="secretary-daily-empty-column"]')).toHaveLength(
      7
    );
    expect(text('[data-enso="secretary-daily-empty-column"]')).toBe('[No cards yet]');
    expect(text('[data-enso="secretary-daily-stat"]')).toBe('[Dispatched] 2 · 0/0');
  });

  it('卡片上显示派出与完成时间', async () => {
    await render(createElement(SecretaryDailyBoard));
    expect(text('[data-enso="secretary-daily-times"]')).toBe(
      '[Dispatched] 12:00 · [Completed] 12:30'
    );
  });

  it('没有派出时间的卡片只显示状态时间', async () => {
    h.daily[TODAY] = daily({
      groups: [{ key: 'todos', items: [item({ dispatchedAt: undefined, label: 'Added' })] }],
    });
    await render(createElement(SecretaryDailyBoard));
    expect(text('[data-enso="secretary-daily-times"]')).toBe('12:30');
  });

  it('合并后的待办卡同时显示新增与完成时间，已完成的划掉', async () => {
    h.daily[TODAY] = daily({
      groups: [
        {
          key: 'todos',
          items: [
            item({
              id: 'todo:t1',
              conversationId: undefined,
              title: '看板脏数据',
              label: 'Done',
              at: new Date(2024, 4, 15, 13, 48).getTime(),
              dispatchedAt: undefined,
              summary: undefined,
              detail: undefined,
              addedAt: new Date(2024, 4, 15, 8, 35).getTime(),
              doneAt: new Date(2024, 4, 15, 13, 48).getTime(),
            }),
          ],
        },
      ],
    });
    await render(createElement(SecretaryDailyBoard));
    expect(text('[data-enso="secretary-daily-times"]')).toBe('[Added] 08:35 · [Done] 13:48');
    expect(text('[data-group="todos"] [data-enso="secretary-daily-card"]')).toContain('[Done]');
    expect(
      container.querySelector('[data-enso="secretary-daily-card"]')?.getAttribute('data-done')
    ).toBe('true');
  });

  it('只新增的待办卡只显示新增时间，不划掉', async () => {
    h.daily[TODAY] = daily({
      groups: [
        {
          key: 'todos',
          items: [
            item({
              id: 'todo:t2',
              conversationId: undefined,
              title: '写周报',
              label: 'Added',
              at: new Date(2024, 4, 15, 8, 35).getTime(),
              dispatchedAt: undefined,
              summary: undefined,
              detail: undefined,
              addedAt: new Date(2024, 4, 15, 8, 35).getTime(),
            }),
          ],
        },
      ],
    });
    await render(createElement(SecretaryDailyBoard));
    expect(text('[data-enso="secretary-daily-times"]')).toBe('[Added] 08:35');
    expect(
      container.querySelector('[data-enso="secretary-daily-card"]')?.getAttribute('data-done')
    ).toBeNull();
  });

  it('点卡片展开全文，点会话徽标才跳转', async () => {
    await render(createElement(SecretaryDailyBoard));
    const expand = () => container.querySelector('[data-enso="secretary-daily-expand"]');
    expect(expand()?.getAttribute('aria-expanded')).toBe('false');
    click('[data-enso="secretary-daily-expand"]');
    expect(expand()?.getAttribute('aria-expanded')).toBe('true');
    expect(text('[data-enso="secretary-daily-card"]')).toContain('branch: feat/login');
    expect(h.calls).not.toContainEqual({ name: 'selectConversation', args: 'c1' });
    click('[data-enso="secretary-daily-open"]');
    expect(h.calls).toContainEqual({ name: 'selectConversation', args: 'c1' });
  });

  it('分支与提交号有就显示成徽标，没有就不留空位', async () => {
    await render(createElement(SecretaryDailyBoard));
    expect(text('[data-enso="secretary-daily-branch"]')).toBe('feat/login');
    expect(text('[data-enso="secretary-daily-commit"]')).toBe('a1b2c3d4');
    h.daily[TODAY] = daily({
      groups: [
        {
          key: 'done',
          items: [item({ branch: undefined, commit: undefined, detail: '只改了样式' })],
        },
      ],
    });
    await act(async () => {
      for (const listener of h.stateListeners) listener();
    });
    await flush();
    expect(container.querySelector('[data-enso="secretary-daily-branch"]')).toBeNull();
    expect(container.querySelector('[data-enso="secretary-daily-commit"]')).toBeNull();
  });

  it('没有会话的卡片不显示跳转徽标', async () => {
    h.daily[TODAY] = daily({
      groups: [{ key: 'todos', items: [item({ conversationId: undefined, label: 'Added' })] }],
    });
    await render(createElement(SecretaryDailyBoard));
    expect(container.querySelector('[data-enso="secretary-daily-open"]')).toBeNull();
  });

  it('列头可以折叠，再点展开', async () => {
    await render(createElement(SecretaryDailyBoard));
    const fold = () =>
      container.querySelector('[data-group="done"] [data-enso="secretary-daily-fold"]');
    expect(fold()?.getAttribute('aria-expanded')).toBe('true');
    click('[data-group="done"] [data-enso="secretary-daily-fold"]');
    expect(fold()?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-enso="secretary-daily-card"]')).toBeNull();
    click('[data-group="done"] [data-enso="secretary-daily-fold"]');
    expect(container.querySelector('[data-enso="secretary-daily-card"]')).not.toBeNull();
  });

  it('选中的是今天时跟着状态推送自动刷新', async () => {
    await render(createElement(SecretaryDailyBoard));
    expect(dailyCalls()).toEqual([TODAY]);
    await act(async () => {
      for (const listener of h.stateListeners) listener();
    });
    await flush();
    expect(dailyCalls()).toEqual([TODAY, TODAY]);
  });

  it('看历史日期不自动刷新，点箭头换日期才重读', async () => {
    await render(createElement(SecretaryDailyBoard));
    click('[data-enso="secretary-daily-prev"]');
    await flush();
    expect(dailyCalls()).toEqual([TODAY, YESTERDAY]);
    await act(async () => {
      for (const listener of h.stateListeners) listener();
    });
    await flush();
    expect(dailyCalls()).toEqual([TODAY, YESTERDAY]);
    click('[data-enso="secretary-daily-today"]');
    await flush();
    expect(dailyCalls()).toEqual([TODAY, YESTERDAY, TODAY]);
  });

  it('进行中的卡片可以就地标记完成，手动标过的在完成列可以撤销', async () => {
    h.daily[TODAY] = daily({
      groups: [
        { key: 'running', items: [item({ id: 'r1', conversationId: 'c3', tracked: true })] },
        {
          key: 'done',
          items: [item({ id: 'd1', conversationId: 'c4', tracked: true, manual: true })],
        },
      ],
    });
    await render(createElement(SecretaryDailyBoard));
    click('[data-group="running"] [data-enso="secretary-daily-mark-done"]');
    expect(h.calls).toContainEqual({ name: 'markResult', args: ['c3', 'done'] });
    click('[data-group="done"] [data-enso="secretary-daily-mark-undo"]');
    expect(h.calls).toContainEqual({ name: 'markResult', args: ['c4', 'undo'] });
  });

  it('普通会话的卡片没有标记完成，也没法撤销', async () => {
    h.daily[TODAY] = daily({
      groups: [
        { key: 'running', items: [item({ id: 'r1', conversationId: 'c5' })] },
        { key: 'done', items: [item({ id: 'd1', conversationId: 'c6' })] },
      ],
    });
    await render(createElement(SecretaryDailyBoard));
    expect(container.querySelector('[data-enso="secretary-daily-mark-done"]')).toBeNull();
    expect(container.querySelector('[data-enso="secretary-daily-mark-undo"]')).toBeNull();
  });

  it('已停止的卡片始终显示标记完成与移出，不需要悬停', async () => {
    h.daily[TODAY] = daily({
      groups: [
        { key: 'stopped', items: [item({ id: 's1', conversationId: 'c7', tracked: true })] },
      ],
    });
    await render(createElement(SecretaryDailyBoard));
    const card = container.querySelector(
      '[data-group="stopped"] [data-enso="secretary-daily-card"]'
    );
    expect(card?.querySelector('[data-enso="secretary-daily-actions"]')).not.toBeNull();
    click('[data-group="stopped"] [data-enso="secretary-daily-mark-done"]');
    expect(h.calls).toContainEqual({ name: 'markResult', args: ['c7', 'done'] });
    click('[data-group="stopped"] [data-enso="secretary-daily-dismiss"]');
    expect(h.calls).toContainEqual({ name: 'markResult', args: ['c7', 'dismiss'] });
  });

  it('组为空时列还在，只是没有卡片', async () => {
    const groups: SecretaryDailyGroup[] = [{ key: 'failed', items: [item({ label: 'Failed' })] }];
    h.daily[TODAY] = daily({ groups });
    await render(createElement(SecretaryDailyBoard));
    expect(columns()).toHaveLength(7);
    expect(columns().find((column) => column.group === 'failed')?.cards).toBe(1);
    expect(columns().find((column) => column.group === 'done')?.cards).toBe(0);
  });
});

describe('遗留任务', () => {
  it('完成卡标出遗留任务数，行内按钮停掉它们', async () => {
    h.daily[TODAY] = daily({
      groups: [
        {
          key: 'done',
          items: [item({ tracked: true, leftover: { count: 2 } })],
        },
      ],
    });
    await render(createElement(SecretaryDailyBoard));
    expect(text('[data-enso="secretary-daily-leftover"]')).toContain('2');
    click('[data-enso="secretary-daily-stop-leftover"]');
    await flush();
    expect(h.calls).toContainEqual({ name: 'stopTasks', args: 'c1' });
  });

  it('进行中卡标出常驻服务', async () => {
    h.daily[TODAY] = daily({
      groups: [{ key: 'running', items: [item({ label: undefined, persistent: true })] }],
    });
    await render(createElement(SecretaryDailyBoard));
    expect(text('[data-enso="secretary-daily-persistent"]')).toContain('Service running');
  });
});
