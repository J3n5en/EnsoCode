/**
 * 会话级 worktree 隔离的 store 逻辑测试。
 * 产品决策见 docs/plans/2026-08-22-enso-code-design.md「trust 与 isolation」。
 */

import type { RendererAgentEvent, SourceAuthorityProjection } from '@shared/types/agent';
import type {
  SessionWorktree,
  WorkspaceBranchSwitchResult,
  WorktreeStatus,
} from '@shared/types/worktree';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SettingsModule from '../settings';
import type * as SessionsModule from './index';
import * as worktree from './worktree';
import {
  DIRTY_MAIN_TREE,
  workspaceFallbackNote,
  workspaceMigratedNote,
  worktreeHasPendingWork,
} from './worktree';

type AutoCleanupHelper = { worktreeReadyToAutoCleanup: (status: unknown) => boolean };
const autoCleanupHelper = worktree as typeof worktree & Partial<AutoCleanupHelper>;

let sourceProjection: SourceAuthorityProjection = { projects: [], conversations: [] };

const record = (conversationId: string): SessionWorktree => ({
  conversationId,
  projectId: 'project',
  repoPath: '/workspace',
  path: `/managed/${conversationId}`,
  branch: `enso/${conversationId}`,
  baseBranch: 'main',
  baseCommit: 'abc',
  createdAt: 1,
});

const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ addToast }));

let onAgentEvent: (event: RendererAgentEvent) => void;
const wtGet = vi.fn(async (_id: string): Promise<SessionWorktree | null> => null);
const wtList = vi.fn(
  async (): Promise<SessionWorktree[]> =>
    Object.values(sessions.useSessionsStore.getState().conversations).flatMap((conversation) =>
      conversation.worktree ? [conversation.worktree] : []
    )
);
const agentSpawn = vi.fn(async () => ({ ok: true }));
const agentPrompt = vi.fn(async () => ({ ok: true }));
const agentRelease = vi.fn(async () => ({ ok: true }));
const wtCreate = vi.fn(async (conversationId: string, _projectId: string) => ({
  ok: true as const,
  value: record(conversationId),
}));
const wtStatus = vi.fn(
  async (): Promise<{ ok: true; value: WorktreeStatus } | { ok: false; error: string }> => ({
    ok: true,
    value: { exists: true, dirty: false, ahead: 0 },
  })
);
const wtRemove = vi.fn(async () => ({ ok: true as const, value: null }));
const wtRebuild = vi.fn(async (conversationId: string) => ({
  ok: true as const,
  value: { ...record(conversationId), path: `/managed/rebuilt-${conversationId}` },
}));
const wtRepoClean = vi.fn(async () => ({ ok: true as const, value: true }));

const wtBind = vi.fn(async (id: string, source: string) => ({
  ok: true as const,
  value: { ...record(source), conversationId: id },
}));
const wtRename = vi.fn(async (_id: string, _name: string) => ({
  ok: true as const,
  value: [] as SessionWorktree[],
}));
const wtSwitch = vi.fn<(...args: unknown[]) => Promise<WorkspaceBranchSwitchResult>>();
const removeAuthority = vi.fn(async () => ({ accepted: true as const }));
const createConversation = vi.fn(async () => {
  const value = {
    conversationId: `conv-${sourceProjection.conversations.length + 1}`,
    projectId: 'project',
    kind: 'root' as const,
    lifecycle: 'draft' as const,
    version: 1,
  };
  sourceProjection = {
    ...sourceProjection,
    conversations: [...sourceProjection.conversations, value],
  };
  return { accepted: true as const, value };
});

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
      onEvent: vi.fn((listener: (event: RendererAgentEvent) => void) => {
        onAgentEvent = listener;
        return vi.fn();
      }),
      requestSnapshot: vi.fn(async () => ({ ok: true })),
      readChildHistory: vi.fn(async () => ({ ok: false, code: 'not-found', error: 'no' })),
      readChildRun: vi.fn(async () => ({ ok: false, code: 'not-found', error: 'no' })),
      spawn: agentSpawn,
      prompt: agentPrompt,
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
      read: vi.fn(async () => sourceProjection),
      onChanged: vi.fn(() => vi.fn()),
      createProject: vi.fn(),
      selectProject: vi.fn(async (request: { projectId: string }) => ({
        accepted: true as const,
        value: sourceProjection.projects.find(
          (project) => project.projectId === request.projectId
        )!,
      })),
      removeProject: vi.fn(),
      createConversation,
      selectConversation: vi.fn(async (request: { conversationId: string }) => ({
        accepted: true as const,
        value: sourceProjection.conversations.find(
          (conversation) => conversation.conversationId === request.conversationId
        )!,
      })),
      endConversation: vi.fn(async (request: { conversationId: string; version: number }) => ({
        accepted: true as const,
        value: { conversationId: request.conversationId, version: request.version + 1 },
      })),
      removeConversation: removeAuthority,
      updateConversationSelection: vi.fn(),
    },
    worktree: {
      switchBranch: wtSwitch,
      create: wtCreate,
      bind: wtBind,
      rename: wtRename,
      get: wtGet,
      list: wtList,
      status: wtStatus,
      remove: wtRemove,
      rebuild: wtRebuild,
      repoClean: wtRepoClean,
    },
  },
});

