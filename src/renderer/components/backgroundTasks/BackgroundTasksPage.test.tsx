import type { BackgroundTaskInfo } from '@shared/types/agent';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translate = (key: string, params?: Record<string, string | number>) =>
  params ? key.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(params[token] ?? '')) : key;

const h = vi.hoisted(() => ({
  stops: [] as [string, string][],
  conversations: {} as Record<string, unknown>,
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: translate, locale: 'zh' }) }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ conversations: h.conversations, selectConversation: () => {} }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ projects: [] }),
}));
vi.mock('@/stores/backgroundTasksView', () => ({
  useBackgroundTasksView: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ open: true, idleOnly: false }),
    { setState: () => {} }
  ),
}));
vi.mock('@/components/ui/checkbox', async () => {
  const { createElement: el } = await import('react');
  return {
    Checkbox: ({
      checked,
      onCheckedChange,
      'aria-label': label,
    }: {
      checked?: boolean;
      onCheckedChange?: (value: boolean) => void;
      'aria-label'?: string;
    }) =>
      el('button', {
        type: 'button',
        'data-checkbox': label,
        'data-checked': checked ? 'true' : 'false',
        onClick: () => onCheckedChange?.(!checked),
      }),
  };
});

const { BackgroundTasksPage } = await import('./BackgroundTasksPage');

const task = (taskId: string, command: string, over: Partial<BackgroundTaskInfo> = {}) =>
  ({
    taskId,
    command,
    status: 'running',
    tail: '',
    startedAt: Date.now() - 60_000,
    ...over,
  }) as BackgroundTaskInfo;

let root: Root;
let container: HTMLElement;

function click(node: Element | null | undefined) {
  expect(node).toBeTruthy();
  act(() => {
    (node as HTMLElement).click();
  });
}

const query = (selector: string) => container.querySelector(selector);
const rowCheckboxes = () => [
  ...container.querySelectorAll('[data-enso="background-tasks-row"] [data-checkbox]'),
];

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.stops = [];
  h.conversations = {
    c1: {
      title: '重构登录页',
      generation: 'g1',
      lastActiveAt: 2,
      backgroundTasks: [
        task('t1', 'pnpm dev', { idle: { since: Date.now() - 40 * 60_000, ports: [5173] } }),
        task('t2', 'iproxy 2222 22', { keep: { by: 'agent', reason: 'SSH 在用', at: Date.now() } }),
      ],
    },
    c2: {
      title: '修复 CI 缓存',
      lastActiveAt: 1,
      backgroundTasks: [task('t3', 'python -m http.server')],
    },
  };
  (dom.window as unknown as Record<string, unknown>).electronAPI = {
    agent: {
      stopTask: async (sessionId: string, taskId: string) => {
        h.stops.push([sessionId, taskId]);
        return { ok: true };
      },
      keepTask: async () => ({ ok: true }),
    },
  };
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
  act(() => root.render(createElement(BackgroundTasksPage)));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('BackgroundTasksPage 批量停止', () => {
  it('勾选后先弹确认，列出任务与所属会话；确认前不停，取消也不停', () => {
    const [first, , third] = rowCheckboxes();
    click(first);
    click(third);
    click(query('[data-enso="background-tasks-stop-selected"]'));
    const confirm = query('[data-enso="background-tasks-confirm"]');
    expect(confirm?.textContent).toContain('Stop 2 background tasks?');
    expect(confirm?.textContent).toContain('pnpm dev');
    expect(confirm?.textContent).toContain('修复 CI 缓存 (not open)');
    expect(h.stops).toEqual([]);
    click([...(confirm?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Cancel'));
    expect(query('[data-enso="background-tasks-confirm"]')).toBeNull();
    expect(h.stops).toEqual([]);
  });

  it('确认后逐个停止所选（含未打开会话），清空勾选', () => {
    const groupBox = query('[data-enso="background-tasks-group"] [data-checkbox]');
    click(groupBox);
    click(rowCheckboxes()[2]);
    click(query('[data-enso="background-tasks-stop-selected"]'));
    click(query('[data-enso="background-tasks-confirm-stop"]'));
    expect(h.stops).toEqual([
      ['c1', 't1'],
      ['c1', 't2'],
      ['c2', 't3'],
    ]);
    expect(query('[data-enso="background-tasks-stop-selected"]')).toBeNull();
  });

  it('单个停止不经过确认', () => {
    const row = container.querySelectorAll('[data-enso="background-tasks-row"]')[2];
    click([...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Stop'));
    expect(h.stops).toEqual([['c2', 't3']]);
    expect(query('[data-enso="background-tasks-confirm"]')).toBeNull();
  });
});
