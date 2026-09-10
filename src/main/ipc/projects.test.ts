import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  createProject: vi.fn(),
  selectProject: vi.fn(),
  removeProject: vi.fn(),
  projection: vi.fn(),
  removeConversationSessionFiles: vi.fn(),
  project: vi.fn(),
  openPath: vi.fn(),
}));

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
vi.mock('../windows/MainWindow', () => ({
  isMainWebContents: (id: number) => id === 1,
}));
vi.mock('./agent', () => ({
  getSourceAuthorityRegistry: () => ({
    createProject: mocks.createProject,
    selectProject: mocks.selectProject,
    removeProject: mocks.removeProject,
    projection: mocks.projection,
    project: mocks.project,
  }),
}));
vi.mock('../services/recentProjects', () => ({ getRecentProjects: () => [] }));

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
    mocks.openPath.mockReset().mockResolvedValue('');
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

  it('reveal 在 openPath 返回失败原因时透传该原因', async () => {
    const reveal = mocks.handlers.get(IPC_CHANNELS.PROJECTS_REVEAL)!;
    mocks.openPath.mockResolvedValue('Failed to open path');
    await expect(reveal(event(1), { projectId: 'project-1' })).resolves.toEqual({
      ok: false,
      error: 'Failed to open path',
    });
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
});