let sessions: typeof SessionsModule;
let settings: typeof SettingsModule;

beforeAll(async () => {
  settings = await import('../settings');
  sessions = await import('./index');
});

beforeEach(() => {
  vi.clearAllMocks();
  sourceProjection = {
    projects: [{ projectId: 'project', canonicalPath: '/workspace', state: 'active', version: 1 }],
    conversations: [],
  };
  sessions.useSessionsStore.setState({
    conversations: {},
    order: [],
    activeId: null,
    worktreeStatuses: {},
    workspaceRevisionByConversation: {},
  });
  settings.useSettingsStore.setState({
    projects: [{ id: 'project', name: 'Project', path: '/workspace' }],
  });
});

describe('workspace branch switching', () => {
  async function seedShared() {
    const id = await seedLocalConversation();
    sessions.useSessionsStore.setState((state) => {
      const base = { ...state.conversations[id], started: true, sessionFile: '/tmp/session.jsonl' };
      return {
        conversations: {
          [id]: base,
          sibling: { ...base, id: 'sibling' },
          child: { ...base, id: 'child', parentId: id },
          unrelated: { ...base, id: 'unrelated', worktree: record('unrelated') },
        },
      };
    });
    return id;
  }
  it('gates every shared root and child, keeps idle workers and refreshes only the affected scope', async () => {
    const id = await seedShared();
    wtSwitch.mockImplementationOnce(async () => {
      const state = sessions.useSessionsStore.getState();
      expect(state.conversations[id].workspaceMigrating).toBe(true);
      expect(state.conversations.sibling.workspaceMigrating).toBe(true);
      expect(state.conversations.child.workspaceMigrating).toBe(true);
      const before = state.conversations[id].messages.length;
      expect(
        await state.send('blocked', { providerId: 'p', modelId: 'm', cwd: '/workspace' })
      ).toContain('progress');
      expect(sessions.useSessionsStore.getState().conversations[id].messages).toHaveLength(before);
      return {
        ok: true,
        value: {
          requestId: 'switch',
          currentBranch: 'feature',
          headCommit: 'abc',
          branches: [],
          affectedConversationIds: [id, 'sibling'],
          worktrees: [],
        },
      };
    });
    expect(
      (await sessions.useSessionsStore.getState().switchWorkspaceBranch(id, 'feature')).ok
    ).toBe(true);
    const state = sessions.useSessionsStore.getState();
    expect(agentRelease).not.toHaveBeenCalled();
    for (const key of [id, 'sibling', 'child']) {
      expect(state.conversations[key].started).toBe(true);
      expect(state.conversations[key].workspaceMigrating).toBeUndefined();
      expect(state.conversations[key].pendingWorkspaceNote).toContain('feature');
      expect(state.workspaceRevisionByConversation[key]).toBe(1);
    }
    expect(state.workspaceRevisionByConversation.unrelated).toBeUndefined();
    expect(state.conversations.unrelated.pendingWorkspaceNote).toBeUndefined();
    await state.send('root message', { providerId: 'p', modelId: 'm', cwd: '/workspace' });
    expect(agentPrompt).toHaveBeenLastCalledWith(
      id,
      expect.stringContaining('feature'),
      undefined,
      expect.any(String)
    );
    sessions.useSessionsStore.setState((current) => ({
      conversations: {
        ...current.conversations,
        [id]: { ...current.conversations[id], activeTabId: 'child' },
      },
    }));
    await sessions.useSessionsStore
      .getState()
      .send('child message', { providerId: 'p', modelId: 'm', cwd: '/workspace' });
    expect(agentPrompt).toHaveBeenLastCalledWith(
      'child',
      expect.stringContaining('feature'),
      undefined,
      expect.any(String)
    );
    expect(
      sessions.useSessionsStore.getState().conversations.child.pendingWorkspaceNote
    ).toBeUndefined();
  });
  it('refreshes real changed state even when post-switch synchronization fails', async () => {
    const id = await seedShared();
    wtSwitch.mockResolvedValueOnce({
      ok: false,
      code: 'git-error',
      error: 'resume failed',
      changed: {
        requestId: 'partial',
        currentBranch: 'feature',
        headCommit: 'abc',
        branches: [],
        affectedConversationIds: [id, 'sibling'],
        worktrees: [],
      },
    });
    expect(
      (await sessions.useSessionsStore.getState().switchWorkspaceBranch(id, 'feature')).ok
    ).toBe(false);
    expect(sessions.useSessionsStore.getState().workspaceRevisionByConversation.child).toBe(1);
    expect(sessions.useSessionsStore.getState().conversations[id].pendingWorkspaceNote).toContain(
      'feature'
    );
  });
  it('keeps only the prelocked scope blocked after uncertain freeze cleanup without a changed projection', async () => {
    const id = await seedShared();
    wtSwitch.mockResolvedValueOnce({
      ok: false,
      code: 'busy',
      workspaceBlocked: true,
      error: 'Restart EnsoCode to recover',
    });
    await sessions.useSessionsStore.getState().switchWorkspaceBranch(id, 'feature');
    const state = sessions.useSessionsStore.getState();
    expect(state.conversations[id].workspaceMigrating).toBe(true);
    expect(state.conversations.sibling.workspaceMigrating).toBe(true);
    expect(state.conversations.child.workspaceMigrating).toBe(true);
    expect(state.conversations.unrelated.workspaceMigrating).toBeUndefined();
    expect(state.conversations[id].pendingWorkspaceNote).toBeUndefined();
    expect(state.workspaceRevisionByConversation[id]).toBeUndefined();
    expect(
      await state.send('blocked', { providerId: 'p', modelId: 'm', cwd: '/workspace' })
    ).toContain('progress');
    expect(agentPrompt).not.toHaveBeenCalled();
    expect(sessions.useSessionsStore.getState().conversations[id].messages).toEqual([]);
  });
  it('keeps the local send gate when worker thaw remains uncertain', async () => {
    const id = await seedShared();
    wtSwitch.mockResolvedValueOnce({
      ok: false,
      code: 'git-error',
      error: 'restart required',
      changed: {
        requestId: 'stuck',
        currentBranch: 'feature',
        headCommit: 'abc',
        branches: [],
        affectedConversationIds: [id, 'sibling'],
        worktrees: [],
        blockedReason: 'busy',
      },
    });
    await sessions.useSessionsStore.getState().switchWorkspaceBranch(id, 'feature');
    expect(sessions.useSessionsStore.getState().conversations[id].workspaceMigrating).toBe(true);
    expect(
      await sessions.useSessionsStore
        .getState()
        .send('blocked', { providerId: 'p', modelId: 'm', cwd: '/workspace' })
    ).toContain('progress');
    expect(agentPrompt).not.toHaveBeenCalled();
  });
  it('clears only the consumed branch nonce and replaces older branch reminders', async () => {
    const id = await seedShared();
    sessions.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: { ...state.conversations[id], pendingWorkspaceNote: 'keep migration' },
      },
    }));
    for (const [requestId, branch] of [
      ['one', 'feature'],
      ['two', 'next'],
    ]) {
      wtSwitch.mockResolvedValueOnce({
        ok: true,
        value: {
          requestId,
          currentBranch: branch,
          headCommit: 'abc',
          branches: [],
          affectedConversationIds: [id],
          worktrees: [],
        },
      });
      await sessions.useSessionsStore.getState().switchWorkspaceBranch(id, branch);
    }
    expect(
      sessions.useSessionsStore.getState().conversations[id].pendingWorkspaceNote
    ).not.toContain('feature');
    onAgentEvent({
      type: 'workspace-branch-context-consumed',
      identity: { sessionId: id, generation: 'g' },
      seq: 1,
      requestId: 'one',
    });
    expect(sessions.useSessionsStore.getState().conversations[id].pendingWorkspaceNote).toContain(
      'next'
    );
    onAgentEvent({
      type: 'workspace-branch-context-consumed',
      identity: { sessionId: id, generation: 'g' },
      seq: 2,
      requestId: 'two',
    });
    expect(sessions.useSessionsStore.getState().conversations[id].pendingWorkspaceNote).toBe(
      'keep migration'
    );
  });
  it('does not reinstall a branch reminder consumed before the switch IPC returns', async () => {
    const id = await seedShared();
    wtSwitch.mockImplementationOnce(async () => {
      onAgentEvent({
        type: 'workspace-branch-context-consumed',
        identity: { sessionId: id, generation: 'g' },
        seq: 1,
        requestId: 'early',
      });
      return {
        ok: true,
        value: {
          requestId: 'early',
          currentBranch: 'feature',
          headCommit: 'abc',
          branches: [],
          affectedConversationIds: [id],
          worktrees: [],
        },
      };
    });
    expect(
      (await sessions.useSessionsStore.getState().switchWorkspaceBranch(id, 'feature')).ok
    ).toBe(true);
    expect(
      sessions.useSessionsStore.getState().conversations[id].pendingWorkspaceNote
    ).toBeUndefined();
    expect(sessions.useSessionsStore.getState().workspaceRevisionByConversation[id]).toBe(1);
  });
  it('blocks queued sends and goal kickoff before optimistic echo during switching', async () => {
    const id = await seedShared();
    sessions.useSessionsStore.getState().enqueueMessage(id, 'queued');
    wtSwitch.mockImplementationOnce(async () => {
      const state = sessions.useSessionsStore.getState();
      const messageId = state.conversations[id].queuedMessages![0].id;
      state.sendQueuedNow(id, messageId);
      state.setGoal(id, 'must not start');
      expect(agentPrompt).not.toHaveBeenCalled();
      expect(sessions.useSessionsStore.getState().conversations[id].messages).toEqual([]);
      expect(sessions.useSessionsStore.getState().conversations[id].queuedMessages).toHaveLength(1);
      return { ok: false, code: 'dirty', error: 'dirty' };
    });
    expect(await sessions.useSessionsStore.getState().switchWorkspaceBranch(id, 'feature')).toEqual(
      { ok: false, code: 'dirty', error: 'dirty' }
    );
  });
  it('does not change branches, reminders or revisions on Main refusal', async () => {
    const id = await seedShared();
    wtSwitch.mockResolvedValueOnce({
      ok: false,
      code: 'occupied',
      error: 'occupied',
      worktreeConversationId: 'other',
    });
    expect(
      await sessions.useSessionsStore.getState().switchWorkspaceBranch(id, 'feature')
    ).toMatchObject({ ok: false, code: 'occupied', worktreeConversationId: 'other' });
    const state = sessions.useSessionsStore.getState();
    expect(state.workspaceRevisionByConversation).toEqual({});
    expect(state.conversations[id].pendingWorkspaceNote).toBeUndefined();
    expect(state.conversations[id].workspaceMigrating).toBeUndefined();
  });
  it('rejects a running child before IPC and before optimistic echo', async () => {
    const id = await seedShared();
    sessions.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        child: { ...state.conversations.child, status: 'running' },
      },
    }));
    expect(
      (await sessions.useSessionsStore.getState().switchWorkspaceBranch(id, 'feature')).ok
    ).toBe(false);
    expect(wtSwitch).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('worktreeHasPendingWork：dirty 或 ahead>0 需要拦截', () => {
    expect(worktreeHasPendingWork({ exists: true, dirty: false, ahead: 0 })).toBe(false);
    expect(worktreeHasPendingWork({ exists: true, dirty: true, ahead: 0 })).toBe(true);
    expect(worktreeHasPendingWork({ exists: true, dirty: false, ahead: 2 })).toBe(true);
    expect(worktreeHasPendingWork(undefined)).toBe(false);
  });

  it('仅存在、干净且没有领先提交的 worktree 可自动清理', () => {
    expect(
      autoCleanupHelper.worktreeReadyToAutoCleanup?.({ exists: true, dirty: false, ahead: 0 })
    ).toBe(true);
  });

  it('未知、不存在、缺状态、脏或未合并的 worktree 均不可自动清理', () => {
    expect(
      [
        undefined,
        { dirty: false, ahead: 0 },
        { exists: false, dirty: false, ahead: 0 },
        { exists: true, dirty: true, ahead: 0 },
        { exists: true, dirty: false, ahead: 1 },
      ].map((status) => autoCleanupHelper.worktreeReadyToAutoCleanup?.(status))
    ).toEqual([false, false, false, false, false]);
  });

  it('迁移/回退提醒包含目标路径', () => {
    expect(workspaceMigratedNote('/managed/x')).toContain('/managed/x');
    expect(workspaceFallbackNote('/workspace')).toContain('/workspace');
  });
});

