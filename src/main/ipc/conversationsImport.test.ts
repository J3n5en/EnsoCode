import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseImportProjectSessionsInput } from '@shared/moveConversation';
import { describe, expect, it } from 'vitest';
import { AgentSessionIndex } from '../services/agentSessionIndex';
import { SourceAuthorityRegistry } from '../services/sourceAuthorityRegistry';
import {
  handleImportProjectSessions,
  handleRemoveEmptyProject,
  type ImportProjectSessionsPorts,
  projectRootConversationIds,
} from './conversationsMove';

describe('parseImportProjectSessionsInput', () => {
  it('accepts two distinct project ids only', () => {
    for (const mode of ['move', 'copy'] as const) {
      expect(
        parseImportProjectSessionsInput({ sourceProjectId: 'a', targetProjectId: 'b', mode })
      ).toEqual({ sourceProjectId: 'a', targetProjectId: 'b', mode });
    }
    for (const bad of [
      undefined,
      null,
      'x',
      {},
      { sourceProjectId: 'a' },
      { sourceProjectId: 'a', targetProjectId: '' },
      { sourceProjectId: 'a', targetProjectId: 'a' },
      { sourceProjectId: 1, targetProjectId: 'b' },
      { sourceProjectId: 'a', targetProjectId: 'b' },
      { sourceProjectId: 'a', targetProjectId: 'b', mode: 'link' },
      { sourceProjectId: 'a', targetProjectId: 'b', mode: 'move', extra: 1 },
    ]) {
      expect(parseImportProjectSessionsInput(bad)).toBeNull();
    }
  });
});

