import type { SecretaryProposal, SecretaryState } from '@shared/types/secretary';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proposal: SecretaryProposal = {
  id: 'pr1',
  secretaryConversationId: 'sec1',
  createdAt: 1,
  updatedAt: 1,
  status: 'pending',
  kind: 'dispatch',
  draft: { projectId: 'p1', prompt: 'fix login', worktree: false },
};

const stateWith = (status: SecretaryProposal['status']): SecretaryState => ({
  enabled: true,
  projectId: 'sec-project',
  profile: null,
  persona: '',
  board: { needsYou: [], running: [], done: [], todos: [] },
  proposals: { pr1: { ...proposal, status } },
});

let initialState: Promise<SecretaryState>;
let listener: ((state: SecretaryState) => void) | null = null;
const off = vi.fn();
const resolveProposal = vi.fn(async (_proposalId: string, _action: 'confirm' | 'reject') => ({
  ok: true as const,
  proposal,
}));

vi.stubGlobal('window', {
  electronAPI: {
    secretary: {
      getState: () => initialState,
      onStateChanged: (callback: (state: SecretaryState) => void) => {
        listener = callback;
        return off;
      },
      resolveProposal,
    },
  },
});

const { EMPTY_SECRETARY_STATE, useSecretaryStore } = await import('./secretary');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useSecretaryStore', () => {
  beforeEach(() => {
    listener = null;
    off.mockClear();
    resolveProposal.mockClear();
    useSecretaryStore.setState({ secretary: EMPTY_SECRETARY_STATE, resolving: {} });
  });

  it('bind 拉一次状态并订阅推送，推送覆盖初始快照', async () => {
    initialState = Promise.resolve(stateWith('pending'));
    const unbind = useSecretaryStore.getState().bind();
    await flush();
    expect(useSecretaryStore.getState().secretary.proposals.pr1?.status).toBe('pending');

    listener?.(stateWith('succeeded'));
    expect(useSecretaryStore.getState().secretary.proposals.pr1?.status).toBe('succeeded');

    unbind();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('推送先到时，晚回来的初始快照不把它盖回去', async () => {
    let settle: (state: SecretaryState) => void = () => {};
    initialState = new Promise<SecretaryState>((resolve) => {
      settle = resolve;
    });
    useSecretaryStore.getState().bind();
    listener?.(stateWith('executing'));
    settle(stateWith('pending'));
    await flush();
    expect(useSecretaryStore.getState().secretary.proposals.pr1?.status).toBe('executing');
  });

  it('resolveProposal 在途按提案 id 标记，结束后清除', async () => {
    let settle: () => void = () => {};
    resolveProposal.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({ ok: true, proposal });
        })
    );
    const pending = useSecretaryStore.getState().resolveProposal('pr1', 'confirm');
    expect(useSecretaryStore.getState().resolving.pr1).toBe(true);
    expect(resolveProposal).toHaveBeenCalledWith('pr1', 'confirm');

    settle();
    await pending;
    expect(useSecretaryStore.getState().resolving.pr1).toBeUndefined();
  });

  it('resolveProposal 抛错也清掉在途标记，按钮可以重试', async () => {
    resolveProposal.mockRejectedValueOnce(new Error('boom'));
    await useSecretaryStore.getState().resolveProposal('pr1', 'reject');
    expect(useSecretaryStore.getState().resolving.pr1).toBeUndefined();
  });
});