/** composer 选择器的入口：新建普通会话后在输入框下方切隔离（fresh 路径） */
async function seedIsolatedConversation(): Promise<string> {
  const id = await sessions.useSessionsStore.getState().newConversation('project');
  if (!id) throw new Error('conversation not created');
  const error = await sessions.useSessionsStore.getState().moveConversationToWorktree(id);
  if (error) throw new Error(error);
  return id;
}

describe('fresh 会话切隔离（composer 选择器路径）', () => {
  it('未开聊的会话：不查主树干净、不注迁移提醒，直接绑定 worktree', async () => {
    const id = await seedIsolatedConversation();
    const conversation = sessions.useSessionsStore.getState().conversations[id];
    expect(wtRepoClean).not.toHaveBeenCalled(); // 主树脏不脏与 fresh 隔离无关
    expect(conversation.worktree?.path).toBe(`/managed/${id}`);
    expect(conversation.pendingWorkspaceNote).toBeUndefined();
  });

  it('worktree 创建失败：返回错误，会话保持本地', async () => {
    const id = await sessions.useSessionsStore.getState().newConversation('project');
    if (!id) throw new Error('setup failed');
    wtCreate.mockResolvedValueOnce({ ok: false, error: 'not a git repository' } as never);
    const error = await sessions.useSessionsStore.getState().moveConversationToWorktree(id);
    expect(error).toContain('not a git repository');
    expect(sessions.useSessionsStore.getState().conversations[id].worktree).toBeUndefined();
  });
});

