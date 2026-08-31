import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  createProject: vi.fn(),
  selectProject: vi.fn(),
  removeProject: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));
vi.mock('../windows/MainWindow', () => ({ isMainWebContents: (id: number) => id === 1 }));
vi.mock('./agent', () => ({
  getSourceAuthorityRegistry: () => ({
    createProject: mocks.createProject,
    selectProject: mocks.selectProject,
    removeProject: mocks.removeProject,
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
    registerProjectHandlers();
  });

  it('accepts strict dedicated mutations only from MainWindow', async () => {
    const create = mocks.handlers.get(IPC_CHANNELS.SOURCE_PROJECT_CREATE)!;
    await expect(create(event(1), { requestId: 'request', path: '/project' })).resolves.toMatchObject({
      accepted: true,
    });
    expect(mocks.createProject).toHaveBeenCalledWith({ requestId: 'request', path: '/project' });
    await expect(create(event(2), { requestId: 'request', path: '/forged' })).resolves.toEqual({
      accepted: false,
      error: 'Invalid project request.',
    });
    await expect(
      create(event(1), { requestId: 'request', path: '/project', target: '/forged' })
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
});
