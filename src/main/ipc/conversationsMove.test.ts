import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SessionIdentity } from '@shared/builtinAgents';
import type { ConversationAuthorityProjection } from '@shared/types/agent';
import { describe, expect, it, vi } from 'vitest';
import { AgentSessionIndex } from '../services/agentSessionIndex';
import { spawnCwdFromAuthority } from '../services/conversationSpawnCwd';
import { removeScratchWorkspace } from '../services/sessionFileCleanup';
import { SourceAuthorityRegistry } from '../services/sourceAuthorityRegistry';
import { WorktreeRegistry } from '../services/worktree/registry';
import {
  type ConversationsMovePorts,
  conversationIdsToMove,
  handleConversationsMove,
  parseMoveConversationInput,
} from './conversationsMove';

const conversation = (projectId: string): ConversationAuthorityProjection => ({
  conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId,
  kind: 'root',
  lifecycle: 'ready',
  version: 2,
});

describe('parseMoveConversationInput', () => {
  it('rejects missing fields and wrong types', () => {
    expect(parseMoveConversationInput(undefined)).toBeNull();
    expect(parseMoveConversationInput(null)).toBeNull();
    expect(parseMoveConversationInput('x')).toBeNull();
    expect(parseMoveConversationInput({})).toBeNull();
    expect(parseMoveConversationInput({ conversationId: 'a' })).toBeNull();
    expect(parseMoveConversationInput({ targetProjectId: 'b' })).toBeNull();
    expect(parseMoveConversationInput({ conversationId: 1, targetProjectId: 'b' })).toBeNull();
    expect(parseMoveConversationInput({ conversationId: 'a', targetProjectId: '' })).toBeNull();
    expect(
      parseMoveConversationInput({ conversationId: 'a', targetProjectId: 'b', extra: 1 })
    ).toBeNull();
  });

  it('accepts the two identifiers', () => {
    expect(parseMoveConversationInput({ conversationId: 'a', targetProjectId: 'b' })).toEqual({
      conversationId: 'a',
      targetProjectId: 'b',
    });
  });
});

describe('conversationIdsToMove', () => {
  it('includes parentId and btwParentId descendants', () => {
    expect(
      conversationIdsToMove(
        {
          root: {},
          child: { parentId: 'root' },
          nested: { parentId: 'child' },
          btw: { btwParentId: 'root' },
          other: { parentId: 'x' },
        },
        'root'
      ).sort()
    ).toEqual(['btw', 'child', 'nested', 'root']);
  });

  it('collects the trees of several roots in one call', () => {
    expect(
      conversationIdsToMove(
        {
          a: {},
          b: {},
          c: {},
          aChild: { parentId: 'a' },
          bBtw: { btwParentId: 'b' },
          cChild: { parentId: 'c' },
        },
        ['a', 'b']
      ).sort()
    ).toEqual(['a', 'aChild', 'b', 'bBtw']);
  });
});

