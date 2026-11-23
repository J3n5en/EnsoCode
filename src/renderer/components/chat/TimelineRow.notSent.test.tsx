import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { TimelineRow } from './TimelineRow';

const store = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  resendMessage: vi.fn(),
  restart: vi.fn(async () => undefined),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
}));
vi.mock('@/stores/settings', () => {
  const state = { autoCollapseTurns: false, projects: [], compactReadOnlyTools: false };
  const useSettingsStore = (select: (value: object) => unknown) => select(state);
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});
vi.mock('@/stores/sessions', () => {
  const useSessionsStore = (select: (value: object) => unknown) => select(store.state);
  useSessionsStore.getState = () => store.state;
  useSessionsStore.setState = vi.fn();
  return { useSessionsStore };
});
vi.mock('@/stores/secretary', () => {
  const state = { secretary: { board: { todos: [] }, proposals: {} }, resolving: {} };
  const useSecretaryStore = (select: (value: object) => unknown) => select(state);
  useSecretaryStore.getState = () => state;
  return { useSecretaryStore };
});
vi.mock('@/components/chat/reloadConversationAction', () => ({
  reloadConversationFromMenu: vi.fn(),
  restartConversationFromMenu: store.restart,
}));
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  store.resendMessage.mockClear();
  store.restart.mockClear();
  vi.unstubAllGlobals();
});

async function mount(deliveryState: 'pending' | 'rejected' | 'stuck') {
  store.state = {
    activeId: 'c1',
    conversations: {
      c1: {
        id: 'c1',
        status: 'idle',
        backgroundTasks: [],
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'hi' }],
            optimistic: true,
            deliveryId: 'd1',
            ...(deliveryState === 'pending' ? {} : { deliveryRejected: true }),
          },
        ],
      },
    },
    resendMessage: store.resendMessage,
  };
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = dom.document.getElementById('root');
  if (!container) throw new Error('Missing test root');
  root = createRoot(container);
  const item = { kind: 'user', key: '0', text: 'hi', images: [], deliveryState } as TimelineItem;
  await act(async () => {
    root?.render(createElement(TimelineRow, { item }));
  });
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((node) => node.textContent === label);
  const click = async (element: Element | undefined) => {
    await act(async () => {
      (element as HTMLElement).click();
    });
  };
  return { container, button, click };
}

describe('未发送的消息', () => {
  it('拒收的气泡标「Not sent」，一键重发', async () => {
    const ui = await mount('rejected');
    expect(ui.container.textContent).toContain('Not sent');
    await ui.click(ui.button('Resend'));
    expect(store.resendMessage).toHaveBeenCalledWith('c1', 'd1');
    expect(ui.button('Restart conversation')).toBeUndefined();
  });

  it('上一轮卡住导致没发出：提示先重启会话，并给出重启入口', async () => {
    const ui = await mount('stuck');
    expect(ui.container.textContent).toContain('Restart the conversation, then resend.');
    await ui.click(ui.button('Restart conversation'));
    expect(store.restart).toHaveBeenCalledWith('c1', expect.any(Function));
    expect(ui.button('Resend')).toBeDefined();
  });

  it('送达待确认的气泡没有重发入口', async () => {
    const ui = await mount('pending');
    expect(ui.container.textContent).toContain('Delivery unconfirmed');
    expect(ui.button('Resend')).toBeUndefined();
  });
});