describe('send 使用 worktree cwd 并消费迁移提醒', () => {
  it('隔离会话 spawn 用 worktree.path 而非 target.cwd，pendingWorkspaceNote 前置一次', async () => {
    const id = await seedIsolatedConversation();
    sessions.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          ...state.conversations[id],
          pendingWorkspaceNote: '<workspace-migrated>note</workspace-migrated>',
        },
      },
      activeId: id,
    }));
    const error = await sessions.useSessionsStore
      .getState()
      .send('hello', { providerId: 'p', modelId: 'm', cwd: '/workspace' });
    expect(error).toBeNull();
    expect(agentSpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: `/managed/${id}` }));
    expect(agentPrompt).toHaveBeenCalledWith(
      id,
      expect.stringContaining('<workspace-migrated>'),
      undefined,
      expect.any(String)
    );
    expect(
      sessions.useSessionsStore.getState().conversations[id].pendingWorkspaceNote
    ).toBeUndefined();
    // 第二条不再带提醒
    await sessions.useSessionsStore
      .getState()
      .send('again', { providerId: 'p', modelId: 'm', cwd: '/workspace' });
    expect(agentPrompt).toHaveBeenLastCalledWith(id, 'again', undefined, expect.any(String));
  });

  const target = { providerId: 'p', modelId: 'm', cwd: '/workspace' };

  async function seedMovedConversation(): Promise<{ id: string; note: string }> {
    const id = await seedLocalConversation();
    sessions.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: { ...state.conversations[id], sessionFile: '/tmp/s.jsonl' },
      },
    }));
    const error = await sessions.useSessionsStore.getState().moveConversationToWorktree(id);
    if (error) throw new Error(error);
    return { id, note: workspaceMigratedNote(`/managed/${id}`) };
  }

  // 真实场景：会话移到 worktree 后发第一条消息，spawn 因凭证不可用返回 ok:false；
  // 用户重发成功，但提醒已被提前清掉，agent 不知道工作区已迁移，继续往旧工作区写
  it('spawn 失败后重发，prompt 仍前置迁移提醒', async () => {
    const { id, note } = await seedMovedConversation();
    agentSpawn.mockResolvedValueOnce({
      ok: false,
      error: 'model credentials unavailable',
    } as never);
    const store = sessions.useSessionsStore;
    expect(await store.getState().send('hello', target, undefined, id)).toBe(
      'model credentials unavailable'
    );
    expect(store.getState().conversations[id].messages).toHaveLength(0);
    expect(store.getState().conversations[id].draftText).toBe('hello');
    expect(agentPrompt).not.toHaveBeenCalled();
    expect(await store.getState().send('hello', target, undefined, id)).toBeNull();
    expect(agentPrompt).toHaveBeenCalledExactlyOnceWith(
      id,
      `${note}\n\nhello`,
      undefined,
      expect.any(String)
    );
    expect(store.getState().conversations[id].pendingWorkspaceNote).toBeUndefined();
  });

  it('投递被拒后重发，prompt 仍前置迁移提醒', async () => {
    const { id, note } = await seedMovedConversation();
    agentPrompt.mockResolvedValueOnce({ ok: false, error: 'session unavailable' } as never);
    const store = sessions.useSessionsStore;
    expect(await store.getState().send('hello', target, undefined, id)).toBe('session unavailable');
    expect(store.getState().conversations[id].messages).toHaveLength(0);
    expect(store.getState().conversations[id].draftText).toBe('hello');
    expect(await store.getState().send('hello', target, undefined, id)).toBeNull();
    expect(agentPrompt).toHaveBeenCalledTimes(2);
    expect(agentPrompt).toHaveBeenLastCalledWith(
      id,
      `${note}\n\nhello`,
      undefined,
      expect.any(String)
    );
  });

  // 真实场景：切分支给 coworker 也挂了提醒；coworker 未恢复时发送在回显前被拦，恢复后重发要带上提醒
  it('未恢复的 coworker 被拦下后重发，prompt 仍前置分支提醒', async () => {
    const parentId = await seedLocalConversation();
    const note = '<workspace-branch>feature</workspace-branch>';
    sessions.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        child: {
          ...state.conversations[parentId],
          id: 'child',
          parentId,
          started: false,
          pendingWorkspaceNote: note,
        },
      },
    }));
    const store = sessions.useSessionsStore;
    expect(await store.getState().send('hello', target, undefined, 'child')).toContain(
      'coworker not restored'
    );
    expect(store.getState().conversations.child.messages).toHaveLength(0);
    expect(agentPrompt).not.toHaveBeenCalled();
    store.setState((state) => ({
      conversations: {
        ...state.conversations,
        child: { ...state.conversations.child, started: true, status: 'idle' },
      },
    }));
    expect(await store.getState().send('hello', target, undefined, 'child')).toBeNull();
    expect(agentPrompt).toHaveBeenCalledExactlyOnceWith(
      'child',
      `${note}\n\nhello`,
      undefined,
      expect.any(String)
    );
  });
});

