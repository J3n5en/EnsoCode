import { parseHTML } from 'linkedom';
import { act, type ReactNode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translate = (key: string, params?: Record<string, unknown>) =>
  `[${key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name]))}]`;

const h = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  state: {} as Record<string, unknown>,
  projects: [] as { id: string; name: string; path: string; kind?: string }[],
  doneReport: null as unknown,
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
  useSessionsStore.subscribe = () => () => undefined;
  return {
    useSessionsStore,
    peekConversation: (id: string, options?: { readOnly?: boolean }) => {
      h.calls.push({ name: options?.readOnly ? 'peek-readonly' : 'peek', args: id });
      return () => h.calls.push({ name: 'release', args: id });
    },
  };
});
vi.mock('@/stores/bots', () => ({
  useBotsStore: (selector: (s: unknown) => unknown) => selector({ delegations: [] }),
}));
vi.mock('@/stores/bots/delegations', () => ({ delegationRunMarks: () => [] }));
vi.mock('@/components/chat/ChatSessionTimeline', () => ({
  ChatSessionTimeline: ({
    conversationId,
    readOnly,
  }: {
    conversationId: string;
    readOnly?: boolean;
  }) => (
    <div data-enso="peek-timeline" data-readonly={readOnly ? 'true' : undefined}>
      {conversationId}
    </div>
  ),
}));
vi.mock('@/components/chat/ApprovalBar', () => ({
  ApprovalBar: ({ approvals }: { approvals: unknown[] }) => (
    <div data-enso="peek-approvals">{approvals.length}</div>
  ),
}));
vi.mock('@/components/chat/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => <div data-enso="peek-markdown">{text}</div>,
}));
vi.mock('@/components/chat/ZoomableImage', () => ({
  ZoomableImage: ({ src, alt, onError }: { src: string; alt?: string; onError?: () => void }) => (
    <img data-enso="peek-zoomable" src={src} alt={alt} onError={onError} />
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

const { SessionPeekDialog, peekStatus } = await import('./SessionPeekDialog');
const { SecretaryReturnButton } = await import('./SecretaryReturnButton');
const { useSessionPeek } = await import('@/stores/sessionPeek');
const { useSecretaryReturn } = await import('@/stores/secretaryReturn');

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
      old: conversation('old', {
        status: 'idle',
        archived: true,
        archivedAt: 900,
        pendingApprovals: [{ requestId: 'stale' }],
      }),
    },
    selectConversation: (id: string) => {
      h.calls.push({ name: 'selectConversation', args: id });
      h.state = { ...h.state, activeId: id };
    },
    toggleArchiveConversation: (id: string) => {
      h.calls.push({ name: 'toggleArchive', args: id });
      const conversations = h.state.conversations as Record<string, Record<string, unknown>>;
      const target = conversations[id];
      h.state = {
        ...h.state,
        conversations: {
          ...conversations,
          [id]: target.archived
            ? { ...target, archived: undefined, archivedAt: undefined }
            : { ...target, archived: true },
        },
      };
    },
  };
  useSessionPeek.setState({ conversationId: null, result: null, tab: 'session', from: null });
  useSecretaryReturn.setState({ back: null });
  h.doneReport = {
    report: {
      at: 1700000000000,
      text: '登录拆成三步，截图 ![桌面](/tmp/desk.png)',
      images: [
        { label: 'desk.png', name: `${'a'.repeat(64)}.png` },
        { label: 'gone.png', missing: true },
      ],
    },
    pr: {
      number: 342,
      url: 'https://github.com/o/r/pull/342',
      state: 'MERGED',
      mergeSha: '1234567890abcdef1234567890abcdef12345678',
    },
    files: [{ path: 'src/a.ts', additions: 12, deletions: 3 }],
  };
  (window as unknown as Record<string, unknown>).electronAPI = {
    secretary: {
      doneReport: async (id: string) => {
        h.calls.push({ name: 'doneReport', args: id });
        return { ok: true, result: h.doneReport };
      },
    },
  };
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
    expect(useSecretaryReturn.getState().back).toEqual({ from: 'secretary-chat', to: 'c1' });

    await rerender();
    expect(q('[data-enso="session-peek"]')).toBeNull();
    act(() => q('[data-enso="secretary-return"]')?.click());
    expect(h.calls.at(-1)).toEqual({ name: 'selectConversation', args: 'secretary-chat' });
    expect(useSecretaryReturn.getState().back).toBeNull();
  });

  it('不是从秘书会话跳过去的不给返回秘书', async () => {
    h.state = { ...h.state, activeId: 'c2' };
    act(() => useSessionPeek.getState().open('c1'));
    await rerender();
    act(() => q('[data-enso="session-peek-open"]')?.click());
    await rerender();
    expect(useSecretaryReturn.getState().back).toBeNull();
    expect(q('[data-enso="secretary-return"]')).toBeNull();
  });

  it('侧栏悬停卡（不在秘书会话里）打开的弹窗：返回到卡片所属的秘书会话', async () => {
    h.state = {
      ...h.state,
      activeId: 'c2',
      conversations: {
        ...(h.state.conversations as object),
        'secretary-b': conversation('secretary-b', { projectId: 'sec', status: 'idle' }),
      },
    };
    act(() => useSessionPeek.getState().open('c1', undefined, 'secretary-b'));
    await rerender();
    act(() => q('[data-enso="session-peek-open"]')?.click());
    await rerender();
    act(() => q('[data-enso="secretary-return"]')?.click());
    expect(h.calls.at(-1)).toEqual({ name: 'selectConversation', args: 'secretary-b' });
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

  it('已归档的会话只读可看：照常渲染时间线、标「已归档 · 只读」，不挂审批也不要 worker', async () => {
    act(() => useSessionPeek.getState().open('old'));
    await rerender();
    expect(q('[data-enso="session-peek-unavailable"]')).toBeNull();
    expect(q('[data-enso="peek-timeline"]')?.textContent).toBe('old');
    expect(q('[data-enso="peek-timeline"]')?.getAttribute('data-readonly')).toBe('true');
    expect(q('[data-enso="session-peek-archived"]')?.textContent).toBe('[Archived · read-only]');
    expect(q('[data-enso="session-peek-pending"]')).toBeNull();
    expect(h.calls).toContainEqual({ name: 'peek-readonly', args: 'old' });
    expect(h.calls.some((call) => call.name === 'peek')).toBe(false);
    const conversations = h.state.conversations as Record<string, Record<string, unknown>>;
    expect(conversations.old.archived).toBe(true);
    expect(h.state.activeId).toBe('secretary-chat');
  });

  it('「恢复并打开」先取消归档再跳过去，并给返回秘书', async () => {
    act(() => useSessionPeek.getState().open('old'));
    await rerender();
    const open = q('[data-enso="session-peek-actions"] [data-enso="session-peek-open"]');
    expect(open?.textContent).toBe('[Restore and open]');
    act(() => open?.click());
    const conversations = h.state.conversations as Record<string, Record<string, unknown>>;
    expect(conversations.old.archived).toBeUndefined();
    expect(h.calls.map((call) => call.name)).toEqual(
      expect.arrayContaining(['toggleArchive', 'selectConversation'])
    );
    expect(h.calls.findIndex((call) => call.name === 'toggleArchive')).toBeLessThan(
      h.calls.findIndex((call) => call.name === 'selectConversation')
    );
    expect(useSessionPeek.getState().conversationId).toBeNull();
    expect(useSecretaryReturn.getState().back).toEqual({ from: 'secretary-chat', to: 'old' });
  });

  it('未归档会话的打开会话不动归档状态', async () => {
    act(() => useSessionPeek.getState().open('c1'));
    await rerender();
    expect(q('[data-enso="session-peek-archived"]')).toBeNull();
    expect(q('[data-enso="peek-timeline"]')?.getAttribute('data-readonly')).toBeNull();
    act(() => q('[data-enso="session-peek-open"]')?.click());
    expect(h.calls.some((call) => call.name === 'toggleArchive')).toBe(false);
  });
});

