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
  id: 'result:c1:goal-complete:1',
  at: new Date(2024, 4, 15, 12, 30).getTime(),
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
  it('默认打开今天，顶部一行数字', async () => {
    await render(createElement(SecretaryDailyBoard));
    expect(dailyCalls()).toEqual([TODAY]);
    expect(
      (container.querySelector('[data-enso="secretary-daily-date"]') as HTMLInputElement).value
    ).toBe(TODAY);
    const counts = [...container.querySelectorAll('[data-enso="secretary-daily-count"]')];
    expect(counts.map((node) => node.getAttribute('data-key'))).toEqual([
      'dispatched',
      'completed',
      'failed',
      'needsYou',
      'todosDone',
      'merged',
    ]);
    expect(counts.map((node) => node.textContent)).toEqual([
      '2[Dispatched]',
      '1[Completed]',
      '0[Failed]',
      '1[Needed you]',
      '3[To-dos done]',
      '1[Merged]',
    ]);
  });

  it('当天没有事件就一行「这天没有动静」', async () => {
    h.daily[TODAY] = daily({
      groups: [],
      counts: {
        dispatched: 0,
        completed: 0,
        failed: 0,
        needsYou: 0,
        todosDone: 0,
        merged: 0,
      },
    });
    await render(createElement(SecretaryDailyBoard));
    expect(text('[data-enso="secretary-daily-empty"]')).toBe('[Nothing happened this day]');
    expect(container.querySelector('[data-enso="secretary-daily-group"]')).toBeNull();
  });

  it('每组收起只露三条，展开看全部', async () => {
    const items = Array.from({ length: 5 }, (_, index) =>
      item({ id: `row${index}`, title: `任务 ${index}`, conversationId: `c${index}` })
    );
    h.daily[TODAY] = daily({ groups: [{ key: 'done', items }] });
    await render(createElement(SecretaryDailyBoard));
    expect(container.querySelectorAll('[data-enso="secretary-daily-item"]')).toHaveLength(3);
    expect(text('[data-enso="secretary-daily-more"]')).toBe('Show all 5');
    click('[data-enso="secretary-daily-more"]');
    expect(container.querySelectorAll('[data-enso="secretary-daily-item"]')).toHaveLength(5);
    expect(text('[data-enso="secretary-daily-more"]')).toBe('[Collapse]');
  });

  it('点行主体展开详情，右侧图标才打开会话', async () => {
    await render(createElement(SecretaryDailyBoard));
    const expand = () => container.querySelector('[data-enso="secretary-daily-expand"]');
    expect(expand()?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-enso="secretary-daily-refs"]')).toBeNull();
    click('[data-enso="secretary-daily-expand"]');
    expect(expand()?.getAttribute('aria-expanded')).toBe('true');
    expect(text('[data-enso="secretary-daily-refs"]')).toContain('feat/login');
    expect(text('[data-enso="secretary-daily-refs"]')).toContain('a1b2c3d4');
    expect(h.calls).not.toContainEqual({ name: 'selectConversation', args: 'c1' });
    click('[data-enso="secretary-daily-open"]');
    expect(h.calls).toContainEqual({ name: 'selectConversation', args: 'c1' });
  });

  it('汇报里认不出提交号就不显示，也不留空位', async () => {
    h.daily[TODAY] = daily({
      groups: [
        {
          key: 'done',
          items: [
            item({
              detail: '只改了样式',
              summary: '只改了样式',
              branch: undefined,
              commit: undefined,
            }),
          ],
        },
      ],
    });
    await render(createElement(SecretaryDailyBoard));
    click('[data-enso="secretary-daily-expand"]');
    expect(container.querySelector('[data-enso="secretary-daily-refs"]')).toBeNull();
    expect(text('[data-enso="secretary-daily-item"]')).not.toContain('a1b2c3d4');
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

  it('组为空就不显示整组', async () => {
    const groups: SecretaryDailyGroup[] = [{ key: 'failed', items: [item({ label: 'Failed' })] }];
    h.daily[TODAY] = daily({ groups });
    await render(createElement(SecretaryDailyBoard));
    const rendered = [...container.querySelectorAll('[data-enso="secretary-daily-group"]')];
    expect(rendered.map((node) => node.getAttribute('data-group'))).toEqual(['failed']);
  });
});