async function seedLocalConversation(): Promise<string> {
  const created = await sessions.useSessionsStore.getState().newConversation('project');
  if (!created) throw new Error('conversation not created');
  return created;
}

describe('moveConversationToWorktree（非 fresh：已有对话内容）', () => {
  it('主工作树脏 → 返回待确认哨兵，不建 worktree', async () => {
    const id = await seedLocalConversation();
    // 有 sessionFile = 非 fresh，走完整迁移语义（脏检查 + 提醒）
    sessions.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: { ...state.conversations[id], sessionFile: '/tmp/s.jsonl' },
      },
    }));
    wtRepoClean.mockResolvedValueOnce({ ok: true, value: false } as never);
    const error = await sessions.useSessionsStore.getState().moveConversationToWorktree(id);
    expect(error).toBe(DIRTY_MAIN_TREE);
    expect(wtCreate).not.toHaveBeenCalled();
    expect(sessions.useSessionsStore.getState().conversations[id].worktree).toBeUndefined();
  });

  it('主工作树脏 + 用户已确认 → 照常从 HEAD 建 worktree（脏改动留在主树）', async () => {
    const id = await seedLocalConversation();
    sessions.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: { ...state.conversations[id], sessionFile: '/tmp/s.jsonl' },
      },
    }));
    const error = await sessions.useSessionsStore
      .getState()
      .moveConversationToWorktree(id, { allowDirtyMainTree: true });
    expect(error).toBeNull();
    expect(wtRepoClean).not.toHaveBeenCalled(); // 已确认就不必再问
    const conversation = sessions.useSessionsStore.getState().conversations[id];
    expect(conversation.worktree?.path).toBe(`/managed/${id}`);
    expect(conversation.pendingWorkspaceNote).toContain(`/managed/${id}`);
  });

  it('干净 → 建 worktree、写迁移提醒；运行中的会话先 release', async () => {
    const id = await seedLocalConversation();
    sessions.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: { ...state.conversations[id], started: true, sessionFile: '/tmp/s.jsonl' },
      },
    }));
    const error = await sessions.useSessionsStore.getState().moveConversationToWorktree(id);
    expect(error).toBeNull();
    expect(agentRelease).toHaveBeenCalledWith(id);
    const conversation = sessions.useSessionsStore.getState().conversations[id];
    expect(conversation.worktree?.path).toBe(`/managed/${id}`);
    expect(conversation.started).toBe(false);
    expect(conversation.pendingWorkspaceNote).toContain(`/managed/${id}`);
  });

  it('已隔离的会话拒绝重复迁移', async () => {
    const id = await seedIsolatedConversation();
    const error = await sessions.useSessionsStore.getState().moveConversationToWorktree(id);
    expect(error).toBeTruthy();
  });
});

