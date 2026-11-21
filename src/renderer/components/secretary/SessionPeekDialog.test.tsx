import { parseHTML } from 'linkedom';
import { act, type ReactNode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translate = (key: string) => `[${key}]`;

const h = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  state: {} as Record<string, unknown>,
  projects: [] as { id: string; name: string; path: string; kind?: string }[],
}));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: translate, locale: 'zh' }) }));
vi.mock('@/stores/settings', () => {
  const state = () => ({ projects: h.projects });
  const useSettingsStore = (selector: (s: unknown) => unknown) => selector(state());
  useSettingsStore.getState = state;
  return { useSettingsStore };
});
vi.mock('@/stores/sessions', () => {
  const useSessionsStore = (selector: (s: unknown) => unknown) => selector(h.state);
  useSessionsStore.getState = () => h.state;
  return {
    useSessionsStore,
    peekConversation: (id: string) => {
      h.calls.push({ name: 'peek', args: id });
      return () => h.calls.push({ name: 'release', args: id });
    },
  };
});
vi.mock('@/stores/bots', () => ({
  useBotsStore: (selector: (s: unknown) => unknown) => selector({ delegations: [] }),
}));
vi.mock('@/stores/bots/delegations', () => ({ delegationRunMarks: () => [] }));
vi.mock('@/components/chat/ChatSessionTimeline', () => ({
  ChatSessionTimeline: ({ conversationId }: { conversationId: string }) => (
    <div data-enso="peek-timeline">{conversationId}</div>
  ),
}));
vi.mock('@/components/chat/ApprovalBar', () => ({
  ApprovalBar: ({ approvals }: { approvals: unknown[] }) => (
    <div data-enso="peek-approvals">{approvals.length}</div>
  ),
}));
vi.mock('@/components/chat/AskBar', () => ({
  AskBar: ({ asks }: { asks: unknown[] }) => <div data-enso="peek-asks">{asks.length}</div>,
}));
// 替身只保留本组件依赖的契约：开着才渲染内容，Esc 走 onOpenChange(false)
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) => {
    useEffect(() => {
      if (!open) return;
      const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onOpenChange(false);
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, [open, onOpenChange]);
    return open ? children : null;
  },
  DialogContent: ({ children, ...props }: { children: ReactNode }) => (
    <div data-dialog="content" {...props}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => (
    <h2 data-enso="peek-title">{children}</h2>
  ),
}));

const { SessionPeekDialog, SecretaryReturnButton, peekStatus } = await import(
  './SessionPeekDialog'
);
const { useSessionPeek } = await import('@/stores/sessionPeek');

const conversation = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  projectId: 'p1',
  title: `会话 ${id}`,
  status: 'running',
  spawning: false,
  messages: [],
  ...over,
});

let root: Root;
let container: HTMLElement;

function q(selector: string): HTMLElement | null {
  return container.querySelector(selector) as unknown as HTMLElement | null;
}

async function rerender() {
  await act(async () => {
    root.render(
      <>
        <SessionPeekDialog />
        <SecretaryReturnButton conversationId={String(h.state.activeId)} />
      </>
    );
  });
}

