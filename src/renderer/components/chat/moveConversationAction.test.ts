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
});

describe('conversationMoveErrorTitle', () => {
  it('uses a specific title for a running session', () => {
    expect(conversationMoveErrorTitle('running')).toBe('Cannot move a running conversation');
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

  it('sends identifiers to Main and updates local projectId', async () => {
    mocks.setState.mockImplementation(
      (
        fn: (state: {
          conversations: Record<string, { projectId: string; parentId?: string }>;
        }) => unknown
      ) => {
        fn({
          conversations: {
            c1: { projectId: 'p1' },
            child: { projectId: 'p1', parentId: 'c1' },
          },
        });
      }
    );
    await moveConversationFromMenu('c1', 'p2', (s) => s);
    expect(mocks.moveConversation).toHaveBeenCalledWith({
      conversationId: 'c1',
      targetProjectId: 'p2',
    });
    expect(mocks.setState).toHaveBeenCalled();
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
