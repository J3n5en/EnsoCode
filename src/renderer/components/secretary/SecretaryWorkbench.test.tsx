import type { FeedEvent } from '@shared/secretary/feed';
import type { SecretaryBoard, SecretaryCard } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  board: null as unknown as SecretaryBoard,
  feed: [] as FeedEvent[],
  calls: [] as { name: string; args: unknown }[],
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params
        ? key.replace(/\{\{(\w+)\}\}/g, (_, token: string) => String(params[token] ?? ''))
        : `[${key}]`,
    locale: 'zh',
  }),
}));
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
    selector({ secretary: { board: h.board } }),
}));

const { SecretaryWorkbench } = await import('./SecretaryWorkbench');

const NOW = new Date(2024, 4, 15, 15, 0).getTime();

const sessionCard = (
  over: Partial<Extract<SecretaryCard, { kind: 'session' }>> = {}
): SecretaryCard => ({
  kind: 'session',
  conversationId: 'c1',
  projectId: 'p1',
  projectName: 'enso-code',
  title: '写 hello.txt',
  state: 'error',
  startedAt: NOW - 60_000,
  stateSince: NOW - 60_000,
  secretaryConversationId: 'sec',
  ...over,
});

const board = (needsYou: SecretaryCard[]): SecretaryBoard => ({
  needsYou,
  running: [],
  todos: [],
  done: [],
});

const feedEvent = (over: Partial<FeedEvent> = {}): FeedEvent => ({
  id: 'session:c1',
  at: NOW - 1000,
  tone: 'run',
  projectName: 'enso-code',
  title: '写 hello.txt',
  label: 'Started',
  conversationId: 'c1',
  running: true,
  ...over,
});

let root: Root;
let container: HTMLElement;

async function render(node: ReactElement) {
  await act(async () => {
    root.render(node);
  });
}

const dismissButton = () => container.querySelector('[data-enso="secretary-dismiss-result"]');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.calls = [];
  h.board = board([]);
  h.feed = [];
  (dom.window as unknown as Record<string, unknown>).electronAPI = {
    secretary: {
      dismissResult: async (conversationId: string) => {
        h.calls.push({ name: 'dismissResult', args: conversationId });
        return { ok: true };
      },
      feed: async () => ({ ok: true, events: h.feed, hasMore: false }),
      onStateChanged: () => () => {},
    },
    agent: {
      abort: async (conversationId: string) => {
        h.calls.push({ name: 'abort', args: conversationId });
      },
    },
  };
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SecretaryWorkbench 结果卡', () => {
  it('失败结果的卡给「知道了」，点了交给 Main 清掉', async () => {
    h.board = board([sessionCard({ result: 'failed' })]);
    await render(<SecretaryWorkbench name="小安" />);
    const button = dismissButton();
    expect(button?.textContent).toBe('[Got it]');
    act(() => {
      (button as unknown as HTMLElement).click();
    });
    expect(h.calls).toContainEqual({ name: 'dismissResult', args: 'c1' });
  });

  it('实时审批的卡不给「知道了」，清了也不会消失', async () => {
    h.board = board([sessionCard({ state: 'waiting', result: 'needs-user' })]);
    await render(<SecretaryWorkbench name="小安" />);
    expect(container.querySelector('[data-enso="secretary-needs-you"]')).not.toBeNull();
    expect(dismissButton()).toBeNull();
  });

  it('在跑的卡没有结果，不给「知道了」', async () => {
    h.board = board([sessionCard({ state: 'running' })]);
    await render(<SecretaryWorkbench name="小安" />);
    expect(dismissButton()).toBeNull();
  });
});

describe('SecretaryWorkbench 动态行：停止与跳转', () => {
  const feedRow = () =>
    container.querySelector('[data-enso="secretary-feed-event"]') as HTMLElement;
  const inRow = (selector: string) => feedRow().querySelector(selector) as HTMLElement | null;
  const layer = () => inRow('[data-slot="hover-actions"]');
  const openButton = () => inRow('[data-enso="secretary-feed-open"]');
  const stopButton = () => inRow('[data-enso="secretary-feed-stop"]');
  const expandButton = () => inRow('[data-enso="secretary-feed-expand"]');

  beforeEach(async () => {
    h.board = {
      needsYou: [],
      running: [sessionCard({ state: 'running' })],
      todos: [],
      done: [],
    };
    h.feed = [feedEvent()];
    await render(<SecretaryWorkbench name="小安" />);
    await act(async () => {});
  });

  it('跳转按钮只有一个，排在行尾且不在蒙版里：悬停时位置不变、盖不住', () => {
    const row = feedRow();
    const opens = row.querySelectorAll('[data-enso="secretary-feed-open"]');
    expect(opens).toHaveLength(1);
    expect(row.lastElementChild).toBe(opens[0]);
    expect(layer()?.contains(opens[0])).toBe(false);
    // 蒙版右侧让出跳转按钮的宽度并留出间距，停止不会落在跳转的位置上
    expect(layer()?.className).toContain('pr-7');
  });

  it('蒙版里只有停止，两个按钮都有 tooltip，停止悬停用危险色', () => {
    const stop = stopButton();
    expect(stop).not.toBeNull();
    expect(layer()?.contains(stop)).toBe(true);
    expect(stop?.getAttribute('title')).toBe('[Stop]');
    expect(stop?.className).toContain('hover:text-destructive');
    expect(openButton()?.getAttribute('title')).toBe('[Open session]');
  });

  it('点跳转只跳转：不停会话，也不展开这一行', async () => {
    act(() => openButton()?.click());
    await act(async () => {});
    expect(h.calls).toContainEqual({ name: 'selectConversation', args: 'c1' });
    expect(h.calls.some((call) => call.name === 'abort')).toBe(false);
    expect(expandButton()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('点停止只停止：不跳转，也不展开这一行', async () => {
    act(() => stopButton()?.click());
    await act(async () => {});
    expect(h.calls).toContainEqual({ name: 'abort', args: 'c1' });
    expect(h.calls.some((call) => call.name === 'selectConversation')).toBe(false);
    expect(expandButton()?.getAttribute('aria-expanded')).toBe('false');
  });
});