describe('cleanupWorktree', () => {
  it('移除 worktree、清字段、写回退提醒；运行中先 release', async () => {
    const id = await seedIsolatedConversation();
    sessions.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: { ...state.conversations[id], started: true },
      },
    }));
    const error = await sessions.useSessionsStore.getState().cleanupWorktree(id);
    expect(error).toBeNull();
    expect(agentRelease).toHaveBeenCalledWith(id);
    expect(wtRemove).toHaveBeenCalledWith(id);
    const conversation = sessions.useSessionsStore.getState().conversations[id];
    expect(conversation.worktree).toBeUndefined();
    expect(conversation.started).toBe(false);
    expect(conversation.pendingWorkspaceNote).toContain('/workspace');
  });
});

describe('resumeConversation 的 worktree 校验', () => {
  async function seedResumable(): Promise<string> {
    const id = await seedIsolatedConversation();
    sessions.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          ...state.conversations[id],
          started: false,
          sessionFile: '/tmp/s.jsonl',
          lastProviderId: undefined,
          lastModelId: undefined,
        },
      },
    }));
    settings.useSettingsStore.setState({
      projects: [{ id: 'project', name: 'Project', path: '/workspace' }],
      defaultModel: { providerId: 'p', modelId: 'm' },
      providers: [
        {
          id: 'p',
          name: 'P',
          enabled: true,
          apiKey: 'k',
          models: [{ id: 'm', enabled: true }],
        },
      ],
    } as never);
    return id;
  }

  it('worktree 存在 → 用 worktree.path resume', async () => {
    const id = await seedResumable();
    await sessions.useSessionsStore.getState().resumeConversation(id);
    expect(agentSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: `/managed/${id}`, resumeFile: '/tmp/s.jsonl' })
    );
  });

  it('resume spawn 失败后再调 resumeConversation 仍会重试', async () => {
    const id = await seedResumable();
    agentSpawn.mockResolvedValueOnce({ ok: false });
    await sessions.useSessionsStore.getState().resumeConversation(id);
    expect(sessions.useSessionsStore.getState().conversations[id].status).toBe('failed');
    agentSpawn.mockResolvedValueOnce({ ok: true });
    await sessions.useSessionsStore.getState().resumeConversation(id);
    expect(agentSpawn).toHaveBeenCalledTimes(2);
    expect(sessions.useSessionsStore.getState().conversations[id].status).not.toBe('failed');
  });

  it('worktree 丢失 → 不 spawn，标记 worktreeMissing', async () => {
    const id = await seedResumable();
    wtStatus.mockResolvedValueOnce({
      ok: true,
      value: { exists: false, dirty: false, ahead: 0 },
    });
    await sessions.useSessionsStore.getState().resumeConversation(id);
    expect(agentSpawn).not.toHaveBeenCalled();
    expect(sessions.useSessionsStore.getState().conversations[id].worktreeMissing).toBe(true);
  });

  it('rebuildWorktree 更新路径并清除 missing 标记', async () => {
    const id = await seedResumable();
    sessions.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: { ...state.conversations[id], worktreeMissing: true },
      },
    }));
    const error = await sessions.useSessionsStore.getState().rebuildWorktree(id);
    expect(error).toBeNull();
    const conversation = sessions.useSessionsStore.getState().conversations[id];
    expect(conversation.worktree?.path).toBe(`/managed/rebuilt-${id}`);
    expect(conversation.worktreeMissing).toBeUndefined();
  });

  it('fallbackToMainWorkspace 清 worktree 并写回退提醒', async () => {
    const id = await seedResumable();
    sessions.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: { ...state.conversations[id], worktreeMissing: true },
      },
    }));
    await sessions.useSessionsStore.getState().fallbackToMainWorkspace(id);
    const conversation = sessions.useSessionsStore.getState().conversations[id];
    expect(wtRemove).toHaveBeenCalledWith(id);
    expect(conversation.worktree).toBeUndefined();
    expect(conversation.worktreeMissing).toBeUndefined();
    expect(conversation.pendingWorkspaceNote).toContain('/workspace');
  });
});

