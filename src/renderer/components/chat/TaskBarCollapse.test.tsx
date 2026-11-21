import type { BackgroundTaskInfo } from '@shared/types/agent';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskBar } from './TaskBar';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name] ?? '')),
  }),
}));
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: { virtualModels: never[] }) => unknown) =>
    select({ virtualModels: [] }),
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: Object.assign(
    (select: (state: { pendingAgentOpen: null }) => unknown) => select({ pendingAgentOpen: null }),
    { setState: () => {}, getState: () => ({ pendingAgentOpen: null }) }
  ),
}));

const stopTask = vi.fn();
const NOW = 10_000_000;

const task = (id: string, extra: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo => ({
  taskId: id,
  command: `cmd-${id}`,
  status: 'running',
  tail: '',
  startedAt: NOW - 60_000,
  ...extra,
});

const three = [
  task('a', { startedAt: NOW - 80 * 60_000 - 21_000, keep: { by: 'agent', reason: 'r', at: 1 } }),
  task('b', { startedAt: NOW - 69 * 60_000 }),
  task('c', { idle: { since: NOW - 40 * 60_000, ports: [] } }),
];

let root: Root;
let container: HTMLElement;

const render = (sessionId: string, tasks: BackgroundTaskInfo[], readOnly?: boolean) =>
  act(async () =>
    root.render(createElement(TaskBar, { sessionId, tasks, subagents: [], readOnly }))
  );
const q = (selector: string) => container.querySelector(selector) as HTMLElement | null;
const rows = () => container.querySelectorAll('[data-enso="background-task-row"]');
const click = (el: Element | null | undefined) =>
  act(async () => {
    if (!el) throw new Error('missing element');
    (el as HTMLElement).click();
  });
const buttonByText = (text: string) =>
  [...container.querySelectorAll('button')].find((el) => el.textContent?.trim() === text);

beforeEach(() => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  stopTask.mockReset();
  Object.assign(window, { electronAPI: { agent: { stopTask, keepTask: vi.fn() } } });
  container = window.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TaskBar 多条后台任务折叠', () => {
  it('只有 1 条时不折叠，保持逐条行', async () => {
    await render('one', [task('a')]);
    expect(q('[data-enso="background-task-summary"]')).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it('2 条及以上默认折叠成一行摘要，显示条数、最久运行时长和疑似闲置数', async () => {
    await render('many', three);
    expect(rows()).toHaveLength(0);
    const summary = q('[data-enso="background-task-summary"]')?.textContent ?? '';
    expect(summary).toContain('3 background tasks');
    expect(summary).toContain('longest running 80m21s');
    expect(summary).toContain('1 suspected idle');
    expect(q('[data-enso="background-task-summary-toggle"]')?.getAttribute('aria-expanded')).toBe(
      'false'
    );
  });

  it('展开后逐条显示，单条停止不确认', async () => {
    await render('expand', three);
    await click(q('[data-enso="background-task-summary-toggle"]'));
    expect(rows()).toHaveLength(3);
    expect(container.textContent).toContain('Kept: r');
    const stop = rows()[1]?.querySelector('button[title="Stop task"]');
    await click(stop);
    expect(stopTask).toHaveBeenCalledTimes(1);
    expect(stopTask).toHaveBeenCalledWith('expand', 'b');
  });

  it('展开状态按会话记住，重新挂载不收回', async () => {
    await render('remember', three);
    await click(q('[data-enso="background-task-summary-toggle"]'));
    await act(async () => root.unmount());
    root = createRoot(container);
    await render('remember', three);
    expect(rows()).toHaveLength(3);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render('other', three);
    expect(rows()).toHaveLength(0);
  });

  it('全部停止先确认，取消不停，确认后停掉所有在跑的', async () => {
    await render('stop-all', three);
    await click(q('[data-enso="background-task-stop-all"]'));
    expect(stopTask).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Stop 3 background tasks?');
    await click(buttonByText('Cancel'));
    expect(stopTask).not.toHaveBeenCalled();
    expect(q('[data-enso="background-task-stop-all-confirm"]')).toBeNull();
    await click(q('[data-enso="background-task-stop-all"]'));
    await click(q('[data-enso="background-task-stop-all-confirm"]'));
    expect(stopTask.mock.calls).toEqual([
      ['stop-all', 'a'],
      ['stop-all', 'b'],
      ['stop-all', 'c'],
    ]);
  });

  it('只读配对不给全部停止', async () => {
    await render('readonly', three, true);
    expect(q('[data-enso="background-task-summary"]')).not.toBeNull();
    expect(q('[data-enso="background-task-stop-all"]')).toBeNull();
  });
});
