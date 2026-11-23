import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type { SessionWorktree } from '@shared/types/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeRegistry } from '../services/worktree/registry';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  root: '',
  project: vi.fn(),
  conversation: vi.fn(),
  currentIdentity: vi.fn(),
  isAlive: vi.fn((_id: string) => false),
  treeRunning: vi.fn((_id: string) => false),
  btwRunning: vi.fn((_id: string) => false),
  remove: vi.fn(async () => {}),
  create: vi.fn(),
  status: vi.fn(async (_record: SessionWorktree) => ({ exists: true, dirty: false, ahead: 0 })),
  rebuild: vi.fn(async (record: SessionWorktree) => ({ ...record, path: '/rebuilt' })),
}));
vi.mock('electron', () => ({
  app: { getPath: () => mocks.root },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) =>
      mocks.handlers.set(channel, handler),
  },
}));
vi.mock('../services/agentHost', () => ({
  readSettingsState: () => ({}),
  setWorkspaceBusyResolver: vi.fn(),
}));
vi.mock('../services/renderers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/renderers')>()),
  isMainRenderer: (id: number) => id === 1,
}));
vi.mock('./agent', () => ({
  getSourceAuthorityRegistry: () => ({ project: mocks.project, conversation: mocks.conversation }),
}));
vi.mock('./sessionIndex', () => ({
  agentSessionIndex: {
    currentIdentity: mocks.currentIdentity,
    isAlive: mocks.isAlive,
    workspaceRoot: (id: string) => id,
    workspaceTreeRunning: mocks.treeRunning,
    btwTreeRunning: mocks.btwRunning,
  },
}));
vi.mock('../services/worktree/service', () => ({
  createSessionWorktree: mocks.create,
  rebuildSessionWorktree: mocks.rebuild,
  removeSessionWorktree: mocks.remove,
  repoIsClean: vi.fn(),
  worktreeStatus: mocks.status,
}));

await import('./worktree');

const record: SessionWorktree = {
  conversationId: 'source',
  projectId: 'p',
  repoPath: '/repo',
  path: '/managed/source',
  branch: 'enso/source',
  baseBranch: 'main',
  baseCommit: 'abc',
  createdAt: 1,
};
const invoke = (channel: string, ...args: unknown[]) =>
  mocks.handlers.get(channel)!({ sender: { id: 1 } }, ...args);
const readRegistry = () => new WorktreeRegistry(join(mocks.root, 'worktrees.json'));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.root = mkdtempSync(join(tmpdir(), 'enso-worktree-ipc-'));
  readRegistry().set(record);
  mocks.project.mockReturnValue({ projectId: 'p', canonicalPath: '/repo', state: 'active' });
  mocks.conversation.mockImplementation((id: string) => ({
    conversationId: id,
    projectId: 'p',
    kind: 'root',
    lifecycle: id === 'source' ? 'ready' : 'draft',
  }));
  mocks.currentIdentity.mockReturnValue(undefined);
  mocks.isAlive.mockReturnValue(false);
  mocks.treeRunning.mockReturnValue(false);
  mocks.btwRunning.mockReturnValue(false);
  mocks.status.mockResolvedValue({ exists: true, dirty: false, ahead: 0 });
  const { registerWorktreeHandlers } = await import('./worktree');
  registerWorktreeHandlers();
});
afterEach(() => rmSync(mocks.root, { recursive: true, force: true }));

describe('worktree statuses (batch)', () => {
  it('一次返回全部登记的状态；查失败的不在结果里', async () => {
    readRegistry().set({ ...record, conversationId: 'b', path: '/managed/b' });
    readRegistry().set({ ...record, conversationId: 'c', path: '/managed/c' });
    mocks.status.mockImplementation(async (r: SessionWorktree) => {
      if (r.conversationId === 'c') throw new Error('git broke');
      return { exists: true, dirty: r.conversationId === 'b', ahead: 0 };
    });
    expect(await invoke(IPC_CHANNELS.WORKTREE_STATUSES)).toEqual({
      source: { exists: true, dirty: false, ahead: 0 },
      b: { exists: true, dirty: true, ahead: 0 },
    });
  });

  it('多个窗口同时请求共用一次查询；查询途中的新请求等下一轮，看得到之后的状态', async () => {
    let release!: () => void;
    let dirty = false;
    mocks.status.mockImplementation(async () => {
      const seen = dirty;
      if (!release) await new Promise<void>((resolve) => (release = resolve));
      return { exists: true, dirty: seen, ahead: 0 };
    });
    const first = invoke(IPC_CHANNELS.WORKTREE_STATUSES);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    dirty = true;
    const second = invoke(IPC_CHANNELS.WORKTREE_STATUSES);
    const third = invoke(IPC_CHANNELS.WORKTREE_STATUSES);
    release();
    expect((await first).source.dirty).toBe(false);
    expect((await second).source.dirty).toBe(true);
    expect(await third).toEqual(await second);
    expect(mocks.status).toHaveBeenCalledTimes(2);
  });
});