describe('handleImportProjectSessions', () => {
  const setup = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enso-import-'));
    for (const dir of ['a', 'b', 'c', 'sessions']) mkdirSync(path.join(root, dir));
    let broadcasts = 0;
    let rowPatches = 0;
    const registry = new SourceAuthorityRegistry({
      registryFile: path.join(root, 'auth.json'),
      onChanged: () => {
        broadcasts += 1;
      },
    });
    const project = (name: string) => {
      const created = registry.createProject({ requestId: name, path: path.join(root, name) });
      if (!created.accepted) throw new Error('setup project');
      return created.value;
    };
    const projectA = project('a');
    const projectB = project('b');
    const projectC = project('c');
    const rows: Record<string, Record<string, unknown>> = {};
    const create = (requestId: string, owner: { projectId: string; version: number }) => {
      const created = registry.createConversation({
        requestId,
        projectId: owner.projectId,
        projectVersion: owner.version,
      });
      if (!created.accepted) throw new Error('setup conversation');
      const id = created.value.conversationId;
      rows[id] = { id, title: requestId, projectId: owner.projectId };
      return id;
    };
    const sessions = new AgentSessionIndex({ readSettings: () => null });
    const ports: ImportProjectSessionsPorts = {
      sessionDir: path.join(root, 'sessions'),
      durableFiles: [],
      project: (projectId) => registry.project(projectId),
      conversation: (id) => registry.conversation(id),
      projectHasConversations: (projectId) =>
        registry
          .rendererProjection()
          .conversations.some((c) => c.projectId === projectId && c.lifecycle !== 'ended'),
      insertConversations: (targetId, records) => registry.insertConversations(targetId, records),
      discardConversations: (ids) => registry.discardConversations(ids),
      removeProject: (request) => registry.removeProject(request),
      addConversations: () => true,
      randomUuid: () => crypto.randomUUID(),
      projectKind: (projectId) => registry.project(projectId)?.kind,
      rootConversationIds: (projectId) =>
        projectRootConversationIds(registry.rendererProjection().conversations, projectId),
      moveConversations: (requests, targetId) => registry.moveConversations(requests, targetId),
      isRunning: (id) => sessions.workspaceTreeRunning(id) || sessions.btwTreeRunning(id),
      worktreeBusy: () => false,
      readConversations: () => rows,
      patchProjectIds: (ids, targetProjectId) => {
        rowPatches += 1;
        for (const id of ids) if (rows[id]) rows[id].projectId = targetProjectId;
      },
      unbindWorktree: () => {},
      releaseSessions: async () => true,
    };
    const importInto = (from: { projectId: string }, to: { projectId: string }) =>
      handleImportProjectSessions(
        { sourceProjectId: from.projectId, targetProjectId: to.projectId, mode: 'move' },
        ports
      );
    const owner = (id: string) => registry.conversation(id)?.projectId;
    return {
      root,
      registry,
      projectA,
      projectB,
      projectC,
      rows,
      create,
      sessions,
      importInto,
      owner,
      ports,
      broadcasts: () => broadcasts,
      rowPatches: () => rowPatches,
    };
  };

  it('commits a multi-conversation import as one authority change and one row patch', async () => {
    const env = setup();
    const ids = ['one', 'two', 'three'].map((name) => env.create(name, env.projectA));
    const before = env.broadcasts();
    const result = await env.importInto(env.projectA, env.projectB);
    expect(result).toMatchObject({ ok: true, skipped: [] });
    expect(result.ok && [...result.imported].sort()).toEqual([...ids].sort());
    expect(env.broadcasts() - before).toBe(1);
    expect(env.rowPatches()).toBe(1);
    for (const id of ids) expect(env.rows[id].projectId).toBe(env.projectB.projectId);
  });

  it('rejects a scratch source project without moving or deleting anything', async () => {
    const env = setup();
    const scratchDir = path.join(env.root, 'scratch');
    const scratch = env.registry.ensureScratchProject(scratchDir);
    if (!scratch) throw new Error('setup scratch');
    const id = env.create('temp', scratch);
    mkdirSync(path.join(scratchDir, id));
    expect(await env.importInto(scratch, env.projectB)).toEqual({
      ok: false,
      error: 'source-scratch',
    });
    expect(env.owner(id)).toBe(scratch.projectId);
    expect(env.rows[id].projectId).toBe(scratch.projectId);
    expect(existsSync(path.join(scratchDir, id))).toBe(true);
  });

  it('moves every root conversation of project A onto project B', async () => {
    const env = setup();
    const first = env.create('first', env.projectA);
    const second = env.create('second', env.projectA);
    const untouched = env.create('other', env.projectC);
    const result = await env.importInto(env.projectA, env.projectB);
    expect(result).toEqual({
      ok: true,
      mode: 'move',
      imported: expect.arrayContaining([first, second]),
      skipped: [],
      sourceEmpty: true,
    });
    expect(env.owner(first)).toBe(env.projectB.projectId);
    expect(env.owner(second)).toBe(env.projectB.projectId);
    expect(env.rows[first].projectId).toBe(env.projectB.projectId);
    expect(env.rows[second].projectId).toBe(env.projectB.projectId);
    expect(env.owner(untouched)).toBe(env.projectC.projectId);
    expect(env.rows[untouched].projectId).toBe(env.projectC.projectId);
    expect(
      projectRootConversationIds(
        env.registry.rendererProjection().conversations,
        env.projectA.projectId
      )
    ).toEqual([]);
  });

  it('skips and reports running conversations, leaving them on the source project', async () => {
    const env = setup();
    const idle = env.create('idle', env.projectA);
    const busy = env.create('busy', env.projectA);
    const identity = { sessionId: busy, generation: '11111111-1111-4111-8111-111111111111' };
    env.sessions.prepareParent(identity);
    env.sessions.observe({
      type: 'parent-ready',
      identity,
      seq: 1,
      sessionFile: `/tmp/${busy}.jsonl`,
      model: { providerId: 'p', modelId: 'm' },
    });
    env.sessions.observe({ type: 'status', identity, seq: 2, status: 'running' });
    const result = await env.importInto(env.projectA, env.projectB);
    expect(result).toEqual({
      ok: true,
      mode: 'move',
      imported: [idle],
      skipped: [{ conversationId: busy, error: 'running' }],
      sourceEmpty: false,
    });
    expect(env.owner(busy)).toBe(env.projectA.projectId);
    expect(env.rows[busy].projectId).toBe(env.projectA.projectId);
    expect(env.owner(idle)).toBe(env.projectB.projectId);
  });

  it('moves child, nested and btw conversations together with their parent', async () => {
    const env = setup();
    const parent = env.create('parent', env.projectA);
    env.rows.child = { id: 'child', parentId: parent, projectId: env.projectA.projectId };
    env.rows.nested = { id: 'nested', parentId: 'child', projectId: env.projectA.projectId };
    env.rows.btw = { id: 'btw', btwParentId: parent, projectId: env.projectA.projectId };
    await env.importInto(env.projectA, env.projectB);
    for (const id of [parent, 'child', 'nested', 'btw']) {
      expect(env.rows[id].projectId).toBe(env.projectB.projectId);
    }
  });

  it('is idempotent when the same project is imported twice', async () => {
    const env = setup();
    const id = env.create('c', env.projectA);
    await env.importInto(env.projectA, env.projectB);
    const version = env.registry.conversation(id)?.version;
    expect(await env.importInto(env.projectA, env.projectB)).toEqual({
      ok: true,
      mode: 'move',
      imported: [],
      skipped: [],
      sourceEmpty: true,
    });
    expect(env.owner(id)).toBe(env.projectB.projectId);
    expect(env.registry.conversation(id)?.version).toBe(version);
    expect(Object.keys(env.rows)).toEqual([id]);
  });

  it('moves archived conversations too and keeps them archived', async () => {
    const env = setup();
    const id = env.create('archived', env.projectA);
    Object.assign(env.rows[id], { archived: true, archivedAt: 1 });
    await env.importInto(env.projectA, env.projectB);
    expect(env.owner(id)).toBe(env.projectB.projectId);
    expect(env.rows[id]).toMatchObject({
      projectId: env.projectB.projectId,
      archived: true,
      archivedAt: 1,
    });
  });

  it('only changes ownership and leaves the session jsonl untouched', async () => {
    const env = setup();
    const id = env.create('c', env.projectA);
    const sessionFile = path.join(env.root, 'sessions', `${id}.jsonl`);
    const body = '{"type":"session","cwd":"/old/path"}\n{"type":"message"}\n';
    writeFileSync(sessionFile, body);
    env.registry.markReady(id, sessionFile, { providerId: 'p', modelId: 'm' });
    const before = statSync(sessionFile).mtimeMs;
    await env.importInto(env.projectA, env.projectB);
    expect(readFileSync(sessionFile, 'utf8')).toBe(body);
    expect(statSync(sessionFile).mtimeMs).toBe(before);
    expect(env.registry.conversation(id)?.sessionFile).toBe(sessionFile);
    expect(env.owner(id)).toBe(env.projectB.projectId);
  });

  it('rejects an unavailable target without moving anything', async () => {
    const env = setup();
    const id = env.create('c', env.projectA);
    expect(await env.importInto(env.projectA, { projectId: 'missing-project' })).toEqual({
      ok: false,
      error: 'target-unavailable',
    });
    expect(env.owner(id)).toBe(env.projectA.projectId);
  });

  it('rejects malformed input', async () => {
    const env = setup();
    expect(await env.importInto(env.projectA, env.projectA)).toEqual({
      ok: false,
      error: 'invalid',
    });
  });
  it('removes an emptied source project from the list without deleting any file or directory', async () => {
    const env = setup();
    env.create('c', env.projectA);
    const ended = env.create('ended', env.projectA);
    const endedFile = path.join(env.root, 'sessions', 'ended.jsonl');
    writeFileSync(endedFile, '{"type":"session"}\n');
    env.registry.markReady(ended, endedFile, { providerId: 'p', modelId: 'm' });
    const version = env.registry.conversation(ended)?.version ?? 0;
    expect(
      env.registry.endConversation({ requestId: 'end', conversationId: ended, version }).accepted
    ).toBe(true);
    delete env.rows[ended];
    const kept = path.join(env.root, 'a', 'keep.txt');
    writeFileSync(kept, 'keep');
    const worktree = path.join(env.root, 'a', '.worktrees', 'wt');
    mkdirSync(worktree, { recursive: true });
    await env.importInto(env.projectA, env.projectB);
    expect(handleRemoveEmptyProject({ projectId: env.projectA.projectId }, env.ports)).toEqual({
      ok: true,
    });
    expect(env.registry.project(env.projectA.projectId)?.state).toBe('removed');
    expect(readFileSync(kept, 'utf8')).toBe('keep');
    expect(existsSync(worktree)).toBe(true);
    expect(readFileSync(endedFile, 'utf8')).toBe('{"type":"session"}\n');
  });

  it('refuses to remove a project that still has conversations', async () => {
    const env = setup();
    const id = env.create('c', env.projectA);
    expect(handleRemoveEmptyProject({ projectId: env.projectA.projectId }, env.ports)).toEqual({
      ok: false,
      error: 'not-empty',
    });
    expect(env.registry.project(env.projectA.projectId)?.state).toBe('active');
    expect(env.owner(id)).toBe(env.projectA.projectId);
    expect(handleRemoveEmptyProject({ projectId: 'missing' }, env.ports)).toEqual({
      ok: false,
      error: 'unavailable',
    });
    expect(handleRemoveEmptyProject({}, env.ports)).toEqual({ ok: false, error: 'invalid' });
  });
});
