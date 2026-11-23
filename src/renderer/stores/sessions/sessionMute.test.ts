import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedPartializeSessions } from './persistSnapshot';

const setSessionMuted = vi.fn();

vi.stubGlobal('navigator', { language: 'en-US' });
vi.stubGlobal('document', {
  documentElement: {
    dataset: {},
    lang: 'en',
    classList: { toggle: vi.fn() },
    style: { setProperty: vi.fn(), removeProperty: vi.fn() },
  },
});
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener: vi.fn() }),
  electronAPI: {
    settings: {
      read: vi.fn(async () => null),
      writeKey: vi.fn(async () => true),
      onChanged: vi.fn(),
    },
    capabilities: { onAsk: vi.fn(() => vi.fn()), respond: vi.fn(async () => ({ ok: true })) },
    agent: {
      onFocusSession: vi.fn(),
      onEvent: vi.fn(() => vi.fn()),
      requestSnapshot: vi.fn(async () => ({ ok: true })),
      spawn: vi.fn(async () => ({ ok: true })),
      prompt: vi.fn(async () => ({ ok: true })),
      release: vi.fn(async () => ({ ok: true })),
      abort: vi.fn(async () => ({ ok: true })),
      dismissCoworker: vi.fn(async () => ({ ok: true })),
      setSessionMuted,
    },
    agentDispatch: {
      bindSource: vi.fn(),
      registerModelSelection: vi.fn(),
      dispatch: vi.fn(),
      onEvent: vi.fn(() => vi.fn()),
    },
    sourceAuthority: {
      read: vi.fn(async () => ({ projects: [], conversations: [] })),
      onChanged: vi.fn(() => vi.fn()),
      createProject: vi.fn(),
      selectProject: vi.fn(),
      removeProject: vi.fn(),
      createConversation: vi.fn(),
      selectConversation: vi.fn(),
      endConversation: vi.fn(async () => ({ accepted: false as const, error: 'test' })),
      removeConversation: vi.fn(async () => ({ accepted: false as const, error: 'test' })),
      updateConversationSelection: vi.fn(),
    },
  },
});

const sessions = await import('./index');

const conv = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: 'project',
  title: id,
  started: false,
  spawning: false,
  status: 'idle',
  messages: [{ timestamp: 10, role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  createdAt: 1,
  lastActiveAt: 10,
  unread: true,
  pendingAsks: [{ requestId: 'ask' }],
  ...extra,
});

beforeEach(() => {
  setSessionMuted.mockClear();
  sessions.useSessionsStore.setState({
    conversations: { a: conv('a'), child: conv('child', { parentId: 'a' }) },
    order: ['a'],
    activeId: 'a',
  } as never);
});

describe('toggleMuteConversation', () => {
  it('静音后立刻通知 main，取消静音后恢复，正文和未读不动', () => {
    const store = sessions.useSessionsStore.getState();
    store.toggleMuteConversation('a');
    const muted = sessions.useSessionsStore.getState().conversations.a;
    expect(muted?.muted).toBe(true);
    expect(muted?.unread).toBe(true);
    expect(muted?.pendingAsks).toEqual([{ requestId: 'ask' }]);
    expect(muted?.messages).toHaveLength(1);
    expect(setSessionMuted).toHaveBeenCalledWith('a', true);

    sessions.useSessionsStore.getState().toggleMuteConversation('a');
    expect(sessions.useSessionsStore.getState().conversations.a?.muted).toBeUndefined();
    expect(setSessionMuted).toHaveBeenLastCalledWith('a', false);
    expect(sessions.useSessionsStore.getState().conversations.a?.unread).toBe(true);
  });

  it('子会话不能单独静音', () => {
    sessions.useSessionsStore.getState().toggleMuteConversation('child');
    expect(sessions.useSessionsStore.getState().conversations.child?.muted).toBeUndefined();
    expect(setSessionMuted).not.toHaveBeenCalled();
  });

  it('归档和删除清掉静音，并告诉 main', () => {
    sessions.useSessionsStore.getState().toggleMuteConversation('a');
    setSessionMuted.mockClear();
    sessions.useSessionsStore.getState().toggleArchiveConversation('a');
    const archived = sessions.useSessionsStore.getState().conversations.a;
    expect(archived?.archived).toBe(true);
    expect(archived?.muted).toBeUndefined();
    expect(setSessionMuted).toHaveBeenCalledWith('a', false);

    sessions.useSessionsStore.getState().toggleMuteConversation('a');
    expect(sessions.useSessionsStore.getState().conversations.a?.muted).toBe(true);
    sessions.useSessionsStore.getState().removeConversation('a');
    expect(sessions.useSessionsStore.getState().conversations.a).toBeUndefined();
    expect(setSessionMuted).toHaveBeenLastCalledWith('a', false);
  });

  it('静音随 partialize 保留', () => {
    sessions.useSessionsStore.getState().toggleMuteConversation('a');
    const state = sessions.useSessionsStore.getState();
    const persisted = cachedPartializeSessions({
      conversations: state.conversations,
      order: state.order,
      activeId: state.activeId,
    });
    expect(persisted.conversations.a?.muted).toBe(true);
    expect(persisted.conversations.a?.messages).toEqual([]);
    expect(persisted.conversations.a?.pendingAsks).toEqual([]);
  });
});
