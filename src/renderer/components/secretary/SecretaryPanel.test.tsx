import type { SecretaryBoard, SecretaryCard, SecretaryProposal } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translate = (key: string, params?: Record<string, string | number>) =>
  params
    ? key.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(params[token] ?? ''))
    : `[${key}]`;

const h = vi.hoisted(() => ({
  board: null as unknown as SecretaryBoard,
  calls: [] as { name: string; args: unknown }[],
  schedules: [] as Record<string, unknown>[],
  stateListeners: [] as (() => void)[],
  // 稳定引用：真实 store 只在推送时换对象，每次渲染新建会让订阅它的 effect 反复触发
  secretary: {} as Record<string, unknown>,
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: translate, locale: 'zh' }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: { projects: unknown[] }) => unknown) =>
    selector({ projects: [] }),
}));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      conversations: {},
      selectConversation: (id: string) => h.calls.push({ name: 'selectConversation', args: id }),
    }),
}));
vi.mock('@/stores/secretary', () => ({
  useSecretaryStore: (selector: (state: unknown) => unknown) =>
    selector({ secretary: h.secretary, resolving: {}, resolveProposal: () => undefined }),
}));

const { SecretaryPanel } = await import('./SecretaryPanel');

const NOW = new Date(2024, 4, 15, 15, 0).getTime();

const sessionCard = (
  conversationId: string,
  over: Partial<Extract<SecretaryCard, { kind: 'session' }>> = {}
): SecretaryCard => ({
  kind: 'session',
  conversationId,
  projectId: 'p1',
  projectName: 'enso-code',
  title: `任务 ${conversationId}`,
  state: 'running',
  startedAt: NOW - 60_000,
  updatedAt: NOW - 60_000,
  secretaryConversationId: 'sec',
  ...over,
});

const proposalCard: SecretaryCard = {
  kind: 'proposal',
  projectName: 'enso-code',
  proposal: {
    id: 'pr1',
    secretaryConversationId: 'sec',
    createdAt: NOW - 30_000,
    updatedAt: NOW - 30_000,
    status: 'pending',
    kind: 'dispatch',
    draft: { projectId: 'p1', prompt: '重构登录流程', worktree: false },
  } as SecretaryProposal,
};

const board = (over: Partial<SecretaryBoard> = {}): SecretaryBoard => ({
  needsYou: [],
  running: [],
  todos: [],
  done: [],
  ...over,
});

let root: Root;
let container: HTMLElement;

