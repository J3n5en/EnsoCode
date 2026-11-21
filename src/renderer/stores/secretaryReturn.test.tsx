import { parseHTML } from 'linkedom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => `[${key}]` }) }));
vi.mock('@/stores/settings', () => {
  const state = {
    projects: [
      { id: 'sec-a', kind: 'secretary' },
      { id: 'sec-b', kind: 'secretary' },
      { id: 'p1', kind: 'local' },
    ],
  };
  const useSettingsStore = (selector: (s: unknown) => unknown) => selector(state);
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});
vi.mock('@/stores/sessions', async () => {
  const { create } = await import('zustand');
  const useSessionsStore = create<{
    activeId: string | null;
    conversations: Record<string, { id: string; projectId: string; parentId?: string }>;
    selectConversation: (id: string) => void;
  }>()((set, get) => ({
    activeId: null,
    conversations: {},
    selectConversation: (id) => {
      if (get().conversations[id]) set({ activeId: id });
    },
  }));
  return { useSessionsStore };
});

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
const { useSessionPeek } = await import('@/stores/sessionPeek');
const { openSessionFromSecretary, useSecretaryReturn } = await import('./secretaryReturn');
const { SecretaryReturnButton } = await import('@/components/secretary/SecretaryReturnButton');

const conv = (id: string, projectId: string, parentId?: string) => ({
  id,
  projectId,
  ...(parentId ? { parentId } : {}),
});

let root: Root;
let container: HTMLElement;

const active = () => useSessionsStore.getState().activeId as string;
const select = (id: string) => act(() => useSessionsStore.getState().selectConversation(id));
const returnButton = () =>
  container.querySelector('[data-enso="secretary-return"]') as unknown as HTMLElement | null;

async function renderHeader() {
  // 标题栏按当前会话（coworker 时是父会话）渲染返回按钮
  const shown = () => {
    const id = active();
    return useSessionsStore.getState().conversations[id]?.parentId ?? id;
  };
  await act(async () => root.render(<SecretaryReturnButton conversationId={shown()} />));
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useSessionsStore.setState({
    activeId: 'sa',
    conversations: {
      sa: conv('sa', 'sec-a'),
      sa2: conv('sa2', 'sec-a'),
      sb: conv('sb', 'sec-b'),
      c1: conv('c1', 'p1'),
      c2: conv('c2', 'p1'),
      'c1-worker': conv('c1-worker', 'p1', 'c1'),
    },
  });
  useSecretaryReturn.setState({ back: null });
  useSessionPeek.setState({ conversationId: null, result: null, tab: 'session', from: null });
  container = document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('openSessionFromSecretary', () => {
  it('从秘书会话跳到普通会话：目标会话出现返回秘书，点了回到原秘书会话并消失', async () => {
    act(() => openSessionFromSecretary('c1'));
    expect(active()).toBe('c1');
    await renderHeader();
    expect(returnButton()?.textContent).toBe('[Back to secretary]');
    act(() => returnButton()?.click());
    expect(active()).toBe('sa');
    await renderHeader();
    expect(returnButton()).toBeNull();
    expect(useSecretaryReturn.getState().back).toBeNull();
  });

  it('跳到的是秘书会话本身不给返回按钮', async () => {
    act(() => openSessionFromSecretary('sa2'));
    expect(active()).toBe('sa2');
    await renderHeader();
    expect(returnButton()).toBeNull();
  });

  it('不是从秘书会话跳的不给返回按钮', async () => {
    select('c2');
    act(() => openSessionFromSecretary('c1'));
    await renderHeader();
    expect(returnButton()).toBeNull();
  });

  it('多秘书：显式来源优先，返回到发起跳转的那个秘书会话', async () => {
    select('sb');
    act(() => openSessionFromSecretary('c1', 'sa2'));
    await renderHeader();
    act(() => returnButton()?.click());
    expect(active()).toBe('sa2');
  });

  it('在目标会话里切到别的会话后按钮消失，再切回来也不再出现', async () => {
    act(() => openSessionFromSecretary('c1'));
    select('c2');
    await renderHeader();
    expect(returnButton()).toBeNull();
    select('c1');
    await renderHeader();
    expect(returnButton()).toBeNull();
  });

  it('切到目标会话的 coworker 子会话不算离开', async () => {
    act(() => openSessionFromSecretary('c1'));
    select('c1-worker');
    await renderHeader();
    expect(returnButton()).not.toBeNull();
  });

  it('来源秘书会话被删后不再给返回按钮', async () => {
    act(() => openSessionFromSecretary('c1'));
    act(() => {
      const { sa: _gone, ...rest } = useSessionsStore.getState().conversations;
      useSessionsStore.setState({ conversations: rest });
    });
    await renderHeader();
    expect(returnButton()).toBeNull();
  });

  it('跳转时关掉看会话弹窗；弹窗记下的来源秘书会话带到跳转里', async () => {
    select('c2');
    act(() => useSessionPeek.getState().open('c1', undefined, 'sb'));
    expect(useSessionPeek.getState().from).toBe('sb');
    act(() => openSessionFromSecretary('c1', useSessionPeek.getState().from ?? undefined));
    expect(useSessionPeek.getState().conversationId).toBeNull();
    expect(useSecretaryReturn.getState().back).toEqual({ from: 'sb', to: 'c1' });
  });

  it('目标会话不存在时什么都不做', () => {
    act(() => openSessionFromSecretary('missing'));
    expect(active()).toBe('sa');
    expect(useSecretaryReturn.getState().back).toBeNull();
  });
});