beforeEach(() => {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  h.calls = [];
  h.projects = [
    { id: 'p1', name: 'enso-code', path: '/repo/enso-code' },
    { id: 'sec', name: '秘书', path: '/sec', kind: 'secretary' },
  ];
  h.state = {
    activeId: 'secretary-chat',
    conversations: {
      'secretary-chat': conversation('secretary-chat', { projectId: 'sec', status: 'idle' }),
      c1: conversation('c1', {
        worktree: { branch: 'feat/login', path: '/wt/c1' },
        goal: { text: '登录拆三步', status: 'active', autoTurns: 3 },
      }),
      c2: conversation('c2', {
        status: 'idle',
        pendingApprovals: [{ requestId: 'a1' }],
        pendingAsks: [{ requestId: 'q1' }],
      }),
      old: conversation('old', { archived: true }),
    },
    selectConversation: (id: string) => {
      h.calls.push({ name: 'selectConversation', args: id });
      h.state = { ...h.state, activeId: id };
    },
  };
  useSessionPeek.setState({ conversationId: null, back: null });
  container = document.getElementById('root') as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe('SessionPeekDialog', () => {
  it('关着时什么都不渲染，也不保热会话', async () => {
    await rerender();
    expect(q('[data-enso="session-peek"]')).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('打开后显示标题、状态、项目、分支、目标与实时时间线，并保热该会话', async () => {
    act(() => useSessionPeek.getState().open('c1'));
    await rerender();
    expect(q('[data-enso="peek-title"]')?.textContent).toBe('会话 c1');
    expect(q('[data-enso="session-peek-status"]')?.textContent).toBe('[Running]');
    expect(q('[data-enso="session-peek-project"]')?.textContent).toBe('enso-code');
    expect(q('[data-enso="session-peek-branch"]')?.textContent).toBe('feat/login');
    expect(q('[data-enso="session-peek-goal"]')?.textContent).toContain('登录拆三步');
    expect(q('[data-enso="session-peek-goal"]')?.textContent).toContain('3/25');
    expect(q('[data-enso="peek-timeline"]')?.textContent).toBe('c1');
    expect(h.calls).toContainEqual({ name: 'peek', args: 'c1' });
  });

  it('待审批与待回答的提问醒目地放在底部，状态是等你', async () => {
    act(() => useSessionPeek.getState().open('c2'));
    await rerender();
    expect(q('[data-enso="session-peek-status"]')?.textContent).toBe('[Waiting for you]');
    expect(q('[data-enso="session-peek-pending"]')?.textContent).toContain(
      '[Needs your approval or answer]'
    );
    expect(q('[data-enso="peek-approvals"]')?.textContent).toBe('1');
    expect(q('[data-enso="peek-asks"]')?.textContent).toBe('1');
  });

  it('「打开会话」先关弹窗再跳转，并在目标会话给返回秘书', async () => {
    act(() => useSessionPeek.getState().open('c1'));
    await rerender();
    act(() => q('[data-enso="session-peek-open"]')?.click());
    expect(useSessionPeek.getState().conversationId).toBeNull();
    expect(h.calls).toContainEqual({ name: 'selectConversation', args: 'c1' });
    expect(h.calls).toContainEqual({ name: 'release', args: 'c1' });
    expect(useSessionPeek.getState().back).toEqual({ from: 'secretary-chat', to: 'c1' });

    await rerender();
    expect(q('[data-enso="session-peek"]')).toBeNull();
    act(() => q('[data-enso="secretary-return"]')?.click());
    expect(h.calls.at(-1)).toEqual({ name: 'selectConversation', args: 'secretary-chat' });
    expect(useSessionPeek.getState().back).toBeNull();
  });

  it('不是从秘书会话跳过去的不给返回秘书', async () => {
    h.state = { ...h.state, activeId: 'c2' };
    act(() => useSessionPeek.getState().open('c1'));
    await rerender();
    act(() => q('[data-enso="session-peek-open"]')?.click());
    await rerender();
    expect(useSessionPeek.getState().back).toBeNull();
    expect(q('[data-enso="secretary-return"]')).toBeNull();
  });

  it('Esc 关闭弹窗，不跳转', async () => {
    act(() => useSessionPeek.getState().open('c1'));
    await rerender();
    await act(async () => {
      const event = new window.Event('keydown');
      Object.defineProperty(event, 'key', { value: 'Escape' });
      document.dispatchEvent(event);
    });
    expect(useSessionPeek.getState().conversationId).toBeNull();
    expect(q('[data-enso="session-peek"]')).toBeNull();
    expect(h.calls.some((call) => call.name === 'selectConversation')).toBe(false);
    expect(h.calls).toContainEqual({ name: 'release', args: 'c1' });
  });

  it('会话已不存在时写明原因，不渲染时间线也不给打开', async () => {
    act(() => useSessionPeek.getState().open('gone'));
    await rerender();
    expect(q('[data-enso="session-peek-unavailable"]')?.textContent).toBe(
      '[This session no longer exists, or you do not have access to it]'
    );
    expect(q('[data-enso="peek-timeline"]')).toBeNull();
    expect(q('[data-enso="session-peek-open"]')).toBeNull();
    expect(h.calls.some((call) => call.name === 'peek')).toBe(false);
  });

  it('已归档的会话写明原因', async () => {
    act(() => useSessionPeek.getState().open('old'));
    await rerender();
    expect(q('[data-enso="session-peek-unavailable"]')?.textContent).toBe(
      '[This session is archived. Restore it from the archive to view it.]'
    );
    expect(q('[data-enso="peek-timeline"]')).toBeNull();
  });
});

describe('peekStatus', () => {
  it('等你优先于运行，其次失败，其余算完成', () => {
    expect(peekStatus({ status: 'running', spawning: false, pendingAsks: [{} as never] })).toBe(
      'waiting'
    );
    expect(peekStatus({ status: 'idle', spawning: true })).toBe('running');
    expect(peekStatus({ status: 'failed', spawning: false })).toBe('failed');
    expect(peekStatus({ status: 'idle', spawning: false })).toBe('done');
  });
});
