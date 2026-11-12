import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeRegistry } from '../services/worktree/registry';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  root: '',
  repo: '',
  managed: '',
  projects: new Map<string, any>(),
  conversations: new Map<string, any>(),
  read: vi.fn(),
  change: vi.fn(),
  validate: vi.fn(),
  check: vi.fn(),
  running: vi.fn(),
  freeze: vi.fn(),
  thaw: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => mocks.root },
  ipcMain: {
    handle: (key: string, handler: (...args: any[]) => any) => mocks.handlers.set(key, handler),
  },
}));
vi.mock('../services/renderers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/renderers')>()),
  isMainRenderer: (id: number) => id === 1,
}));
vi.mock('./agent', () => ({
  getSourceAuthorityRegistry: () => ({
    project: (id: string) => mocks.projects.get(id),
    conversation: (id: string) => mocks.conversations.get(id),
    projection: () => ({
      projects: [...mocks.projects.values()],
      conversations: [...mocks.conversations.values()],
    }),
  }),
}));
vi.mock('./sessionIndex', () => ({
  agentSessionIndex: {
    workspaceRoot: (id: string) => (id === 'child' ? 'main-a' : id),
    workspaceTreeRunning: mocks.running,
    currentIdentity: vi.fn(),
    isAlive: vi.fn(),
  },
}));
vi.mock('../services/agentHost', () => ({
  readSettingsState: () => ({}),
  freezeWorkspace: mocks.freeze,
  thawWorkspace: mocks.thaw,
  setWorkspaceBusyResolver: vi.fn(),
}));
vi.mock('../services/gitBranches', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/gitBranches')>()),
  readWorkspaceBranches: mocks.read,
  switchWorkspaceBranch: mocks.change,
  validateWorkspaceBranch: mocks.validate,
  checkWorkspaceBranchSwitch: mocks.check,
}));
const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)!({ sender: { id: 1 } }, ...args);
const registry = () => new WorktreeRegistry(join(mocks.root, 'worktrees.json'));
const snapshot = () => ({
  currentBranch: 'main',
  headCommit: 'abc',
  dirty: false,
  branches: [{ name: 'main', worktreePath: mocks.repo }, { name: 'feature' }],
});

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.projects.clear();
  mocks.conversations.clear();
  mocks.root = mkdtempSync(join(tmpdir(), 'enso-branch-ipc-'));
  mocks.repo = join(mocks.root, 'repo');
  mocks.managed = join(mocks.root, 'managed');
  mkdirSync(mocks.repo);
  mkdirSync(mocks.managed);
  mocks.projects.set('p', { projectId: 'p', canonicalPath: mocks.repo, state: 'active' });
  for (const id of ['main-a', 'main-b', 'isolated-a', 'isolated-b'])
    mocks.conversations.set(id, {
      conversationId: id,
      projectId: 'p',
      kind: 'root',
      lifecycle: 'ready',
    });
  for (const id of ['isolated-a', 'isolated-b'])
    registry().set({
      conversationId: id,
      projectId: 'p',
      repoPath: mocks.repo,
      path: mocks.managed,
      branch: 'old',
      baseBranch: 'main',
      baseCommit: 'base',
      createdAt: 1,
    });
  mocks.read.mockImplementation(async () => snapshot());
  mocks.change.mockImplementation(async (_cwd, branch, _create, before, applied) => {
    before?.();
    const value = { ...snapshot(), currentBranch: branch };
    applied?.(value);
    return value;
  });
  mocks.validate.mockResolvedValue(undefined);
  mocks.check.mockReturnValue(undefined);
  mocks.running.mockReturnValue(false);
  mocks.freeze.mockResolvedValue({ ok: true });
  mocks.thaw.mockResolvedValue({ ok: true });
  (await import('./worktree')).registerWorktreeHandlers();
});
afterEach(() => rmSync(mocks.root, { recursive: true, force: true }));