describe('handleConversationsMove', () => {
  const target = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const input = {
    conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    targetProjectId: target,
  };
  const mockPorts = (overrides: Partial<ConversationsMovePorts> = {}) => ({
    moveConversation: vi.fn<ConversationsMovePorts['moveConversation']>(() => ({
      accepted: true,
      value: conversation(target),
    })),
    isRunning: vi.fn(() => false),
    worktreeBusy: vi.fn(() => false),
    source: vi.fn(() => ({ projectId: 'old' })),
    readConversations: vi.fn(() => ({})),
    patchProjectIds: vi.fn(),
    unbindWorktree: vi.fn(),
    releaseSessions: vi.fn(async () => true),
    removeScratchWorkspace: vi.fn(),
    ...overrides,
  });

  it('returns invalid for bad input without touching ports', async () => {
    const ports = mockPorts();
    expect(await handleConversationsMove({ conversationId: 'a' }, ports)).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(ports.moveConversation).not.toHaveBeenCalled();
    expect(ports.patchProjectIds).not.toHaveBeenCalled();
  });

  it('returns not-found for an unknown conversationId', async () => {
    const ports = mockPorts({
      moveConversation: vi.fn(() => ({ accepted: false as const, error: 'not-found' })),
      source: vi.fn(() => undefined),
    });
    expect(await handleConversationsMove(input, ports)).toEqual({ ok: false, error: 'not-found' });
    expect(ports.patchProjectIds).not.toHaveBeenCalled();
  });

  it('patches rows, unbinds the worktree and releases live sessions after a move', async () => {
    const ports = mockPorts({
      readConversations: vi.fn(() => ({
        [input.conversationId]: { projectId: 'old' },
        child: { parentId: input.conversationId, projectId: 'old' },
      })),
    });
    expect(await handleConversationsMove(input, ports)).toEqual({
      ok: true,
      value: conversation(target),
    });
    expect(ports.moveConversation).toHaveBeenCalledWith(input.conversationId, target, {
      running: false,
      worktreeBusy: false,
    });
    expect(ports.patchProjectIds).toHaveBeenCalledWith(
      expect.arrayContaining([input.conversationId, 'child']),
      target,
      [input.conversationId]
    );
    expect(ports.unbindWorktree).toHaveBeenCalledWith(input.conversationId);
    expect(ports.releaseSessions).toHaveBeenCalledWith(input.conversationId);
    expect(ports.removeScratchWorkspace).not.toHaveBeenCalled();
  });

  it('has no side effects when the target is the current project', async () => {
    const ports = mockPorts({ source: vi.fn(() => ({ projectId: target })) });
    expect((await handleConversationsMove(input, ports)).ok).toBe(true);
    expect(ports.unbindWorktree).not.toHaveBeenCalled();
    expect(ports.releaseSessions).not.toHaveBeenCalled();
  });

  it.each(['running', 'worktree-busy', 'source-secretary'])(
    'forwards %s rejection without side effects',
    async (error) => {
      const ports = mockPorts({
        moveConversation: vi.fn(() => ({ accepted: false as const, error })),
        isRunning: vi.fn(() => error === 'running'),
        worktreeBusy: vi.fn(() => error === 'worktree-busy'),
      });
      expect(await handleConversationsMove(input, ports)).toEqual({ ok: false, error });
      expect(ports.moveConversation).toHaveBeenCalledWith(input.conversationId, target, {
        running: error === 'running',
        worktreeBusy: error === 'worktree-busy',
      });
      expect(ports.patchProjectIds).not.toHaveBeenCalled();
      expect(ports.unbindWorktree).not.toHaveBeenCalled();
      expect(ports.releaseSessions).not.toHaveBeenCalled();
    }
  );
});

