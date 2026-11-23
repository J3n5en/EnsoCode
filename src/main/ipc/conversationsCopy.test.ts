import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentSessionIndex } from '../services/agentSessionIndex';
import { SourceAuthorityRegistry } from '../services/sourceAuthorityRegistry';
import {
  handleImportProjectSessions,
  handleImportProjectSessionsPreview,
  type ImportProjectSessionsPorts,
  projectRootConversationIds,
} from './conversationsMove';

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 目录下全部文件 → sha256，用来断言「源文件一个字节都没变」和「失败后没有残留」 */
function tree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) Object.assign(out, tree(full, base));
    else out[path.relative(base, full)] = sha(full);
  }
  return out;
}

const journalName = (childId: string, generation: string) =>
  `enso-${childId.replace(/[^A-Za-z0-9._-]/g, '_')}-${generation}.jsonl`;

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'enso-copy-'));
  const agentDir = path.join(root, 'agent');
  const sessionDir = path.join(agentDir, 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  for (const dir of ['a', 'b']) mkdirSync(path.join(root, dir));
  let broadcasts = 0;
  let rowPatches = 0;
  const registry = new SourceAuthorityRegistry({
    registryFile: path.join(agentDir, 'source-registry.json'),
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
  const state: { conversations: Record<string, Record<string, unknown>>; order: string[] } = {
    conversations: {},
    order: [],
  };

  /** 一条带完整附属物的根会话：pi jsonl、子会话 journal、child-runs 目录、超长输出、粘贴文本 */
  const createRoot = (
    title: string,
    extra: {
      forkedFrom?: { conversationId: string; entryId: string };
      parentSession?: string;
      row?: Record<string, unknown>;
    } = {}
  ) => {
    const created = registry.createConversation({
      requestId: title,
      projectId: projectA.projectId,
      projectVersion: projectA.version,
      ...(extra.forkedFrom ? { forkedFrom: extra.forkedFrom } : {}),
    });
    if (!created.accepted) throw new Error('setup conversation');
    const id = created.value.conversationId;
    const piId = randomUUID();
    const sessionFile = path.join(sessionDir, `2026-01-01T00-00-00-000Z_${piId}.jsonl`);
    const childId = `${id}::cw-helper`;
    const pasted = path.join(sessionDir, 'pasted-text', id, 'abcd1234', 'pasted-text.txt');
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: piId,
          cwd: path.join(root, 'a'),
          ...(extra.parentSession ? { parentSession: extra.parentSession } : {}),
        }),
        JSON.stringify({ type: 'message', id: 'e1', text: `read ${pasted}` }),
        JSON.stringify({
          type: 'custom',
          customType: 'agent-dispatch',
          data: { child: { sessionId: childId, generation: 'gen1' } },
        }),
        '',
      ].join('\n')
    );
    registry.markReady(id, sessionFile, { providerId: 'p', modelId: 'm' });
    const journal = journalName(childId, 'gen1');
    writeFileSync(
      path.join(sessionDir, journal),
      `${JSON.stringify({ sessionId: childId, text: 'child work' })}\n`
    );
    mkdirSync(path.join(sessionDir, 'child-runs'), { recursive: true });
    writeFileSync(
      path.join(sessionDir, 'child-runs', `${id}.jsonl`),
      `${JSON.stringify({ v: 1, childId, name: 'helper', file: journal, startedAt: 1 })}\n`
    );
    mkdirSync(path.join(sessionDir, 'tool-output', id), { recursive: true });
    writeFileSync(path.join(sessionDir, 'tool-output', id, 'out.txt'), 'long output');
    mkdirSync(path.dirname(pasted), { recursive: true });
    writeFileSync(pasted, 'pasted');
    state.conversations[id] = {
      id,
      title,
      projectId: projectA.projectId,
      sessionFile,
      coworkerIds: [childId],
      createdAt: 1,
      messages: [],
      ...(extra.forkedFrom
        ? {
            forkedFromConversationId: extra.forkedFrom.conversationId,
            forkedFromEntryId: extra.forkedFrom.entryId,
          }
        : {}),
      ...extra.row,
    };
    state.conversations[childId] = {
      id: childId,
      title: 'helper',
      projectId: projectA.projectId,
      parentId: id,
      child: { parentId: id, childGeneration: 'gen1', agentInstanceName: 'helper' },
      sessionFile: path.join(sessionDir, journal),
      createdAt: 1,
      messages: [],
    };
    state.order.push(id);
    return { id, sessionFile, childId, piId };
  };

  const sessions = new AgentSessionIndex({ readSettings: () => null });
  let failRows = false;
  let failInsert = false;
  const ports: ImportProjectSessionsPorts = {
    sessionDir,
    durableFiles: [],
    projectKind: (projectId) => registry.project(projectId)?.kind,
    project: (projectId) => registry.project(projectId),
    conversation: (id) => registry.conversation(id),
    rootConversationIds: (projectId) =>
      projectRootConversationIds(registry.rendererProjection().conversations, projectId),
    projectHasConversations: (projectId) =>
      registry
        .rendererProjection()
        .conversations.some((c) => c.projectId === projectId && c.lifecycle !== 'ended'),
    moveConversations: (requests, targetId) => registry.moveConversations(requests, targetId),
    insertConversations: (targetId, records) => {
      if (failInsert) throw new Error('disk full');
      return registry.insertConversations(targetId, records);
    },
    discardConversations: (ids) => registry.discardConversations(ids),
    removeProject: (request) => registry.removeProject(request),
    isRunning: (id) => sessions.workspaceTreeRunning(id) || sessions.btwTreeRunning(id),
    worktreeBusy: () => false,
    readConversations: () => state.conversations,
    patchProjectIds: (ids, targetProjectId) => {
      rowPatches += 1;
      for (const id of ids)
        if (state.conversations[id]) state.conversations[id].projectId = targetProjectId;
    },
    addConversations: (rows, placeBefore) => {
      rowPatches += 1;
      if (failRows) return false;
      Object.assign(state.conversations, rows);
      for (const [id, before] of Object.entries(placeBefore)) {
        const at = state.order.indexOf(before);
        state.order.splice(at < 0 ? 0 : at, 0, id);
      }
      return true;
    },
    unbindWorktree: () => {},
    releaseSessions: async () => true,
    randomUuid: () => randomUUID(),
  };
  const copy = () =>
    handleImportProjectSessions(
      { sourceProjectId: projectA.projectId, targetProjectId: projectB.projectId, mode: 'copy' },
      ports
    );
  return {
    root,
    sessionDir,
    registry,
    projectA,
    projectB,
    state,
    sessions,
    createRoot,
    copy,
    ports,
    broadcasts: () => broadcasts,
    rowPatches: () => rowPatches,
    failRows: () => {
      failRows = true;
    },
    failInsert: () => {
      failInsert = true;
    },
    authoritySnapshot: () => JSON.stringify(registry.rendererProjection().conversations),
  };
}