async function render(node: ReactElement) {
  await act(async () => {
    root.render(node);
  });
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.calls = [];
  h.stateListeners = [];
  h.schedules = [
    {
      id: 's1',
      name: '每日晨报',
      prompt: '简报',
      cron: '0 9 * * *',
      nextRunAt: NOW + 3_600_000,
      system: 'daily-brief' as const,
    },
    {
      id: 's2',
      name: '每周五汇总',
      prompt: '汇总',
      cron: '0 18 * * 5',
      nextRunAt: NOW + 86_400_000,
    },
  ];
  h.board = board();
  h.secretary = {
    enabled: true,
    projectId: 'sec',
    profile: {
      version: 1,
      name: '小安',
      avatar: { color: '#8b7bff' },
      autonomy: 'ask-first',
      autoApproveProjectIds: [],
      visibleProjectIds: 'all',
      dispatchModel: { mode: 'project' },
      dispatchWorktree: 'auto',
      maxRunningDispatches: 3,
      replyLanguage: 'ui',
      style: 'concise',
      notify: 'needs-user',
      updatedAt: 1,
    },
    persona: '',
    board: h.board,
    proposals: { pr1: proposalCard.proposal },
  };
  const api = {
    secretary: {
      listSchedules: async () => ({ ok: true, schedules: structuredClone(h.schedules) }),
      onStateChanged: (listener: () => void) => {
        h.stateListeners.push(listener);
        return () => {
          h.stateListeners = h.stateListeners.filter((entry) => entry !== listener);
        };
      },
      removeSchedule: async (id: string) => {
        h.calls.push({ name: 'removeSchedule', args: id });
        return { ok: true };
      },
      mutateTodo: async (request: unknown) => {
        h.calls.push({ name: 'mutateTodo', args: request });
        return { ok: true, todoId: 't1' };
      },
    },
    memory: {
      list: async () => ({ items: [] }),
      onChanged: () => () => {},
      detail: async () => null,
      update: async () => ({ ok: true }),
      archive: async () => ({ ok: true }),
      delete: async () => ({ ok: true }),
    },
    agent: {
      abort: async (id: string) => {
        h.calls.push({ name: 'abort', args: id });
      },
      respondApproval: async () => ({ ok: true }),
      respondAsk: async () => ({ ok: true }),
    },
    window: { openSettings: async () => ({ ok: true }) },
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

describe('SecretaryPanel', () => {
  it('顶部显示名字与一行摘要，并留设置入口', async () => {
    h.board = h.secretary.board = board({
      needsYou: [proposalCard],
      running: [sessionCard('c1')],
    });
    await render(<SecretaryPanel />);
    await flush();
    expect(text('[data-enso="secretary-panel"]')).toContain('小安');
    expect(text('[data-enso="secretary-summary"]')).toBe('1 waiting · 1 running');
    expect(container.querySelector('[data-enso="secretary-panel-settings"]')).not.toBeNull();
  });

  it('工作台默认打开：问候、今日战报、三个计数与等你卡', async () => {
    h.board = h.secretary.board = board({
      needsYou: [proposalCard],
      running: [sessionCard('c1')],
      todos: [{ id: 't1', text: '写周报', createdAt: NOW, updatedAt: NOW }],
      done: [sessionCard('c2', { state: 'idle', result: 'goal-complete' })],
    });
    await render(<SecretaryPanel />);
    await flush();
    const workbench = container.querySelector('[data-enso="secretary-workbench"]');
    expect(workbench?.textContent).toContain('[Good afternoon]');
    expect(workbench?.textContent).toContain('Today 2 dispatched, 1 completed, 0 failed');
    const stats = [...container.querySelectorAll('[data-enso="secretary-stat"]')];
    expect(stats.map((node) => node.textContent)).toEqual([
      '1[Waiting on you]',
      '1[In progress]',
      '1[To do]',
    ]);
    expect(stats[0].getAttribute('data-warn')).toBe('true');
    expect(container.querySelector('[data-enso="secretary-needs-you"]')?.textContent).toContain(
      '重构登录流程'
    );
    expect(container.querySelector('[data-enso="secretary-needs-you"]')?.textContent).toContain(
      '[Confirm dispatch]'
    );
  });

  it('全空时给空状态与记一条待办入口', async () => {
    await render(<SecretaryPanel />);
    await flush();
    const empty = container.querySelector('[data-enso="secretary-empty"]');
    expect(empty?.textContent).toContain('[Nothing on your plate]');
    expect(empty?.textContent).toContain('Ask 小安 for work in the chat, or note a to-do first');
    click('[data-enso="secretary-empty"] button');
    expect(container.querySelector('[data-enso="secretary-empty"]')).toBeNull();
    expect(container.querySelector('input')).not.toBeNull();
  });

  it('动态列出在跑的会话，hover 的停止按钮真的中止会话', async () => {
    h.board = h.secretary.board = board({ running: [sessionCard('c1', { title: '跑全量测试' })] });
    await render(<SecretaryPanel />);
    await flush();
    const feed = container.querySelector('[data-enso="secretary-feed"]');
    expect(feed?.textContent).toContain('跑全量测试');
    expect(feed?.textContent).toContain('[Started]');
    click('[data-enso="secretary-feed-event"] button[aria-label="[Stop]"]');
    await flush();
    expect(h.calls).toContainEqual({ name: 'abort', args: 'c1' });
  });

  it('点圆形勾选框把待办标记完成', async () => {
    h.board = h.secretary.board = board({
      todos: [{ id: 't1', text: '写周报', createdAt: NOW, updatedAt: NOW }],
    });
    await render(<SecretaryPanel />);
    await flush();
    click('[data-enso="secretary-todo-done"]');
    expect(h.calls).toContainEqual({
      name: 'mutateTodo',
      args: { action: 'update', todoId: 't1', done: true },
    });
  });

  it('标签切到记忆与定时，定时分系统与秘书定的两组', async () => {
    await render(<SecretaryPanel />);
    await flush();
    click('[data-enso="secretary-panel-tab"][data-tab="memory"]');
    expect(container.querySelector('[data-enso="secretary-memory"]')).not.toBeNull();
    expect(container.querySelector('[data-enso="secretary-workbench"]')).toBeNull();
    click('[data-enso="secretary-panel-tab"][data-tab="schedules"]');
    await flush();
    const schedules = container.querySelector('[data-enso="secretary-schedules"]');
    expect(schedules?.textContent).toContain('[System]');
    expect(schedules?.textContent).toContain('每日晨报');
    expect(schedules?.textContent).toContain('每周五汇总');
    expect(schedules?.textContent).toContain('To add a schedule, just tell 小安');
    const rows = [...container.querySelectorAll('[data-enso="secretary-schedule"]')];
    expect(rows.map((row) => row.getAttribute('data-system'))).toEqual(['true', null]);
  });

  it('Main 推送后定时标签自动重读，新增与运行时间都不用手动刷新', async () => {
    h.schedules = [];
    await render(<SecretaryPanel />);
    await flush();
    click('[data-enso="secretary-panel-tab"][data-tab="schedules"]');
    expect(container.querySelectorAll('[data-enso="secretary-schedule"]')).toHaveLength(0);

    h.schedules = [
      { id: 's3', name: '巡检', prompt: '看看', cron: '*/10 * * * *', nextRunAt: NOW + 600_000 },
    ];
    act(() => {
      for (const listener of h.stateListeners) listener();
    });
    await flush();
    expect(text('[data-enso="secretary-schedules"]')).toContain('巡检');

    h.schedules = [
      {
        id: 's3',
        name: '巡检',
        prompt: '看看',
        cron: '*/10 * * * *',
        lastFiredAt: NOW,
        nextRunAt: NOW + 600_000,
      },
    ];
    act(() => {
      for (const listener of h.stateListeners) listener();
    });
    await flush();
    expect(text('[data-enso="secretary-schedule"]')).toContain('Last run');
  });
});
