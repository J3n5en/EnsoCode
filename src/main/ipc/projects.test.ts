import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  createProject: vi.fn(),
  selectProject: vi.fn(),
  removeProject: vi.fn(),
  projection: vi.fn(),
  removeConversationSessionFiles: vi.fn(),
  project: vi.fn(),
  conversation: vi.fn(),
  sessionWorktree: vi.fn(),
  statSync: vi.fn(),
  openPath: vi.fn(),
  listApps: vi.fn(),
  openInApp: vi.fn(),
  listProjectCodeSources: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: mocks.statSync };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  app: { getPath: () => '/tmp/enso-test-user-data' },
  shell: { openPath: mocks.openPath },
}));
vi.mock('../services/sessionFileCleanup', () => ({
  removeConversationSessionFiles: mocks.removeConversationSessionFiles,
}));
vi.mock('../services/renderers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/renderers')>()),
  isMainRenderer: (id: number) => id === 1,
}));
vi.mock('./agent', () => ({
  getSourceAuthorityRegistry: () => ({
    createProject: mocks.createProject,
    selectProject: mocks.selectProject,
    removeProject: mocks.removeProject,
    projection: mocks.projection,
    project: mocks.project,
    conversation: mocks.conversation,
    // 删除会话会清掉所有秘书的关注；秘书上下文登记隐藏项目时调用它
    ensureSecretaryProject: () => undefined,
  }),
}));
vi.mock('./worktree', () => ({ sessionWorktree: mocks.sessionWorktree }));
vi.mock('../../agent/projectCode', () => ({
  listProjectCodeSources: mocks.listProjectCodeSources,
}));
vi.mock('../services/recentProjects', () => ({ getRecentProjects: () => [] }));
vi.mock('../services/openInApps', () => ({
  openInApps: { list: mocks.listApps, open: mocks.openInApp },
}));

import { IPC_CHANNELS } from '@shared/types';
import { registerProjectHandlers } from './projects';

const event = (id: number) => ({ sender: { id } });