describe('copy a whole project into another', () => {
  it('leaves every source file byte-for-byte unchanged and the source still owns its conversations', async () => {
    const env = setup();
    const first = env.createRoot('first');
    env.createRoot('second');
    const before = tree(env.sessionDir);
    const sourceRows = JSON.stringify(
      Object.fromEntries(
        Object.entries(env.state.conversations).filter(
          ([, row]) => row.projectId === env.projectA.projectId
        )
      )
    );
    const result = await env.copy();
    expect(result).toMatchObject({ ok: true, mode: 'copy', skipped: [], sourceEmpty: false });
    const after = tree(env.sessionDir);
    for (const [file, hash] of Object.entries(before)) expect(after[file]).toBe(hash);
    expect(env.registry.conversation(first.id)?.projectId).toBe(env.projectA.projectId);
    expect(env.registry.conversation(first.id)?.sessionFile).toBe(first.sessionFile);
    expect(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(env.state.conversations).filter(
            ([, row]) => row.projectId === env.projectA.projectId
          )
        )
      )
    ).toBe(sourceRows);
  });

  it('gives copies fresh ids and new files, and remaps child and fork links onto the copies', async () => {
    const env = setup();
    const source = env.createRoot('source', {
      row: {
        worktree: { path: '/wt', branch: 'b' },
        unread: true,
        queuedMessages: [{ text: 'x' }],
        goal: { objective: 'g' },
        driver: 'main',
        secretaryOrigin: { secretaryConversationId: 's' },
        pendingWorkspaceNote: 'n',
        activeRenewedAt: 5,
      },
    });
    const fork = env.createRoot('fork', {
      forkedFrom: { conversationId: source.id, entryId: 'e1' },
      parentSession: source.sessionFile,
    });
    const result = await env.copy();
    if (!result.ok) throw new Error(result.error);
    expect(result.imported).toHaveLength(2);
    const copies = result.imported.map((id) => env.state.conversations[id]);
    const sourceCopy = copies.find((row) => row.title === 'source') as Record<string, unknown>;
    const forkCopy = copies.find((row) => row.title === 'fork') as Record<string, unknown>;
    const sourceCopyId = sourceCopy.id as string;
    const forkCopyId = forkCopy.id as string;
    for (const id of [sourceCopyId, forkCopyId]) {
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect([source.id, fork.id]).not.toContain(id);
    }

    const authority = env.registry.conversation(sourceCopyId);
    expect(authority).toMatchObject({ projectId: env.projectB.projectId, lifecycle: 'ready' });
    expect(authority?.sessionFile).not.toBe(source.sessionFile);
    expect(path.dirname(authority?.sessionFile ?? '')).toBe(env.sessionDir);
    const copiedText = readFileSync(authority?.sessionFile ?? '', 'utf8');
    expect(copiedText).not.toContain(source.id);
    expect(copiedText).not.toContain(source.piId);
    expect(copiedText).toContain(`${sourceCopyId}::cw-helper`);
    expect(copiedText).toContain(path.join('pasted-text', sourceCopyId));
    expect(
      readFileSync(
        path.join(env.sessionDir, 'pasted-text', sourceCopyId, 'abcd1234', 'pasted-text.txt'),
        'utf8'
      )
    ).toBe('pasted');
    expect(
      readFileSync(path.join(env.sessionDir, 'tool-output', sourceCopyId, 'out.txt'), 'utf8')
    ).toBe('long output');

    const childCopyId = `${sourceCopyId}::cw-helper`;
    const childCopy = env.state.conversations[childCopyId];
    expect(childCopy).toMatchObject({
      parentId: sourceCopyId,
      projectId: env.projectB.projectId,
      child: { parentId: sourceCopyId, childGeneration: 'gen1' },
    });
    expect(childCopy.sessionFile).toBe(path.join(env.sessionDir, journalName(childCopyId, 'gen1')));
    expect(readFileSync(childCopy.sessionFile as string, 'utf8')).toContain(childCopyId);
    expect(sourceCopy.coworkerIds).toEqual([childCopyId]);
    expect(
      readFileSync(path.join(env.sessionDir, 'child-runs', `${sourceCopyId}.jsonl`), 'utf8')
    ).toContain(journalName(childCopyId, 'gen1'));

    expect(env.registry.conversation(forkCopyId)?.forkedFrom).toEqual({
      conversationId: sourceCopyId,
      entryId: 'e1',
    });
    expect(forkCopy.forkedFromConversationId).toBe(sourceCopyId);
    const forkHeader = JSON.parse(
      readFileSync(env.registry.conversation(forkCopyId)?.sessionFile ?? '', 'utf8').split('\n')[0]
    );
    expect(forkHeader.parentSession).toBe(authority?.sessionFile);

    expect(sourceCopy).toMatchObject({
      projectId: env.projectB.projectId,
      copiedFrom: { projectId: env.projectA.projectId, conversationId: source.id },
    });
    for (const key of [
      'worktree',
      'unread',
      'queuedMessages',
      'goal',
      'driver',
      'secretaryOrigin',
      'pendingWorkspaceNote',
      'activeRenewedAt',
    ]) {
      expect(sourceCopy).not.toHaveProperty(key);
    }
    expect(env.state.order.indexOf(sourceCopyId)).toBe(env.state.order.indexOf(source.id) - 1);
  });

  it('commits the copy as one authority change and one row patch', async () => {
    const env = setup();
    env.createRoot('one');
    env.createRoot('two');
    env.createRoot('three');
    const before = env.broadcasts();
    const result = await env.copy();
    expect(result.ok && result.imported).toHaveLength(3);
    expect(env.broadcasts() - before).toBe(1);
    expect(env.rowPatches()).toBe(1);
  });

  it('copies again on a second run and reports how many copies already exist', async () => {
    const env = setup();
    const source = env.createRoot('source');
    const preview = () =>
      handleImportProjectSessionsPreview(
        { sourceProjectId: env.projectA.projectId, targetProjectId: env.projectB.projectId },
        env.ports
      );
    expect(preview()).toEqual({ ok: true, sourceExists: true, copies: 0 });
    const first = await env.copy();
    const second = await env.copy();
    if (!first.ok || !second.ok) throw new Error('copy failed');
    expect(first.imported[0]).not.toBe(second.imported[0]);
    expect(env.registry.conversation(source.id)?.projectId).toBe(env.projectA.projectId);
    expect(preview()).toEqual({ ok: true, sourceExists: true, copies: 2 });
  });

  it('reports a missing source directory so the dialog can default to move', () => {
    const env = setup();
    mkdirSync(path.join(env.root, 'gone'));
    const created = env.registry.createProject({
      requestId: 'gone',
      path: path.join(env.root, 'gone'),
    });
    if (!created.accepted) throw new Error('setup');
    rmSync(path.join(env.root, 'gone'), { recursive: true });
    expect(
      handleImportProjectSessionsPreview(
        { sourceProjectId: created.value.projectId, targetProjectId: env.projectB.projectId },
        env.ports
      )
    ).toEqual({ ok: true, sourceExists: false, copies: 0 });
  });

  it('skips running conversations and reports them', async () => {
    const env = setup();
    const idle = env.createRoot('idle');
    const busy = env.createRoot('busy');
    const identity = { sessionId: busy.id, generation: '11111111-1111-4111-8111-111111111111' };
    env.sessions.prepareParent(identity);
    env.sessions.observe({
      type: 'parent-ready',
      identity,
      seq: 1,
      sessionFile: busy.sessionFile,
      model: { providerId: 'p', modelId: 'm' },
    });
    env.sessions.observe({ type: 'status', identity, seq: 2, status: 'running' });
    const result = await env.copy();
    if (!result.ok) throw new Error(result.error);
    expect(result.skipped).toEqual([{ conversationId: busy.id, error: 'running' }]);
    expect(result.imported).toHaveLength(1);
    expect(env.state.conversations[result.imported[0]]).toMatchObject({
      copiedFrom: { conversationId: idle.id },
    });
  });

  describe('a failure part way leaves nothing behind', () => {
    const expectUntouched = async (env: ReturnType<typeof setup>, breakIt: () => void) => {
      env.createRoot('one');
      env.createRoot('two');
      const files = tree(path.dirname(env.sessionDir));
      const authority = env.authoritySnapshot();
      const rows = JSON.stringify(env.state);
      breakIt();
      const result = await env.copy();
      expect(result.ok).toBe(false);
      const { 'source-registry.json': _registryBefore, ...filesBefore } = files;
      const { 'source-registry.json': _registryAfter, ...filesAfter } = tree(
        path.dirname(env.sessionDir)
      );
      expect(filesAfter).toEqual(filesBefore);
      expect(env.authoritySnapshot()).toBe(authority);
      expect(JSON.stringify(env.state)).toBe(rows);
    };

    it('when a file cannot be read', async () => {
      const env = setup();
      await expectUntouched(env, () => {
        const id = Object.keys(env.state.conversations).find((key) => !key.includes('::'));
        mkdirSync(path.join(env.sessionDir, journalName(`${id}::cw-broken`, 'gen9')));
      });
    });

    it('when the authority write fails', async () => {
      const env = setup();
      await expectUntouched(env, env.failInsert);
    });

    it('when the row patch is rejected', async () => {
      const env = setup();
      await expectUntouched(env, env.failRows);
    });
  });
});
