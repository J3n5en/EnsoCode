import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  setState: vi.fn(),
  getState: vi.fn(),
  moveConversation: vi.fn(),
  importProjectSessions: vi.fn(),
  removeEmptyProject: vi.fn(),
  removeProjectWithFiles: vi.fn(),
  settingsSetState: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => ({ addToast: mocks.addToast }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: { setState: mocks.setState, getState: mocks.getState },
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: { setState: mocks.settingsSetState },
}));

import {
  canMoveConversationFrom,
  conversationMoveErrorTitle,
  defaultImportMode,
  importProjectSessionsFromDialog,
  moveConversationFromMenu,
  moveConversationTargets,
  projectRootConversationCount,
  removeEmptyProjectFromDialog,
} from './moveConversationAction';

describe('moveConversationTargets', () => {
  const local = { id: 'local', kind: 'local' as const, name: 'App', path: '/app' };
  const other = { id: 'other', kind: undefined, name: 'Lib', path: '/lib' };
  const scratch = { id: 'scratch', kind: 'scratch' as const, name: 'Temporary chats', path: '/t' };
  const secretary = { id: 'sec', kind: 'secretary' as const, name: 'Secretary', path: '/s' };
  const ssh = { id: 'ssh', kind: 'ssh' as const, name: 'Remote', path: '/r' };

  it('excludes scratch, secretary, and the current project', () => {
    expect(moveConversationTargets([local, other, scratch, secretary, ssh], 'local')).toEqual([
      other,
      ssh,
    ]);
  });

  it('keeps every non-reserved project when moving a scratch session', () => {
    expect(moveConversationTargets([local, scratch, secretary], 'scratch')).toEqual([local]);
  });

  it('offers no target for a secretary conversation', () => {
    expect(canMoveConversationFrom([local, secretary], 'sec')).toBe(false);
    expect(moveConversationTargets([local, other, secretary], 'sec')).toEqual([]);
    expect(canMoveConversationFrom([local, secretary], 'local')).toBe(true);
    expect(canMoveConversationFrom([local, scratch], 'scratch')).toBe(true);
  });
});

describe('conversationMoveErrorTitle', () => {
  it('uses a specific title for a running session', () => {
    expect(conversationMoveErrorTitle('running')).toBe('Cannot move a running conversation');
    expect(conversationMoveErrorTitle('worktree-busy')).toBe(
      'Cannot move while its worktree is in use'
    );
    expect(conversationMoveErrorTitle('source-secretary')).toBe(
      'Secretary conversations cannot be moved'
    );
    expect(conversationMoveErrorTitle('not-found')).toBe('Failed to move conversation');
  });
});

describe('moveConversationFromMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.moveConversation.mockResolvedValue({
      ok: true,
      value: { conversationId: 'c1', projectId: 'p2' },
    });
    vi.stubGlobal('window', {
      electronAPI: { settings: { moveConversation: mocks.moveConversation } },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends identifiers to Main, updates local projectId and drops the worktree binding', async () => {
    let next: unknown;
    mocks.setState.mockImplementation((fn: (state: unknown) => unknown) => {
      next = fn({
        conversations: {
          c1: { projectId: 'p1', worktree: { path: '/wt' }, worktreeMissing: true },
          child: { projectId: 'p1', parentId: 'c1' },
        },
        worktreeStatuses: { c1: { exists: true }, other: { exists: true } },
      });
    });
    await moveConversationFromMenu('c1', 'p2', (s) => s);
    expect(mocks.moveConversation).toHaveBeenCalledWith({
      conversationId: 'c1',
      targetProjectId: 'p2',
    });
    expect(next).toEqual({
      conversations: {
        c1: { projectId: 'p2', worktree: undefined, worktreeMissing: undefined },
        child: { projectId: 'p2', parentId: 'c1' },
      },
      worktreeStatuses: { other: { exists: true } },
    });
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('toasts when the session is running', async () => {
    mocks.moveConversation.mockResolvedValue({ ok: false, error: 'running' });
    await moveConversationFromMenu('c1', 'p2', (s) => s);
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        title: 'Cannot move a running conversation',
      })
    );
    expect(mocks.setState).not.toHaveBeenCalled();
  });

  it('toasts other failures', async () => {
    mocks.moveConversation.mockResolvedValue({ ok: false, error: 'target-scratch' });
    await moveConversationFromMenu('c1', 'p2', (s) => s);
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        title: 'Failed to move conversation',
        description: 'target-scratch',
      })
    );
  });
});

describe('projectRootConversationCount', () => {
  it('counts root conversations of the project, archived included, children excluded', () => {
    const conversations = {
      a: { projectId: 'p1' },
      b: { projectId: 'p1', archived: true },
      child: { projectId: 'p1', parentId: 'a' },
      btw: { projectId: 'p1', btwParentId: 'a' },
      other: { projectId: 'p2' },
    };
    expect(projectRootConversationCount(conversations, 'p1')).toBe(2);
  });
});