describe('handleConversationsMove with real authority, worktree and session index', () => {
  const setup = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enso-move-'));
    for (const dir of ['a', 'b', 'scratch', 'wt']) mkdirSync(path.join(root, dir));
    const registry = new SourceAuthorityRegistry({ registryFile: path.join(root, 'auth.json') });
    const projectA = registry.createProject({ requestId: 'a', path: path.join(root, 'a') });
    const projectB = registry.createProject({ requestId: 'b', path: path.join(root, 'b') });
    const scratch = registry.ensureScratchProject(path.join(root, 'scratch'));
    if (!projectA.accepted || !projectB.accepted || !scratch) throw new Error('setup projects');
    const create = (requestId: string, project: { projectId: string; version: number }) => {
      const created = registry.createConversation({
        requestId,
        projectId: project.projectId,
        projectVersion: project.version,
      });
      if (!created.accepted) throw new Error('setup conversation');
      return created.value.conversationId;
    };
    const worktrees = new WorktreeRegistry(path.join(root, 'worktrees.json'));
    const sessions = new AgentSessionIndex({ readSettings: () => null });
    const flags = { worktreeBusy: false, released: true };
    const ports: ConversationsMovePorts = {
      moveConversation: (id, targetId, options) => registry.moveConversation(id, targetId, options),
      isRunning: (id) => sessions.workspaceTreeRunning(id) || sessions.btwTreeRunning(id),
      worktreeBusy: () => flags.worktreeBusy,
      source: (id) => {
        const current = registry.conversation(id);
        const project = current && registry.project(current.projectId);
        return current
          ? {
              projectId: current.projectId,
              ...(project?.kind === 'scratch' ? { scratchRoot: project.canonicalPath } : {}),
            }
          : undefined;
      },
      readConversations: () => ({}),
      patchProjectIds: () => {},
      unbindWorktree: (id) => worktrees.delete(id),
      releaseSessions: async () => flags.released,
      removeScratchWorkspace,
    };
    const cwd = (id: string) =>
      spawnCwdFromAuthority(registry, (sessionId) => worktrees.get(sessionId)?.path, id);
    return {
      root,
      registry,
      projectA: projectA.value,
      projectB: projectB.value,
      scratch,
      create,
      worktrees,
      sessions,
      flags,
      ports,
      cwd,
    };
  };
  const bindWorktree = (env: ReturnType<typeof setup>, conversationId: string) => {
    const worktreePath = path.join(env.root, 'wt', conversationId);
    mkdirSync(worktreePath);
    env.worktrees.set({
      conversationId,
      projectId: env.projectA.projectId,
      repoPath: env.projectA.canonicalPath,
      path: worktreePath,
      branch: `enso/${conversationId}`,
      baseBranch: 'main',
      baseCommit: 'abc',
      createdAt: 1,
    });
    return worktreePath;
  };
  const ready = (sessions: AgentSessionIndex, identity: SessionIdentity) => {
    sessions.prepareParent(identity);
    sessions.observe({
      type: 'parent-ready',
      identity,
      seq: 1,
      sessionFile: `/tmp/${identity.sessionId}.jsonl`,
      model: { providerId: 'p', modelId: 'm' },
    });
  };

  it('moves a worktree-bound conversation onto the new project root and keeps the worktree directory', async () => {
    const env = setup();
    const id = env.create('c', env.projectA);
    const other = env.create('o', env.projectA);
    const worktreePath = bindWorktree(env, id);
    env.worktrees.share(id, other);
    expect(env.cwd(id)).toBe(worktreePath);
    const result = await handleConversationsMove(
      { conversationId: id, targetProjectId: env.projectB.projectId },
      env.ports
    );
    expect(result.ok).toBe(true);
    expect(env.cwd(id)).toBe(env.projectB.canonicalPath);
    expect(env.worktrees.get(id)).toBeUndefined();
    expect(env.worktrees.get(other)?.path).toBe(worktreePath);
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('rejects while the worktree is in use and leaves the binding alone', async () => {
    const env = setup();
    const id = env.create('c', env.projectA);
    const worktreePath = bindWorktree(env, id);
    env.flags.worktreeBusy = true;
    expect(
      await handleConversationsMove(
        { conversationId: id, targetProjectId: env.projectB.projectId },
        env.ports
      )
    ).toEqual({ ok: false, error: 'worktree-busy' });
    expect(env.registry.conversation(id)?.projectId).toBe(env.projectA.projectId);
    expect(env.cwd(id)).toBe(worktreePath);
  });

  it('rejects while a btw side session of the parent is running, then allows it once idle', async () => {
    const env = setup();
    const id = env.create('c', env.projectA);
    const generation = '11111111-1111-4111-8111-111111111111';
    ready(env.sessions, { sessionId: id, generation });
    const btw: SessionIdentity = { sessionId: 'btw-side', generation };
    ready(env.sessions, btw);
    env.sessions.linkBtw(btw.sessionId, id);
    env.sessions.observe({ type: 'status', identity: btw, seq: 2, status: 'running' });
    const move = () =>
      handleConversationsMove(
        { conversationId: id, targetProjectId: env.projectB.projectId },
        env.ports
      );
    expect(await move()).toEqual({ ok: false, error: 'running' });
    expect(env.registry.conversation(id)?.projectId).toBe(env.projectA.projectId);
    env.sessions.observe({ type: 'status', identity: btw, seq: 3, status: 'idle' });
    expect((await move()).ok).toBe(true);
    expect(env.registry.conversation(id)?.projectId).toBe(env.projectB.projectId);
  });

  it('removes only the scratch workspace of a temporary conversation added to a project', async () => {
    const env = setup();
    const id = env.create('c', env.scratch);
    const sibling = env.create('s', env.scratch);
    const scratchDir = path.join(env.scratch.canonicalPath, id);
    const siblingDir = path.join(env.scratch.canonicalPath, sibling);
    for (const dir of [scratchDir, siblingDir]) {
      mkdirSync(dir);
      writeFileSync(path.join(dir, 'note.txt'), 'x');
    }
    expect(env.cwd(id)).toBe(scratchDir);
    const result = await handleConversationsMove(
      { conversationId: id, targetProjectId: env.projectA.projectId },
      env.ports
    );
    expect(result.ok).toBe(true);
    expect(env.cwd(id)).toBe(env.projectA.canonicalPath);
    expect(existsSync(scratchDir)).toBe(false);
    expect(existsSync(siblingDir)).toBe(true);
    expect(existsSync(env.projectA.canonicalPath)).toBe(true);
  });

  it('keeps the scratch workspace when the live session could not be released', async () => {
    const env = setup();
    const id = env.create('c', env.scratch);
    const scratchDir = path.join(env.scratch.canonicalPath, id);
    mkdirSync(scratchDir);
    env.flags.released = false;
    expect(
      (
        await handleConversationsMove(
          { conversationId: id, targetProjectId: env.projectA.projectId },
          env.ports
        )
      ).ok
    ).toBe(true);
    expect(existsSync(scratchDir)).toBe(true);
  });

  it('does not touch a project directory when moving between ordinary projects', async () => {
    const env = setup();
    const id = env.create('c', env.projectA);
    expect(
      (
        await handleConversationsMove(
          { conversationId: id, targetProjectId: env.projectB.projectId },
          env.ports
        )
      ).ok
    ).toBe(true);
    expect(existsSync(env.projectA.canonicalPath)).toBe(true);
    expect(env.cwd(id)).toBe(env.projectB.canonicalPath);
  });
});
