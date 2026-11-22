import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@/stores/sessions/timeline';

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
}));
vi.mock('@/stores/settings', () => {
  const state = {
    autoCollapseTurns: false,
    projects: [
      { id: 'p-sec', name: 'secretary', path: '/tmp/sec', kind: 'secretary' },
      { id: 'p1', name: 'enso', path: '/tmp/enso', kind: 'local' },
    ],
    compactReadOnlyTools: false,
    expandLiveEdits: false,
  };
  const useSettingsStore = (select: (value: object) => unknown) => select(state);
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});
vi.mock('@/stores/sessions', async () => {
  const { create } = await import('zustand');
  const useSessionsStore = create<{
    activeId: string | null;
    conversations: Record<string, object>;
    selectConversation: (id: string) => void;
  }>()((set) => ({
    activeId: null,
    conversations: {},
    selectConversation: (id) => set({ activeId: id }),
  }));
  return { useSessionsStore };
});
vi.mock('@/stores/secretary', () => {
  const state = { secretary: { board: { todos: [] }, proposals: {} }, resolving: {} };
  const useSecretaryStore = (select: (value: object) => unknown) => select(state);
  useSecretaryStore.getState = () => state;
  return { useSecretaryStore, focusedSecretaryId: () => undefined };
});
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => text }));

const { TimelineRow } = await import('./TimelineRow');
const { SecretaryReturnButton } = await import('@/components/secretary/SecretaryReturnButton');
const { useSessionsStore: sessionsStore } = await import('@/stores/sessions');
// 替身 store 只带用到的字段
const useSessionsStore = sessionsStore as unknown as {
  getState: () => {
    activeId: string | null;
    conversations: Record<string, { parentId?: string }>;
    selectConversation: (id: string) => void;
  };
  setState: (state: object) => void;
};
const { useSecretaryReturn } = await import('@/stores/secretaryReturn');

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useSessionsStore.setState({
    activeId: 'sec-chat',
    conversations: {
      'sec-chat': { id: 'sec-chat', projectId: 'p-sec', messages: [] },
      c1: { id: 'c1', projectId: 'p1', sessionFile: '/s/c1.jsonl', title: '登录页', messages: [] },
    },
  });
  useSecretaryReturn.setState({ back: null });
  container = dom.document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const find = (enso: string) =>
  container.querySelector(`[data-enso="${enso}"]`) as unknown as HTMLElement | null;

async function click(enso: string) {
  const node = find(enso);
  if (!node) throw new Error(`Missing ${enso}`);
  await act(async () => node.click());
}

async function mount(item: TimelineItem) {
  await act(async () => root.render(createElement(TimelineRow, { item, secretarySession: true })));
}

/** 跳过去之后，目标会话标题栏应出现返回秘书，且回到发起跳转的秘书会话 */
async function expectReturnToSecretary() {
  expect(useSessionsStore.getState().activeId).toBe('c1');
  await act(async () =>
    root.render(createElement(SecretaryReturnButton, { conversationId: 'c1' }))
  );
  await click('secretary-return');
  expect(useSessionsStore.getState().activeId).toBe('sec-chat');
}

describe('秘书聊天里的跳转入口都带返回秘书', () => {
  it('派活工具卡片里的会话链接', async () => {
    await mount({
      kind: 'tool',
      key: 'tool-1',
      name: 'session_create',
      args: { projectId: 'p1', prompt: '改登录页', title: '登录页', messages: [] },
      output: JSON.stringify({ status: 'created', conversationId: 'c1' }),
      summary: '',
      state: 'ok',
      edits: null,
      writeContent: null,
      todos: null,
      durationMs: 0,
      agentMeta: null,
    } as TimelineItem);
    await click('tool-card-expand');
    await click('tool-card-session');
    await expectReturnToSecretary();
  });

  it('会话回传（含 session:<id> 与 ask-relay）行尾的打开图标', async () => {
    await mount({
      kind: 'user',
      key: '0',
      images: [],
      text: [
        '<session-updates>',
        '- [ask-relay session:c1] enso · 会话在问你',
        '</session-updates>',
      ].join('\n'),
    } as TimelineItem);
    await click('secretary-update-open');
    await expectReturnToSecretary();
  });

  it('引用过往会话的卡片', async () => {
    await mount({
      kind: 'user',
      key: '0',
      images: [],
      text: '看下 [Referenced past chat "登录页" — transcript file: /s/c1.jsonl (pi session jsonl; read it if relevant)]',
    } as TimelineItem);
    await click('chat-ref');
    await expectReturnToSecretary();
  });
});