describe('worktree binding', () => {
  it('does not let create replace an existing or in-flight shared binding', async () => {
    expect(
      (await invoke(IPC_CHANNELS.WORKTREE_CREATE, { conversationId: 'source', projectId: 'p' })).ok
    ).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.status.mockImplementationOnce(async () => {
      expect(
        (await invoke(IPC_CHANNELS.WORKTREE_CREATE, { conversationId: 'target', projectId: 'p' }))
          .ok
      ).toBe(false);
      expect(mocks.create).not.toHaveBeenCalled();
      return { exists: true, dirty: false, ahead: 0 };
    });
    expect((await invoke('worktree:bind', 'target', 'source')).ok).toBe(true);
  });
  it('binds a fresh root using the authoritative source, ignoring supplied paths', async () => {
    expect(await invoke('worktree:bind', 'target', 'source', '/attacker')).toEqual({
      ok: true,
      value: { ...record, conversationId: 'target' },
    });
    expect(readRegistry().get('target')?.path).toBe(record.path);
  });
  it.each(['foreign', 'ended', 'child', 'started', 'unknown'])(
    'rejects %s target authority without binding',
    async (scenario) => {
      mocks.conversation.mockImplementation((id: string) =>
        id === 'source'
          ? { conversationId: id, projectId: 'p', kind: 'root', lifecycle: 'ready' }
          : scenario === 'unknown'
            ? undefined
            : {
                conversationId: id,
                projectId: scenario === 'foreign' ? 'other' : 'p',
                kind: scenario === 'child' ? 'child' : 'root',
                lifecycle:
                  scenario === 'ended' ? 'ended' : scenario === 'started' ? 'ready' : 'draft',
              }
      );
      expect((await invoke('worktree:bind', 'target', 'source')).ok).toBe(false);
      expect(readRegistry().get('target')).toBeUndefined();
    }
  );
  it('rejects spawning targets, SSH projects, missing source directories and non-main senders', async () => {
    mocks.currentIdentity.mockReturnValue({ sessionId: 'target' });
    expect((await invoke('worktree:bind', 'target', 'source')).ok).toBe(false);
    mocks.currentIdentity.mockReturnValue(undefined);
    mocks.project.mockReturnValue({ canonicalPath: '/repo', state: 'active', kind: 'ssh' });
    expect((await invoke('worktree:bind', 'target', 'source')).ok).toBe(false);
    mocks.project.mockReturnValue({ canonicalPath: '/repo', state: 'active' });
    mocks.status.mockResolvedValue({ exists: false, dirty: false, ahead: 0 });
    expect((await invoke('worktree:bind', 'target', 'source')).ok).toBe(false);
    expect(
      (await mocks.handlers.get('worktree:bind')!({ sender: { id: 2 } }, 'target', 'source')).ok
    ).toBe(false);
    expect(readRegistry().get('target')).toBeUndefined();
  });
  it('revalidates the target after asynchronous status checks', async () => {
    mocks.status.mockImplementationOnce(async () => {
      mocks.currentIdentity.mockReturnValue({ sessionId: 'target' });
      return { exists: true, dirty: false, ahead: 0 };
    });
    expect((await invoke('worktree:bind', 'target', 'source')).ok).toBe(false);
    expect(readRegistry().get('target')).toBeUndefined();
  });
});