describe('SessionPeekDialog 结果视图', () => {
  async function openResult(id = 'c1', result = { title: '重构登录', fallback: '看板正文' }) {
    act(() => useSessionPeek.getState().open(id, result));
    await rerender();
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('已完成条目默认显示结果：汇报、PR、合并 sha、改动文件与截图缩略图', async () => {
    await openResult();
    expect(q('[data-enso="session-peek-tab-result"]')?.getAttribute('aria-selected')).toBe('true');
    expect(q('[data-enso="peek-timeline"]')).toBeNull();
    expect(h.calls).toContainEqual({ name: 'doneReport', args: 'c1' });
    expect(q('[data-enso="peek-markdown"]')?.textContent).toBe('登录拆成三步，截图 `desk.png`');
    const pr = q('[data-enso="done-report-pr"] a');
    expect(pr?.getAttribute('href')).toBe('https://github.com/o/r/pull/342');
    expect(pr?.textContent).toBe('PR #342');
    expect(q('[data-enso="done-report-sha"]')?.textContent).toBe('1234567');
    expect(q('[data-enso="done-report-file"]')?.textContent).toContain('src/a.ts');
    expect(q('[data-enso="done-report-file"]')?.textContent).toContain('+12');
    const img = q('[data-enso="peek-zoomable"]');
    expect(img?.getAttribute('src')).toBe(
      `local-image://secretary-report/c1/${'a'.repeat(64)}.png?v=1700000000000`
    );
    expect(img?.getAttribute('src')).not.toContain('/tmp/');
    expect(q('[data-enso="done-report-missing"]')?.textContent).toContain('[Image unavailable]');
  });

  it('切到会话看时间线，再切回结果', async () => {
    await openResult();
    act(() => q('[data-enso="session-peek-tab-session"]')?.click());
    expect(q('[data-enso="peek-timeline"]')?.textContent).toBe('c1');
    expect(q('[data-enso="session-peek-result"]')).toBeNull();
    act(() => q('[data-enso="session-peek-tab-result"]')?.click());
    expect(q('[data-enso="session-peek-result"]')).not.toBeNull();
  });

  it('桌面宽度下结果页和会话页的标题栏右上角都有打开入口，已自动归档的写明会先恢复', async () => {
    vi.stubGlobal('innerWidth', 1440);
    const headerOpen = () =>
      q('[data-enso="session-peek-actions"] [data-enso="session-peek-open"]');
    for (const [id, label] of [
      ['c1', '[Open session]'],
      ['old', '[Restore and open]'],
    ]) {
      await openResult(id);
      expect(q('[data-enso="session-peek-result"]')).not.toBeNull();
      expect(headerOpen()?.textContent).toBe(label);
      act(() => q('[data-enso="session-peek-tab-session"]')?.click());
      expect(q('[data-enso="session-peek-result"]')).toBeNull();
      expect(headerOpen()?.textContent).toBe(label);
      expect(q('[data-enso="peek-timeline"]')?.textContent).toBe(id);
      act(() => useSessionPeek.getState().close());
    }
    await openResult('old');
    act(() => headerOpen()?.click());
    expect(useSessionPeek.getState().conversationId).toBeNull();
    expect(h.calls).toContainEqual({ name: 'selectConversation', args: 'old' });
    expect(useSecretaryReturn.getState().back).toEqual({ from: 'secretary-chat', to: 'old' });
  });

  const DONE_AT = new Date(2025, 10, 21, 18, 5).getTime();
  const GONE_AT = new Date(2025, 10, 28, 3, 0).getTime();
  const hash = (c: string) => `${c.repeat(64)}.png`;

  it('全部过期：缩略图位置换成占位卡，写明张数、完成时间、保留期与清理日期，正文照常', async () => {
    h.doneReport = {
      report: {
        at: DONE_AT,
        text: '做完了 /tmp/a.png /tmp/b.png',
        images: [
          { label: 'a.png', name: hash('a'), gone: 'expired' },
          { label: 'b.png', name: hash('b'), gone: 'expired' },
        ],
        imagesGone: 'expired',
        imagesGoneAt: GONE_AT,
        retentionDays: 7,
      },
    };
    await openResult();
    expect(q('[data-enso="peek-markdown"]')?.textContent).toBe('做完了 /tmp/a.png /tmp/b.png');
    const card = q('[data-enso="done-report-images-gone"]');
    expect(card?.querySelector('svg')).not.toBeNull();
    expect(card?.textContent).toContain('[2 screenshots expired]');
    expect(card?.textContent).toContain(
      '[Completed 11-21 18:05, kept for 7 days, cleaned up on 11-28]'
    );
    expect(q('[data-enso="peek-zoomable"]')).toBeNull();
    expect(q('[data-enso="done-report-expired"]')).toBeNull();
  });

  it('资源页清理掉的写清理，不写保留期', async () => {
    h.doneReport = {
      report: {
        at: DONE_AT,
        text: '做完了',
        images: [{ label: 'a.png', name: hash('a'), gone: 'cleared' }],
        imagesGone: 'cleared',
        imagesGoneAt: GONE_AT,
        retentionDays: 7,
      },
    };
    await openResult();
    const card = q('[data-enso="done-report-images-gone"]');
    expect(card?.textContent).toContain('[1 screenshots were cleaned up]');
    expect(card?.textContent).toContain('[Completed 11-21 18:05, cleaned up on 11-28]');
  });

  it('部分过期：还在的照常显示，过期的每张一个同尺寸「已过期」占位，和「无法显示」分开', async () => {
    h.doneReport = {
      report: {
        at: DONE_AT,
        text: '做完了',
        images: [
          { label: 'live.png', name: hash('a') },
          { label: 'old.png', name: hash('b'), gone: 'expired' },
          { label: 'bad.png', missing: true },
        ],
        imagesGoneAt: GONE_AT,
        retentionDays: 7,
      },
    };
    await openResult();
    expect(q('[data-enso="done-report-images-gone"]')).toBeNull();
    expect(container.querySelectorAll('[data-enso="peek-zoomable"]')).toHaveLength(1);
    const expired = q('[data-enso="done-report-expired"]');
    expect(expired?.textContent).toBe('[Expired]');
    expect(expired?.getAttribute('title')).toBe(
      '[Completed 11-21 18:05, kept for 7 days, cleaned up on 11-28]'
    );
    const missing = q('[data-enso="done-report-missing"]');
    expect(missing?.textContent).toBe('[Image unavailable]');
    expect(expired?.className).toBe(missing?.className);
  });

  it('副本读不出来（格式不对）时换成「无法显示」，不算过期', async () => {
    h.doneReport = {
      report: { at: DONE_AT, text: '做完了', images: [{ label: 'x.png', name: hash('c') }] },
    };
    await openResult();
    act(() => {
      q('[data-enso="peek-zoomable"]')?.dispatchEvent(new window.Event('error'));
    });
    expect(q('[data-enso="peek-zoomable"]')).toBeNull();
    expect(q('[data-enso="done-report-missing"]')?.textContent).toBe('[Image unavailable]');
    expect(q('[data-enso="done-report-expired"]')).toBeNull();
  });

  it('没存下报告时用看板正文；会话删了也照样显示结果与标题快照', async () => {
    h.doneReport = { report: null };
    await openResult('gone');
    expect(q('[data-enso="peek-title"]')?.textContent).toBe('重构登录');
    expect(q('[data-enso="peek-markdown"]')?.textContent).toBe('看板正文');
    expect(q('[data-enso="done-report-pr"]')).toBeNull();
    expect(q('[data-enso="done-report-files"]')).toBeNull();
    act(() => q('[data-enso="session-peek-tab-session"]')?.click());
    expect(q('[data-enso="session-peek-unavailable"]')).not.toBeNull();
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