describe('project authority IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.createProject.mockReset().mockReturnValue({ accepted: true, value: {} });
    mocks.selectProject.mockReset().mockReturnValue({ accepted: true, value: {} });
    mocks.removeProject.mockReset().mockReturnValue({ accepted: true, value: {} });
    mocks.projection.mockReset().mockReturnValue({ projects: [], conversations: [] });
    mocks.removeConversationSessionFiles.mockReset();
    mocks.project.mockReset().mockReturnValue({
      projectId: 'project-1',
      state: 'active',
      kind: 'local',
      canonicalPath: '/repo/enso',
    });
    mocks.conversation.mockReset().mockReturnValue({
      conversationId: 'conversation-1',
      projectId: 'project-1',
      kind: 'root',
      lifecycle: 'ready',
    });
    mocks.sessionWorktree.mockReset();
    mocks.statSync.mockReset().mockReturnValue({ isDirectory: () => true });
    mocks.openPath.mockReset().mockResolvedValue('');
    mocks.listApps
      .mockReset()
      .mockResolvedValue([{ id: 'vscode', name: 'VS Code', kind: 'editor' }]);
    mocks.openInApp.mockReset().mockResolvedValue({ ok: true });
    registerProjectHandlers();
  });

  it('accepts strict dedicated mutations only from MainWindow', async () => {
    const create = mocks.handlers.get(IPC_CHANNELS.SOURCE_PROJECT_CREATE)!;
    await expect(
      create(event(1), { requestId: 'request', path: '/project' })
    ).resolves.toMatchObject({
      accepted: true,
    });
    expect(mocks.createProject).toHaveBeenCalledWith({
      requestId: 'request',
      path: '/project',
    });
    await expect(create(event(2), { requestId: 'request', path: '/forged' })).resolves.toEqual({
      accepted: false,
      error: 'Invalid project request.',
    });
    await expect(
      create(event(1), {
        requestId: 'request',
        path: '/project',
        target: '/forged',
      })
    ).resolves.toEqual({ accepted: false, error: 'Invalid project request.' });
  });

  it('passes exact versioned select/remove mutations', () => {
    const select = mocks.handlers.get(IPC_CHANNELS.SOURCE_PROJECT_SELECT)!;
    const remove = mocks.handlers.get(IPC_CHANNELS.SOURCE_PROJECT_REMOVE)!;
    const projectId = '11111111-1111-4111-8111-111111111111';
    expect(select(event(1), { requestId: 'select', projectId, version: 2 })).toMatchObject({
      accepted: true,
    });
    expect(remove(event(1), { requestId: 'remove', projectId, version: 2 })).toMatchObject({
      accepted: true,
    });
    expect(mocks.selectProject).toHaveBeenCalledWith({
      requestId: 'select',
      projectId,
      version: 2,
    });
    expect(mocks.removeProject).toHaveBeenCalledWith({
      requestId: 'remove',
      projectId,
      version: 2,
    });
  });

  it('删除项目时级联清理该项目全部会话的 session 文件', () => {
    const remove = mocks.handlers.get(IPC_CHANNELS.SOURCE_PROJECT_REMOVE)!;
    const projectId = '11111111-1111-4111-8111-111111111111';
    mocks.projection.mockReturnValue({
      projects: [],
      conversations: [
        {
          conversationId: 'conversation-a',
          projectId,
          sessionFile: '/tmp/a.jsonl',
        },
        { conversationId: 'conversation-b', projectId },
        { conversationId: 'conversation-other', projectId: 'other-project' },
      ],
    });
    expect(remove(event(1), { requestId: 'remove', projectId, version: 2 })).toMatchObject({
      accepted: true,
    });
    expect(mocks.removeConversationSessionFiles).toHaveBeenCalledTimes(2);
    expect(mocks.removeConversationSessionFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-a',
        sessionFile: '/tmp/a.jsonl',
      })
    );
    expect(mocks.removeConversationSessionFiles).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conversation-b' })
    );
  });

  it('reveal 拒绝非主窗口 webContents 的请求', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    await expect(reveal(event(2), { projectId: 'project-1' })).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    });
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('reveal 对非对象请求或非法 projectId 返回 invalid', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    for (const request of [
      undefined,
      null,
      'project-1',
      {},
      { projectId: 42 },
      { projectId: '' },
      { projectId: 'project-1', conversationId: 42 },
      { projectId: 'project-1', conversationId: '' },
    ]) {
      await expect(reveal(event(1), request)).resolves.toEqual({
        ok: false,
        error: 'invalid',
      });
    }
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('reveal 对不存在或非 active 的项目返回 unavailable', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    mocks.project.mockReturnValue(undefined);
    await expect(reveal(event(1), { projectId: 'missing' })).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    });
    mocks.project.mockReturnValue({
      state: 'removed',
      kind: 'local',
      canonicalPath: '/repo/enso',
    });
    await expect(reveal(event(1), { projectId: 'project-1' })).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    });
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('reveal 对 ssh 项目返回 unsupported', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    mocks.project.mockReturnValue({
      state: 'active',
      kind: 'ssh',
      canonicalPath: '/remote/repo',
    });
    await expect(reveal(event(1), { projectId: 'project-1' })).resolves.toEqual({
      ok: false,
      error: 'unsupported',
    });
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('reveal 用 canonicalPath 调用 openPath 并在成功时返回 ok', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    await expect(reveal(event(1), { projectId: 'project-1' })).resolves.toEqual({ ok: true });
    expect(mocks.openPath).toHaveBeenCalledWith('/repo/enso');
  });

  it('reveal 会话优先打开 Main 登记的 Windows worktree 路径', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    const repoPath = String.raw`C:\Users\enso\project`;
    const worktreePath = String.raw`D:\EnsoCode\worktrees\project-1\conversation-1`;
    mocks.project.mockReturnValue({
      projectId: 'project-1',
      state: 'active',
      kind: 'local',
      canonicalPath: repoPath,
    });
    mocks.sessionWorktree.mockReturnValue({
      conversationId: 'conversation-1',
      projectId: 'project-1',
      repoPath,
      path: worktreePath,
    });

    await expect(
      reveal(event(1), { projectId: 'project-1', conversationId: 'conversation-1' })
    ).resolves.toEqual({ ok: true });
    expect(mocks.openPath).toHaveBeenCalledWith(worktreePath);
  });

  it('reveal 会话无 worktree 时打开权威项目根目录', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    await expect(
      reveal(event(1), {
        projectId: 'project-1',
        conversationId: 'conversation-1',
        path: '../../forged',
      })
    ).resolves.toEqual({ ok: true });
    expect(mocks.openPath).toHaveBeenCalledWith('/repo/enso');
  });

  it.each([
    ['不存在', undefined],
    ['已结束', { projectId: 'project-1', kind: 'root', lifecycle: 'ended' }],
    ['归属其它项目', { projectId: 'project-2', kind: 'root', lifecycle: 'ready' }],
    ['子会话', { projectId: 'project-1', kind: 'child', lifecycle: 'ready' }],
  ])('reveal 拒绝%s的会话', async (_label, conversation) => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    mocks.conversation.mockReturnValue(conversation);
    await expect(
      reveal(event(1), { projectId: 'project-1', conversationId: 'conversation-1' })
    ).resolves.toEqual({ ok: false, error: 'unavailable' });
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it.each([
    {
      conversationId: 'conversation-1',
      projectId: 'project-2',
      repoPath: '/repo/enso',
      path: '/forged/project',
    },
    {
      conversationId: 'conversation-1',
      projectId: 'project-1',
      repoPath: '/repo/other',
      path: '/forged/project',
    },
  ])('reveal 拒绝与权威项目不匹配的 worktree 记录', async (worktree) => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    mocks.sessionWorktree.mockReturnValue(worktree);
    await expect(
      reveal(event(1), { projectId: 'project-1', conversationId: 'conversation-1' })
    ).resolves.toEqual({ ok: false, error: 'unavailable' });
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('reveal 工作目录已丢失时返回 unavailable，不回退项目根目录', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    mocks.sessionWorktree.mockReturnValue({
      conversationId: 'conversation-1',
      projectId: 'project-1',
      repoPath: '/repo/enso',
      path: '/worktrees/missing',
    });
    mocks.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    await expect(
      reveal(event(1), { projectId: 'project-1', conversationId: 'conversation-1' })
    ).resolves.toEqual({ ok: false, error: 'unavailable' });
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('reveal 将 shell.openPath 异常转换为结构化失败', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    mocks.openPath.mockRejectedValue(new Error('Failed to open path'));
    await expect(reveal(event(1), { projectId: 'project-1' })).resolves.toEqual({
      ok: false,
      error: 'Failed to open path',
    });
  });

  it('reveal 在 openPath 返回失败原因时透传该原因', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    mocks.openPath.mockResolvedValue('Failed to open path');
    await expect(reveal(event(1), { projectId: 'project-1' })).resolves.toEqual({
      ok: false,
      error: 'Failed to open path',
    });
  });

  it('open-in 应用列表只对主窗口开放', async () => {
    const list = mocks.handlers.get(IPC_CHANNELS.PROJECTS_OPEN_IN_APPS)!;
    await expect(list(event(2))).resolves.toEqual([]);
    expect(mocks.listApps).not.toHaveBeenCalled();
    await expect(list(event(1))).resolves.toEqual([
      { id: 'vscode', name: 'VS Code', kind: 'editor' },
    ]);
  });

  it('reveal 带 appId 时用指定应用打开 Main 推导的工作目录', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    mocks.sessionWorktree.mockReturnValue({
      conversationId: 'conversation-1',
      projectId: 'project-1',
      repoPath: '/repo/enso',
      path: '/worktrees/conversation-1',
    });
    await expect(
      reveal(event(1), {
        projectId: 'project-1',
        conversationId: 'conversation-1',
        appId: 'vscode',
      })
    ).resolves.toEqual({ ok: true });
    expect(mocks.openInApp).toHaveBeenCalledWith('vscode', '/worktrees/conversation-1');
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it('reveal 透传应用启动失败', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    mocks.openInApp.mockResolvedValue({ ok: false, error: 'unavailable' });
    await expect(reveal(event(1), { projectId: 'project-1', appId: 'ghost' })).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('reveal 对非法 appId 返回 invalid，ssh 项目返回 unsupported', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    for (const appId of [42, '', null]) {
      await expect(reveal(event(1), { projectId: 'project-1', appId })).resolves.toEqual({
        ok: false,
        error: 'invalid',
      });
    }
    mocks.project.mockReturnValue({ state: 'active', kind: 'ssh', canonicalPath: '/remote' });
    await expect(reveal(event(1), { projectId: 'project-1', appId: 'vscode' })).resolves.toEqual({
      ok: false,
      error: 'unsupported',
    });
    expect(mocks.openInApp).not.toHaveBeenCalled();
  });

  it('removeProject 被拒绝时不清理任何文件', () => {
    const remove = mocks.handlers.get(IPC_CHANNELS.SOURCE_PROJECT_REMOVE)!;
    const projectId = '11111111-1111-4111-8111-111111111111';
    mocks.projection.mockReturnValue({
      projects: [],
      conversations: [{ conversationId: 'conversation-a', projectId }],
    });
    mocks.removeProject.mockReturnValue({ accepted: false, error: 'stale' });
    expect(remove(event(1), { requestId: 'remove', projectId, version: 1 })).toMatchObject({
      accepted: false,
    });
    expect(mocks.removeConversationSessionFiles).not.toHaveBeenCalled();
  });

  it('code-sources 按权威记录解析会话 worktree 目录，拒绝非主窗口、ssh 与脏请求', () => {
    const codeSources = mocks.handlers.get(IPC_CHANNELS.PROJECTS_CODE_SOURCES)!;
    mocks.statSync.mockReturnValue({ isDirectory: () => true });
    mocks.listProjectCodeSources.mockReset().mockReturnValue(['.pi/extensions/a.ts']);
    mocks.sessionWorktree.mockReturnValue({
      conversationId: 'conversation-1',
      projectId: 'project-1',
      repoPath: '/repo/enso',
      path: '/repo/enso-wt',
    });
    expect(
      codeSources(event(1), { projectId: 'project-1', conversationId: 'conversation-1' })
    ).toEqual(['.pi/extensions/a.ts']);
    expect(mocks.listProjectCodeSources).toHaveBeenCalledWith('/repo/enso-wt');

    mocks.listProjectCodeSources.mockClear();
    expect(codeSources(event(2), { projectId: 'project-1' })).toEqual([]);
    expect(codeSources(event(1), { projectId: '' })).toEqual([]);
    expect(codeSources(event(1), { projectId: 'project-1', appId: 'x' })).toEqual([]);
    mocks.project.mockReturnValue({ state: 'active', kind: 'ssh', canonicalPath: '/remote' });
    expect(codeSources(event(1), { projectId: 'project-1' })).toEqual([]);
    expect(mocks.listProjectCodeSources).not.toHaveBeenCalled();
  });
});