describe('shared lifecycle', () => {
  it('does not remove a later binding when rolling back a captured fork reservation', async () => {
    const { removeRegisteredWorktree } = await import('./worktree');
    await removeRegisteredWorktree('source', { ...record, path: '/old-reservation' });
    expect(readRegistry().get('source')).toEqual(record);
    expect(mocks.remove).not.toHaveBeenCalled();
    await invoke(IPC_CHANNELS.WORKTREE_RENAME, 'source', 'renamed');
    await removeRegisteredWorktree('source', record);
    expect(readRegistry().get('source')).toBeUndefined();
  });

  it('rejects rebuilding a missing shared workspace while a sibling is alive', async () => {
    await invoke('worktree:bind', 'target', 'source');
    mocks.status.mockResolvedValue({ exists: false, dirty: false, ahead: 0 });
    mocks.isAlive.mockImplementation((id: string) => id === 'target');
    expect((await invoke(IPC_CHANNELS.WORKTREE_REBUILD, 'source')).ok).toBe(false);
    expect(mocks.rebuild).not.toHaveBeenCalled();
    expect(readRegistry().get('target')?.path).toBe(record.path);
    mocks.isAlive.mockReturnValue(false);
    expect((await invoke(IPC_CHANNELS.WORKTREE_REBUILD, 'source')).ok).toBe(true);
  });

  it('waits for binding before removing its source rather than leaking the source reference', async () => {
    let finish!: () => void;
    mocks.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ exists: true, dirty: false, ahead: 0 });
        })
    );
    const binding = invoke('worktree:bind', 'target', 'source');
    const removing = invoke(IPC_CHANNELS.WORKTREE_REMOVE, 'source');
    finish();
    expect((await binding).ok).toBe(true);
    expect((await removing).ok).toBe(true);
    expect(readRegistry().get('source')).toBeUndefined();
    expect(readRegistry().get('target')?.path).toBe(record.path);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  const share = () => invoke('worktree:bind', 'target', 'source');
  it('removes only one binding until the last reference is removed', async () => {
    await share();
    await invoke(IPC_CHANNELS.WORKTREE_REMOVE, 'source');
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(readRegistry().get('source')).toBeUndefined();
    expect(readRegistry().get('target')?.path).toBe(record.path);
    await invoke(IPC_CHANNELS.WORKTREE_REMOVE, 'target');
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(readRegistry().list()).toEqual([]);
  });
  it('renames all bindings without changing branch/path', async () => {
    await share();
    expect((await invoke('worktree:rename', 'target', '  Feature  ')).value).toHaveLength(2);
    expect(readRegistry().get('source')).toEqual({ ...record, name: 'Feature' });
    expect((await invoke('worktree:rename', 'source', 42)).ok).toBe(false);
    expect((await invoke('worktree:rename', 'source', 'x'.repeat(81))).ok).toBe(false);
  });
  it('rebuild updates every binding to the new directory', async () => {
    await share();
    mocks.status.mockResolvedValue({ exists: false, dirty: false, ahead: 0 });
    await invoke(IPC_CHANNELS.WORKTREE_REBUILD, 'source');
    expect(readRegistry().get('target')?.path).toBe('/rebuilt');
  });
});

describe('move guard', () => {
  it('treats the worktree as in use while any binding (or its btw side session) runs', async () => {
    const { sessionWorktreeInUse } = await import('./worktree');
    await invoke('worktree:bind', 'target', 'source');
    expect(sessionWorktreeInUse('source')).toBe(false);
    mocks.treeRunning.mockImplementation((id: string) => id === 'target');
    expect(sessionWorktreeInUse('source')).toBe(true);
    mocks.treeRunning.mockReturnValue(false);
    mocks.btwRunning.mockImplementation((id: string) => id === 'source');
    expect(sessionWorktreeInUse('target')).toBe(true);
    mocks.btwRunning.mockReturnValue(false);
    expect(sessionWorktreeInUse('unbound')).toBe(false);
  });

  it('treats an in-flight binding as in use', async () => {
    const { sessionWorktreeInUse } = await import('./worktree');
    let during: boolean | undefined;
    mocks.status.mockImplementationOnce(async () => {
      during = sessionWorktreeInUse('target');
      return { exists: true, dirty: false, ahead: 0 };
    });
    expect((await invoke('worktree:bind', 'target', 'source')).ok).toBe(true);
    expect(during).toBe(true);
    expect(sessionWorktreeInUse('target')).toBe(false);
  });

  it('unbinds only the moved conversation and never removes the worktree directory', async () => {
    const { unbindSessionWorktree, sessionWorktree } = await import('./worktree');
    await invoke('worktree:bind', 'target', 'source');
    unbindSessionWorktree('source');
    expect(sessionWorktree('source')).toBeUndefined();
    expect(readRegistry().get('source')).toBeUndefined();
    expect(readRegistry().get('target')?.path).toBe(record.path);
    unbindSessionWorktree('target');
    expect(readRegistry().list()).toEqual([]);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