describe('removeConversation 连带清理 worktree', () => {
  it('waits for worker release before removing the worktree and preserves metadata on failure', async () => {
    const id = await seedIsolatedConversation();
    sessions.useSessionsStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        [id]: { ...state.conversations[id], started: true },
      },
    }));
    let finish!: () => void;
    agentRelease.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: false });
        })
    );
    sessions.useSessionsStore.getState().removeConversation(id);
    expect(wtRemove).not.toHaveBeenCalled();
    expect(sessions.useSessionsStore.getState().conversations[id].worktree).toBeDefined();
    finish();
    await vi.waitFor(() =>
      expect(sessions.useSessionsStore.getState().conversations[id]?.error).toBeTruthy()
    );
    expect(wtRemove).not.toHaveBeenCalled();
    expect(sessions.useSessionsStore.getState().conversations[id].worktree).toBeDefined();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        description: sessions.useSessionsStore.getState().conversations[id].error,
      })
    );
  });
  it('删除隔离会话时调用 worktree.remove', async () => {
    const id = await seedIsolatedConversation();
    sessions.useSessionsStore.getState().removeConversation(id);
    expect(wtRemove).toHaveBeenCalledWith(id);
  });
});

describe('refreshWorktreeStatuses', () => {
  it('repairs stale name and path from the Main registry', async () => {
    const id = await seedIsolatedConversation();
    const current = { ...record(id), name: 'Main name', path: '/rebuilt' };
    wtList.mockResolvedValueOnce([current]);
    await sessions.useSessionsStore.getState().refreshWorktreeStatuses();
    expect(sessions.useSessionsStore.getState().conversations[id].worktree).toEqual(current);
  });

  it('does not resurrect a fork target deleted during registry hydration', async () => {
    const id = await seedLocalConversation();
    let finish!: () => void;
    wtGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(record(id));
        })
    );
    onAgentEvent({
      type: 'fork-done',
      identity: { sessionId: 'source', generation: 'g' },
      seq: 1,
      targetConversationId: id,
      sessionFile: '/fork.jsonl',
      entryId: 'entry',
    });
    sessions.useSessionsStore.getState().removeConversation(id);
    finish();
    await Promise.resolve();
    expect(sessions.useSessionsStore.getState().conversations[id]).toBeUndefined();
    expect(agentSpawn).not.toHaveBeenCalled();
  });

  it('fork completion restores the target registry even if its source was removed', async () => {
    const id = await seedIsolatedConversation();
    const current = { ...record('removed-source'), conversationId: id };
    wtGet.mockResolvedValueOnce(current);
    onAgentEvent({
      type: 'fork-done',
      identity: { sessionId: 'removed-source', generation: 'g' },
      seq: 1,
      targetConversationId: id,
      sessionFile: '/fork.jsonl',
      entryId: 'entry',
    });
    await vi.waitFor(() =>
      expect(sessions.useSessionsStore.getState().conversations[id].worktree).toEqual(current)
    );
  });

  it('拉取所有隔离会话状态进 worktreeStatuses', async () => {
    const id = await seedIsolatedConversation();
    wtStatus.mockResolvedValueOnce({ ok: true, value: { exists: true, dirty: true, ahead: 3 } });
    await sessions.useSessionsStore.getState().refreshWorktreeStatuses();
    expect(sessions.useSessionsStore.getState().worktreeStatuses[id]).toEqual({
      exists: true,
      dirty: true,
      ahead: 3,
    });
  });

  it('刷新状态不自动清理已合并 worktree', async () => {
    const id = await seedIsolatedConversation();
    settings.useSettingsStore.setState({ autoArchiveMergedWorktrees: true } as never);
    await sessions.useSessionsStore.getState().refreshWorktreeStatuses();
    expect(wtRemove).not.toHaveBeenCalled();
    expect(sessions.useSessionsStore.getState().conversations[id].archived).toBeUndefined();
  });
});