describe('workspace branch IPC', () => {
  it.each(['main', 'release/stable', null, undefined])(
    'projects default branch metadata %j without guessing from currentBranch',
    async (defaultBranch) => {
      mocks.read.mockResolvedValue({ ...snapshot(), defaultBranch });
      expect(await invoke('worktree:branches', 'main-a')).toMatchObject({
        ok: true,
        value: { currentBranch: 'main', defaultBranch: defaultBranch ?? null },
      });
    }
  );
  it('uses authoritative root cwd and includes every main-tree root, never renderer paths', async () => {
    const result = await invoke('worktree:branches', 'main-a', '/attacker');
    expect(result).toMatchObject({
      ok: true,
      value: { affectedConversationIds: ['main-a', 'main-b'], currentBranch: 'main' },
    });
    expect(mocks.read).toHaveBeenCalledWith(mocks.repo);
    await invoke('worktree:switch-branch', {
      conversationId: 'main-a',
      branch: 'feature',
      cwd: '/attacker',
    });
    expect(mocks.change).toHaveBeenCalledWith(
      mocks.repo,
      'feature',
      false,
      expect.any(Function),
      expect.any(Function)
    );
  });
  it.each(['ssh', 'ended', 'child', 'unknown', 'wrong-record'])(
    'rejects %s authority before Git or worker access',
    async (kind) => {
      if (kind === 'ssh') mocks.projects.get('p').kind = 'ssh';
      if (kind === 'ended') mocks.conversations.get('main-a').lifecycle = 'ended';
      if (kind === 'child') mocks.conversations.get('main-a').kind = 'child';
      if (kind === 'unknown') mocks.conversations.delete('main-a');
      if (kind === 'wrong-record')
        registry().set({
          ...registry().get('isolated-a')!,
          conversationId: 'main-a',
          projectId: 'foreign',
        });
      expect(
        (await invoke('worktree:switch-branch', { conversationId: 'main-a', branch: 'feature' })).ok
      ).toBe(false);
      expect(mocks.change).not.toHaveBeenCalled();
      expect(mocks.freeze).not.toHaveBeenCalled();
    }
  );
  it('rejects malformed parameters and non-main senders', async () => {
    for (const request of [null, [], {}, { conversationId: 'main-a', branch: 'x', create: 'yes' }])
      expect((await invoke('worktree:switch-branch', request)).ok).toBe(false);
    expect(
      (await mocks.handlers.get('worktree:branches')!({ sender: { id: 2 } }, 'main-a')).ok
    ).toBe(false);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('keeps the shared busy gate until thaw and rejects a second mutation', async () => {
    const { sessionWorktreeBusy } = await import('./worktree');
    mocks.change.mockImplementationOnce(async (_cwd, _branch, _create, _before, applied) => {
      expect(sessionWorktreeBusy('main-a')).toBe(true);
      expect(sessionWorktreeBusy('main-b')).toBe(true);
      expect(sessionWorktreeBusy('child')).toBe(true);
      expect(
        (await invoke('worktree:switch-branch', { conversationId: 'main-b', branch: 'other' })).code
      ).toBe('busy');
      const value = { ...snapshot(), currentBranch: 'feature' };
      applied(value);
      return value;
    });
    mocks.thaw.mockImplementationOnce(async () => {
      expect(sessionWorktreeBusy('main-a')).toBe(true);
      return { ok: true };
    });
    expect(
      (await invoke('worktree:switch-branch', { conversationId: 'main-a', branch: 'feature' })).ok
    ).toBe(true);
    expect(sessionWorktreeBusy('main-a')).toBe(false);
  });
  it('rejects running siblings before freezing and preserves idle workers', async () => {
    mocks.running.mockImplementation((id) => id === 'main-b');
    expect((await invoke('worktree:branches', 'main-a')).value.blockedReason).toBe('running');
    expect(
      (await invoke('worktree:switch-branch', { conversationId: 'main-a', branch: 'feature' })).code
    ).toBe('running');
    expect(mocks.freeze).not.toHaveBeenCalled();
    expect(mocks.change).not.toHaveBeenCalled();
  });
  it('does not mutate Git when worker detects an in-flight run missed by Main', async () => {
    mocks.freeze.mockResolvedValue({ ok: false, error: 'running' });
    expect(
      (await invoke('worktree:switch-branch', { conversationId: 'main-a', branch: 'feature' })).ok
    ).toBe(false);
    expect(mocks.change).not.toHaveBeenCalled();
  });
  it('keeps the workspace blocked when failed freeze cannot be compensated, without mutating Git', async () => {
    mocks.freeze.mockResolvedValueOnce({ ok: false, error: 'lock ack lost', needsThaw: true });
    mocks.thaw.mockResolvedValue({ ok: false, error: 'cleanup ack lost' });
    const result = await invoke('worktree:switch-branch', {
      conversationId: 'main-a',
      branch: 'feature',
    });
    expect(result).toMatchObject({ ok: false, code: 'busy', workspaceBlocked: true });
    expect(result.changed).toBeUndefined();
    expect(result.error).toContain('Restart');
    expect(mocks.change).not.toHaveBeenCalled();
    expect(mocks.thaw).toHaveBeenCalledTimes(2);
    expect(mocks.thaw.mock.calls[0]).toEqual([
      mocks.freeze.mock.calls[0][0],
      ['main-a', 'main-b'],
      undefined,
    ]);
    expect(mocks.thaw.mock.calls[1]).toEqual(mocks.thaw.mock.calls[0]);
    const { sessionWorktreeBusy } = await import('./worktree');
    expect(sessionWorktreeBusy('main-b')).toBe(true);
    expect(sessionWorktreeBusy('isolated-a')).toBe(false);
    expect(
      (await invoke('worktree:switch-branch', { conversationId: 'main-b', branch: 'feature' })).code
    ).toBe('busy');
  });
  it.each([
    ['authority', false],
    ['authority', true],
    ['git', false],
    ['git', true],
  ] as const)(
    'settles the final blocked flag after %s refusal with failed cleanup=%s',
    async (failure, blocked) => {
      if (failure === 'authority') {
        mocks.freeze.mockImplementationOnce(async () => {
          mocks.conversations.set('main-a', { ...mocks.conversations.get('main-a'), version: 1 });
          return { ok: true };
        });
      } else mocks.change.mockRejectedValueOnce(new Error('Git refused before mutation'));
      mocks.thaw
        .mockResolvedValue({ ok: !blocked, ...(blocked ? { error: 'ack lost' } : {}) })
        .mockResolvedValueOnce({ ok: false, error: 'first ack lost' });
      const result = await invoke('worktree:switch-branch', {
        conversationId: 'main-a',
        branch: 'feature',
      });
      expect(result.ok).toBe(false);
      expect(result.changed).toBeUndefined();
      expect(result.workspaceBlocked ?? false).toBe(blocked);
      if (blocked) expect(result.error).toContain('Restart');
      expect(mocks.change).toHaveBeenCalledTimes(failure === 'authority' ? 0 : 1);
      expect(mocks.thaw).toHaveBeenCalledTimes(2);
      expect(mocks.thaw.mock.calls[0]).toEqual([
        mocks.freeze.mock.calls[0][0],
        ['main-a', 'main-b'],
        undefined,
      ]);
      expect(mocks.thaw.mock.calls[1]).toEqual(mocks.thaw.mock.calls[0]);
      const { sessionWorktreeBusy } = await import('./worktree');
      expect(sessionWorktreeBusy('main-b')).toBe(blocked);
      expect(sessionWorktreeBusy('isolated-a')).toBe(false);
    }
  );
  it('accepts canonical repo aliases without dropping affected bindings', async () => {
    const alias = join(mocks.root, 'repo-alias');
    symlinkSync(mocks.repo, alias);
    mocks.projects.get('p').canonicalPath = alias;
    expect(await invoke('worktree:branches', 'isolated-a')).toMatchObject({
      ok: true,
      value: { affectedConversationIds: ['isolated-a', 'isolated-b'] },
    });
  });
  it('returns the actual changed projection when worker resume fails', async () => {
    mocks.thaw.mockResolvedValue({ ok: false, error: 'ack lost' });
    expect(
      await invoke('worktree:switch-branch', { conversationId: 'isolated-a', branch: 'feature' })
    ).toMatchObject({
      ok: false,
      changed: {
        currentBranch: 'feature',
        blockedReason: 'busy',
        worktrees: [
          { conversationId: 'isolated-a', branch: 'feature' },
          { conversationId: 'isolated-b', branch: 'feature' },
        ],
      },
    });
    expect((await import('./worktree')).sessionWorktreeBusy('isolated-b')).toBe(true);
    expect(
      (await invoke('worktree:switch-branch', { conversationId: 'isolated-b', branch: 'other' }))
        .code
    ).toBe('busy');
  });
  it('returns a changed snapshot and installs background when post-switch refresh fails', async () => {
    mocks.change.mockImplementationOnce(async (_cwd, branch, _create, _before, applied) => {
      applied({ ...snapshot(), currentBranch: branch });
      throw new Error('refresh failed');
    });
    expect(
      await invoke('worktree:switch-branch', { conversationId: 'isolated-a', branch: 'feature' })
    ).toMatchObject({ ok: false, changed: { currentBranch: 'feature' } });
    expect(registry().get('isolated-b')?.branch).toBe('feature');
    expect(mocks.thaw).toHaveBeenCalledWith(
      expect.any(String),
      ['isolated-a', 'isolated-b'],
      'feature'
    );
  });
  it('keeps true in-memory bindings and changed projection when registry persistence fails after Git', async () => {
    mocks.change.mockImplementationOnce(async (_cwd, branch, _create, _before, applied) => {
      const file = join(mocks.root, 'worktrees.json');
      rmSync(file);
      mkdirSync(file);
      applied({ ...snapshot(), currentBranch: branch });
      return { ...snapshot(), currentBranch: branch };
    });
    expect(
      await invoke('worktree:switch-branch', { conversationId: 'isolated-a', branch: 'feature' })
    ).toMatchObject({ ok: false, changed: { currentBranch: 'feature' } });
    expect((await import('./worktree')).sessionWorktree('isolated-b')?.branch).toBe('feature');
    expect(mocks.thaw).toHaveBeenCalledWith(
      expect.any(String),
      ['isolated-a', 'isolated-b'],
      'feature'
    );
  });
  it('retries failed thaw with the same operation nonce and successful branch', async () => {
    mocks.thaw
      .mockResolvedValueOnce({ ok: false, error: 'ack lost' })
      .mockResolvedValueOnce({ ok: true });
    await invoke('worktree:switch-branch', { conversationId: 'main-a', branch: 'feature' });
    expect(mocks.thaw).toHaveBeenCalledTimes(2);
    expect(mocks.thaw.mock.calls[1]).toEqual(mocks.thaw.mock.calls[0]);
    expect(mocks.thaw.mock.calls[1][2]).toBe('feature');
  });
  it('updates all isolated bindings but retains original base semantics', async () => {
    registry().set({
      ...registry().get('isolated-b')!,
      baseBranch: 'different-base',
      baseCommit: 'different-commit',
      createdAt: 8,
    });
    const result = await invoke('worktree:switch-branch', {
      conversationId: 'isolated-a',
      branch: 'feature',
    });
    expect(result.value.worktrees).toHaveLength(2);
    expect(registry().get('isolated-b')).toMatchObject({
      branch: 'feature',
      baseBranch: 'different-base',
      baseCommit: 'different-commit',
      createdAt: 8,
      path: mocks.managed,
    });
    expect(mocks.change).toHaveBeenCalledWith(
      mocks.managed,
      'feature',
      false,
      expect.any(Function),
      expect.any(Function)
    );
  });
  it('revalidates authority after freeze and always thaws on refusal', async () => {
    mocks.freeze.mockImplementationOnce(async () => {
      mocks.conversations.delete('main-a');
      return { ok: true };
    });
    expect(
      (await invoke('worktree:switch-branch', { conversationId: 'main-a', branch: 'feature' })).ok
    ).toBe(false);
    expect(mocks.change).not.toHaveBeenCalled();
    expect(mocks.thaw).toHaveBeenCalled();
  });
});
