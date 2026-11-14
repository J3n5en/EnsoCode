import type { SecretaryBoard, SecretaryCard } from '@shared/types/secretary';
import { parseHTML } from 'linkedom';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  board: null as unknown as SecretaryBoard,
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
  (dom.window as unknown as Record<string, unknown>).electronAPI = {
    secretary: {
      dismissResult: async (conversationId: string) => {
        h.calls.push({ name: 'dismissResult', args: conversationId });
        return { ok: true };
      },
    },
    agent: { abort: async () => undefined },
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