describe('importProjectSessionsFromDialog', () => {
  const state = () => ({
    conversations: {
      c1: { projectId: 'p1', title: 'One', worktree: { path: '/wt' } },
      child: { projectId: 'p1', parentId: 'c1' },
      c2: { projectId: 'p1', title: 'Busy' },
      archived: { projectId: 'p1', title: 'Old', archived: true },
      other: { projectId: 'p3' },
    },
    worktreeStatuses: { c1: { exists: true } },
  });
  let next: ReturnType<typeof state> | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    next = undefined;
    mocks.getState.mockImplementation(state);
    mocks.setState.mockImplementation((fn: (s: unknown) => ReturnType<typeof state>) => {
      next = fn(state());
    });
    vi.stubGlobal('window', {
      electronAPI: { settings: { importProjectSessions: mocks.importProjectSessions } },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('moves imported roots with their children locally and reports success', async () => {
    mocks.importProjectSessions.mockResolvedValue({
      ok: true,
      mode: 'move',
      imported: ['c1', 'c2', 'archived'],
      skipped: [],
      sourceEmpty: true,
    });
    expect(await importProjectSessionsFromDialog('p1', 'p2', 'move', (s) => s)).toEqual({
      offerRemoveSource: true,
    });
    expect(mocks.importProjectSessions).toHaveBeenCalledWith({
      sourceProjectId: 'p1',
      targetProjectId: 'p2',
      mode: 'move',
    });
    expect(next?.conversations).toEqual({
      c1: { projectId: 'p2', title: 'One', worktree: undefined, worktreeMissing: undefined },
      child: { projectId: 'p2', parentId: 'c1' },
      c2: { projectId: 'p2', title: 'Busy', worktree: undefined, worktreeMissing: undefined },
      archived: {
        projectId: 'p2',
        title: 'Old',
        archived: true,
        worktree: undefined,
        worktreeMissing: undefined,
      },
      other: { projectId: 'p3' },
    });
    expect(next?.worktreeStatuses).toEqual({});
    expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('names the skipped running conversations', async () => {
    mocks.importProjectSessions.mockResolvedValue({
      ok: true,
      mode: 'move',
      imported: ['c1'],
      skipped: [{ conversationId: 'c2', error: 'running' }],
      sourceEmpty: false,
    });
    expect(await importProjectSessionsFromDialog('p1', 'p2', 'move', (s) => s)).toEqual({
      offerRemoveSource: false,
    });
    expect(next?.conversations.c2.projectId).toBe('p1');
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        description: expect.stringContaining('Busy'),
      })
    );
  });

  it('toasts a failure and leaves the local state alone', async () => {
    mocks.importProjectSessions.mockResolvedValue({ ok: false, error: 'target-unavailable' });
    expect(await importProjectSessionsFromDialog('p1', 'p2', 'move', (s) => s)).toBeNull();
    expect(mocks.setState).not.toHaveBeenCalled();
    expect(mocks.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', description: 'target-unavailable' })
    );
  });

  it('copies without touching local rows and never offers to remove the source', async () => {
    mocks.importProjectSessions.mockResolvedValue({
      ok: true,
      mode: 'copy',
      imported: ['n1', 'n2'],
      skipped: [],
      sourceEmpty: true,
    });
    expect(await importProjectSessionsFromDialog('p1', 'p2', 'copy', (s) => s)).toEqual({
      offerRemoveSource: false,
    });
    expect(mocks.setState).not.toHaveBeenCalled();
    expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
});

describe('defaultImportMode', () => {
  it('moves when the source directory is gone and copies otherwise', () => {
    expect(defaultImportMode(false)).toBe('move');
    expect(defaultImportMode(true)).toBe('copy');
  });
});

describe('removeEmptyProjectFromDialog', () => {
  let projects: { id: string }[] = [];
  beforeEach(() => {
    vi.clearAllMocks();
    projects = [{ id: 'p1' }, { id: 'p2' }];
    mocks.settingsSetState.mockImplementation((fn: (s: unknown) => { projects: unknown }) => {
      projects = fn({ projects }).projects as { id: string }[];
    });
    vi.stubGlobal('window', {
      electronAPI: {
        settings: { removeEmptyProject: mocks.removeEmptyProject },
        sourceAuthority: { removeProject: mocks.removeProjectWithFiles },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('only drops the list entry through the file-safe channel', async () => {
    mocks.removeEmptyProject.mockResolvedValue({ ok: true });
    expect(await removeEmptyProjectFromDialog('p1', (s) => s)).toBe(true);
    expect(mocks.removeEmptyProject).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(mocks.removeProjectWithFiles).not.toHaveBeenCalled();
    expect(projects).toEqual([{ id: 'p2' }]);
  });

  it('keeps the project and toasts when Main refuses', async () => {
    mocks.removeEmptyProject.mockResolvedValue({ ok: false, error: 'not-empty' });
    expect(await removeEmptyProjectFromDialog('p1', (s) => s)).toBe(false);
    expect(projects).toEqual([{ id: 'p1' }, { id: 'p2' }]);
    expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
