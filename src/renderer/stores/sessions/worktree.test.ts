/**
 * 会话级 worktree 隔离的 store 逻辑测试。
 * 产品决策见 docs/plans/2026-08-22-enso-code-design.md「trust 与 isolation」。
 */

import type { SourceAuthorityProjection } from '@shared/types/agent';
import type { SessionWorktree, WorktreeStatus } from '@shared/types/worktree';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SettingsModule from '../settings';
import type * as SessionsModule from './index';
import { workspaceFallbackNote, workspaceMigratedNote, worktreeHasPendingWork } from './worktree';

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

const createConversation = vi.fn(async () => {
  const value = {
    conversationId: 'conv-1',
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
      endConversation: vi.fn(async () => ({ accepted: false as const, error: 'test' })),
      removeConversation: vi.fn(async () => ({ accepted: false as const, error: 'test' })),
      updateConversationSelection: vi.fn(),
    },
    worktree: {
      create: wtCreate,
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
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
  });
  settings.useSettingsStore.setState({
    projects: [{ id: 'project', name: 'Project', path: '/workspace' }],
  });
});

describe('helpers', () => {
  it('worktreeHasPendingWork：dirty 或 ahead>0 需要拦截', () => {
    expect(worktreeHasPendingWork({ exists: true, dirty: false, ahead: 0 })).toBe(false);
    expect(worktreeHasPendingWork({ exists: true, dirty: true, ahead: 0 })).toBe(true);
    expect(worktreeHasPendingWork({ exists: true, dirty: false, ahead: 2 })).toBe(true);
    expect(worktreeHasPendingWork(undefined)).toBe(false);
  });

  it('迁移/回退提醒包含目标路径', () => {
    expect(workspaceMigratedNote('/managed/x')).toContain('/managed/x');
    expect(workspaceFallbackNote('/workspace')).toContain('/workspace');
  });
});

describe('newIsolatedConversation', () => {
  it('创建会话并绑定 worktree', async () => {
    const id = await sessions.useSessionsStore.getState().newIsolatedConversation('project');
    expect(id).toBe('conv-1');
    expect(wtCreate).toHaveBeenCalledWith('conv-1', 'project');
    const conversation = sessions.useSessionsStore.getState().conversations['conv-1'];
    expect(conversation.worktree?.path).toBe('/managed/conv-1');
  });

  it('worktree 创建失败：会话移除并返回 null', async () => {
    wtCreate.mockResolvedValueOnce({ ok: false, error: 'not a git repository' } as never);
    const id = await sessions.useSessionsStore.getState().newIsolatedConversation('project');
    expect(id).toBeNull();
    expect(sessions.useSessionsStore.getState().conversations['conv-1']).toBeUndefined();
  });
});

describe('send 使用 worktree cwd 并消费迁移提醒', () => {
  it('隔离会话 spawn 用 worktree.path 而非 target.cwd，pendingWorkspaceNote 前置一次', async () => {
    const id = await sessions.useSessionsStore.getState().newIsolatedConversation('project');
    if (!id) throw new Error('setup failed');
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
      undefined
    );
    expect(
      sessions.useSessionsStore.getState().conversations[id].pendingWorkspaceNote
    ).toBeUndefined();
    // 第二条不再带提醒
    await sessions.useSessionsStore
      .getState()
      .send('again', { providerId: 'p', modelId: 'm', cwd: '/workspace' });
    expect(agentPrompt).toHaveBeenLastCalledWith(id, 'again', undefined);
  });
});

async function seedLocalConversation(id = 'conv-1'): Promise<string> {
  const created = await sessions.useSessionsStore.getState().newConversation('project');
  if (!created) throw new Error('conversation not created');
  return created;
}

describe('moveConversationToWorktree', () => {
  it('主工作树脏 → 拒绝并返回错误', async () => {
    const id = await seedLocalConversation();
    wtRepoClean.mockResolvedValueOnce({ ok: true, value: false } as never);
    const error = await sessions.useSessionsStore.getState().moveConversationToWorktree(id);
    expect(error).toBeTruthy();
    expect(sessions.useSessionsStore.getState().conversations[id].worktree).toBeUndefined();
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
    const id = await sessions.useSessionsStore.getState().newIsolatedConversation('project');
    if (!id) throw new Error('setup failed');
    const error = await sessions.useSessionsStore.getState().moveConversationToWorktree(id);
    expect(error).toBeTruthy();
  });
});

describe('cleanupWorktree', () => {
  it('移除 worktree、清字段、写回退提醒；运行中先 release', async () => {
    const id = await sessions.useSessionsStore.getState().newIsolatedConversation('project');
    if (!id) throw new Error('setup failed');
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
    const id = await sessions.useSessionsStore.getState().newIsolatedConversation('project');
    if (!id) throw new Error('setup failed');
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
  it('删除隔离会话时调用 worktree.remove', async () => {
    const id = await sessions.useSessionsStore.getState().newIsolatedConversation('project');
    if (!id) throw new Error('setup failed');
    sessions.useSessionsStore.getState().removeConversation(id);
    expect(wtRemove).toHaveBeenCalledWith(id);
  });
});

describe('refreshWorktreeStatuses', () => {
  it('拉取所有隔离会话状态进 worktreeStatuses', async () => {
    const id = await sessions.useSessionsStore.getState().newIsolatedConversation('project');
    if (!id) throw new Error('setup failed');
    wtStatus.mockResolvedValueOnce({ ok: true, value: { exists: true, dirty: true, ahead: 3 } });
    await sessions.useSessionsStore.getState().refreshWorktreeStatuses();
    expect(sessions.useSessionsStore.getState().worktreeStatuses[id]).toEqual({
      exists: true,
      dirty: true,
      ahead: 3,
    });
  });
});
