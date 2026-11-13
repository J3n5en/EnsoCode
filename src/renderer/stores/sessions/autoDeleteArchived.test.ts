/**
 * R4 超期归档自动删除的 store 动作测试。契约见
 * docs/project-history/09-08-sidebar-auto-archive/design.md：days>0 时对
 * staleArchivedConversationIdsToDelete 的候选逐条走现有 removeConversation；
 * days<=0 为从不，跳过 activeId，不二次确认。
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SettingsModule from '../settings';
import type * as SessionsModule from './index';

const agentRelease = vi.fn(async () => ({ ok: true }));
const wtRemove = vi.fn(async () => ({ ok: true as const, value: null }));
const authorityRemoveConversation = vi.fn(async () => ({
  accepted: false as const,
  error: 'test',
}));

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
      readConversations: vi.fn(async () => ({ value: null, seq: 0 })),
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
      release: agentRelease,
      abort: vi.fn(async () => ({ ok: true })),
      dismissCoworker: vi.fn(async () => ({ ok: true })),
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
      removeConversation: authorityRemoveConversation,
      updateConversationSelection: vi.fn(),
    },
    worktree: {
      create: vi.fn(),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
      status: vi.fn(async () => ({ ok: true, value: { exists: true, dirty: false, ahead: 0 } })),
      remove: wtRemove,
      rebuild: vi.fn(),
      repoClean: vi.fn(async () => ({ ok: true as const, value: true })),
    },
  },
});

let sessions: typeof SessionsModule;
let settings: typeof SettingsModule;

beforeAll(async () => {
  settings = await import('../settings');
  sessions = await import('./index');
});

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

/** 待实现的动作：用可选签名取，避免 typecheck 卡在实现之前 */
type AutoDeleteAction = { autoDeleteStaleArchived?: (now?: number) => void };
const action = () => sessions.useSessionsStore.getState() as unknown as AutoDeleteAction;

function conv(id: string, ageDays: number, extra: Record<string, unknown> = {}) {
  const at = NOW - ageDays * DAY;
  return {
    id,
    projectId: 'project',
    title: id,
    started: false,
    spawning: false,
    status: 'idle',
    messages: [],
    createdAt: at,
    lastActiveAt: at,
    archived: true,
    archivedAt: at,
    ...extra,
  };
}

function seed(
  conversations: Record<string, unknown>,
  days: number,
  activeId: string | null = null
) {
  sessions.useSessionsStore.setState({
    conversations,
    order: Object.keys(conversations),
    activeId,
  } as never);
  settings.useSettingsStore.setState({
    autoDeleteArchivedDays: days,
    projects: [{ id: 'project', name: 'Project', path: '/workspace' }],
  } as never);
}

const ids = () => Object.keys(sessions.useSessionsStore.getState().conversations);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('autoDeleteStaleArchived', () => {
  it('是 store 上的动作', () => {
    expect(typeof action().autoDeleteStaleArchived).toBe('function');
  });

  it('days=15：归档 40 天的删掉，归档 5 天的留下', () => {
    seed({ old: conv('old', 40), recent: conv('recent', 5) }, 15);
    action().autoDeleteStaleArchived?.(NOW);
    expect(ids()).toEqual(['recent']);
  });

  it('days=0（从不）：归档 100 天也不删', () => {
    seed({ ancient: conv('ancient', 100) }, 0);
    action().autoDeleteStaleArchived?.(NOW);
    expect(ids()).toEqual(['ancient']);
    expect(authorityRemoveConversation).not.toHaveBeenCalled();
    expect(wtRemove).not.toHaveBeenCalled();
    expect(agentRelease).not.toHaveBeenCalled();
  });

  it('当前打开的超期归档不删', () => {
    seed({ open: conv('open', 40), other: conv('other', 40) }, 15, 'open');
    action().autoDeleteStaleArchived?.(NOW);
    expect(ids()).toEqual(['open']);
  });

  it('未归档的闲置会话不走这条路径', () => {
    seed({ live: conv('live', 40, { archived: undefined, archivedAt: undefined }) }, 15);
    action().autoDeleteStaleArchived?.(NOW);
    expect(ids()).toEqual(['live']);
  });

  it('省略 now 时用 Date.now() 作 cutoff', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    seed({ old: conv('old', 40), recent: conv('recent', 5) }, 15);
    action().autoDeleteStaleArchived?.();
    expect(ids()).toEqual(['recent']);
    vi.useRealTimers();
  });

  it('超期归档仍挂 worktree：走 removeConversation，连带清 worktree', async () => {
    seed(
      {
        iso: conv('iso', 40, {
          worktree: { conversationId: 'iso', path: '/managed/iso', branch: 'enso/iso' },
        }),
      },
      15
    );
    action().autoDeleteStaleArchived?.(NOW);
    await vi.waitFor(() => expect(ids()).toEqual([]));
    expect(wtRemove).toHaveBeenCalledWith('iso');
  });
});
