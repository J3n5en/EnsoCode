import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  setState: vi.fn(),
  moveConversation: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => ({ addToast: mocks.addToast }));
vi.mock('@/stores/sessions', () => ({
  useSessionsStore: { setState: mocks.setState },
}));

import {
  canMoveConversationFrom,
  conversationMoveErrorTitle,
  moveConversationFromMenu,
  moveConversationTargets,
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