describe('existing worktree conversations', () => {
  it('binding gates sends before optimistic echo and does not resurrect a removed draft', async () => {
    const source = await seedIsolatedConversation();
    const id = (await sessions.useSessionsStore.getState().newConversation('project'))!;
    wtBind.mockImplementationOnce(async (targetId, sourceId) => {
      const error = await sessions.useSessionsStore
        .getState()
        .send('hello', { providerId: 'p', modelId: 'm', cwd: '/workspace' });
      expect(error).toBeTruthy();
      expect(sessions.useSessionsStore.getState().conversations[id].messages).toEqual([]);
      expect(agentSpawn).not.toHaveBeenCalled();
      sessions.useSessionsStore.getState().removeConversation(id);
      return { ok: true, value: { ...record(sourceId), conversationId: targetId } };
    });
    expect(
      await sessions.useSessionsStore.getState().attachConversationToWorktree(id, source)
    ).toBeTruthy();
    expect(sessions.useSessionsStore.getState().conversations[id]).toBeUndefined();
    expect(wtRemove).toHaveBeenCalledWith(id);
  });

  it('new local drafts never reuse isolated drafts', async () => {
    const source = await seedIsolatedConversation();
    const id = await sessions.useSessionsStore.getState().newConversation('project');
    expect(id).not.toBe(source);
    expect(sessions.useSessionsStore.getState().conversations[id!].worktree).toBeUndefined();
  });

  it('creates a distinct empty conversation and binds before publishing active', async () => {
    const source = await seedIsolatedConversation();
    wtBind.mockImplementationOnce(async (id, sourceId) => {
      expect(sessions.useSessionsStore.getState().activeId).toBe(source);
      expect(sessions.useSessionsStore.getState().conversations[id]).toBeUndefined();
      return { ok: true, value: { ...record(sourceId), conversationId: id } };
    });
    const id = await sessions.useSessionsStore
      .getState()
      .newConversation('project', { worktreeFromConversationId: source });
    expect(id).not.toBe(source);
    const created = sessions.useSessionsStore.getState().conversations[id!];
    expect(created.worktree?.path).toBe(record(source).path);
    expect(created.messages).toEqual([]);
    expect(created.sessionFile).toBeUndefined();
    expect(created.pendingWorkspaceNote).toBeUndefined();
    expect(created.forkedFromConversationId).toBeUndefined();
    expect(sessions.useSessionsStore.getState().activeId).toBe(id);
  });

  it('binding failure leaves the active session unchanged and purges the temporary authority', async () => {
    const source = await seedIsolatedConversation();
    wtBind.mockResolvedValueOnce({ ok: false, error: 'missing' } as never);
    const id = await sessions.useSessionsStore
      .getState()
      .newConversation('project', { worktreeFromConversationId: source });
    expect(id).toBeNull();
    expect(sessions.useSessionsStore.getState().activeId).toBe(source);
    expect(sessions.useSessionsStore.getState().order).toEqual([source]);
    expect(removeAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-2' })
    );
  });

  it('attaches only fresh local drafts without migrating history', async () => {
    const source = await seedIsolatedConversation();
    const id = (await sessions.useSessionsStore.getState().newConversation('project'))!;
    expect(
      await sessions.useSessionsStore.getState().attachConversationToWorktree(id, source)
    ).toBeNull();
    const target = sessions.useSessionsStore.getState().conversations[id];
    expect(target.worktree?.path).toBe(record(source).path);
    expect(target.pendingWorkspaceNote).toBeUndefined();
    expect(target.workspaceMigrating).toBeUndefined();
    expect(agentRelease).not.toHaveBeenCalled();
  });

  it.each([
    { started: true },
    { spawning: true },
    { workspaceMigrating: true },
    { sessionFile: '/s' },
    { parentId: 'parent' },
    { historyOnly: true },
  ])('rejects nonfresh targets: %j', async (patch) => {
    const source = await seedIsolatedConversation();
    const id = (await sessions.useSessionsStore.getState().newConversation('project'))!;
    sessions.useSessionsStore.setState((state) => ({
      conversations: { ...state.conversations, [id]: { ...state.conversations[id], ...patch } },
    }));
    expect(
      await sessions.useSessionsStore.getState().attachConversationToWorktree(id, source)
    ).toBeTruthy();
    expect(wtBind).not.toHaveBeenCalled();
  });

  it('rename updates every returned shared binding and rebuild synchronizes their paths', async () => {
    const source = await seedIsolatedConversation();
    const id = (await sessions.useSessionsStore
      .getState()
      .newConversation('project', { worktreeFromConversationId: source }))!;
    wtRename.mockResolvedValueOnce({
      ok: true,
      value: [source, id].map((conversationId) => ({
        ...record(source),
        conversationId,
        name: 'Feature',
      })),
    });
    expect(await sessions.useSessionsStore.getState().renameWorktree(id, 'Feature')).toBeNull();
    expect(sessions.useSessionsStore.getState().conversations[source].worktree?.name).toBe(
      'Feature'
    );
    expect(sessions.useSessionsStore.getState().conversations[id].worktree?.name).toBe('Feature');
    await sessions.useSessionsStore.getState().rebuildWorktree(source);
    expect(sessions.useSessionsStore.getState().conversations[id].worktree?.path).toBe(
      `/managed/rebuilt-${source}`
    );
    expect(sessions.useSessionsStore.getState().conversations[id].worktree?.conversationId).toBe(
      id
    );
  });
});
