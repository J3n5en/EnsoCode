import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentSessionIndex } from '../services/agentSessionIndex';
import { SourceAuthorityRegistry } from '../services/sourceAuthorityRegistry';
import {
  handleImportProjectSessions,
  type ImportProjectSessionsPorts,
  projectRootConversationIds,
  recoverProjectImports,
} from './conversationsMove';

/** 每个文件系统写操作前后都是一个崩溃点：在那一刻把整个数据目录拍下来，当作下次启动看到的磁盘 */
const hooks = vi.hoisted(() => ({ checkpoint: (_name: string) => {} }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      hooks.checkpoint(`before ${name}`);
      const result = await fn(...args);
      hooks.checkpoint(`after ${name}`);
      return result;
    };
  return {
    ...actual,
    rename: wrap('rename', actual.rename),
    cp: wrap('cp', actual.cp),
    rm: wrap('rm', actual.rm),
  };
});

type Rows = { conversations: Record<string, Record<string, unknown>>; order: string[] };
type Bindings = Record<string, { projectId: string; path: string }>;

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

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

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8'));

/** 一次「进程」：权威表、会话行（settings）、worktree 登记都从 root 下的文件读，写入立即落盘 */
function boot(root: string) {
  const files = {
    registry: path.join(root, 'agent', 'source-registry.json'),
    rows: path.join(root, 'settings.json'),
    worktrees: path.join(root, 'worktrees.json'),
  };
  const sessionDir = path.join(root, 'agent', 'sessions');
  const registry = new SourceAuthorityRegistry({ registryFile: files.registry });
  const rows: Rows = existsSync(files.rows)
    ? readJson(files.rows)
    : { conversations: {}, order: [] };
  const bindings: Bindings = existsSync(files.worktrees) ? readJson(files.worktrees) : {};
  const saveRows = () => writeFileSync(files.rows, JSON.stringify(rows));
  const saveBindings = () => writeFileSync(files.worktrees, JSON.stringify(bindings));
  const point =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      hooks.checkpoint(`before ${name}`);
      const result = fn(...args);
      hooks.checkpoint(`after ${name}`);
      return result;
    };
  const sessions = new AgentSessionIndex({ readSettings: () => null });
  const ports: ImportProjectSessionsPorts = {
    sessionDir,
    durableFiles: Object.values(files),
    project: (projectId) => registry.project(projectId),
    projectKind: (projectId) => registry.project(projectId)?.kind,
    conversation: (id) => registry.conversation(id),
    rootConversationIds: (projectId) =>
      projectRootConversationIds(registry.rendererProjection().conversations, projectId),
    projectHasConversations: (projectId) =>
      registry
        .rendererProjection()
        .conversations.some((c) => c.projectId === projectId && c.lifecycle !== 'ended'),
    moveConversations: point('moveConversations', (requests, targetId) =>
      registry.moveConversations(requests, targetId)
    ),
    insertConversations: point('insertConversations', (targetId, records) =>
      registry.insertConversations(targetId, records)
    ),
    discardConversations: point('discardConversations', (ids) =>
      registry.discardConversations(ids)
    ),
    removeProject: (request) => registry.removeProject(request),
    isRunning: (id) => sessions.workspaceTreeRunning(id) || sessions.btwTreeRunning(id),
    worktreeBusy: () => false,
    readConversations: () => rows.conversations,
    addConversations: point('addConversations', (added, placeBefore) => {
      Object.assign(rows.conversations, added);
      for (const [id, before] of Object.entries(placeBefore)) {
        const at = rows.order.indexOf(before);
        rows.order.splice(at < 0 ? 0 : at, 0, id);
      }
      saveRows();
      return true;
    }),
    patchProjectIds: point('patchProjectIds', (ids, targetProjectId, rootIds) => {
      for (const id of ids) {
        const row = rows.conversations[id];
        if (row) row.projectId = targetProjectId;
      }
      for (const id of rootIds) delete rows.conversations[id]?.worktree;
      saveRows();
    }),
    unbindWorktree: point('unbindWorktree', (id) => {
      delete bindings[id];
      saveBindings();
    }),
    releaseSessions: async () => true,
    randomUuid: () => randomUUID(),
  };
  return { root, sessionDir, files, registry, rows, bindings, ports, saveRows, saveBindings };
}

const UNRELATED = ['2025-01-01T00-00-00-000Z_9e1f0c3a-1111-4111-8111-111111111111.jsonl'];

/** 源项目 a 下两条根会话，各带子会话 journal、child-runs、超长输出、粘贴文本；另放几份与复制无关的用户文件 */
function world() {
  const root = mkdtempSync(path.join(tmpdir(), 'enso-import-crash-'));
  for (const dir of ['a', 'b']) mkdirSync(path.join(root, dir));
  mkdirSync(path.join(root, 'agent', 'sessions'), { recursive: true });
  const env = boot(root);
  const project = (name: string) => {
    const created = env.registry.createProject({ requestId: name, path: path.join(root, name) });
    if (!created.accepted) throw new Error('setup project');
    return created.value;
  };
  const projectA = project('a');
  const projectB = project('b');
  const dir = env.sessionDir;
  for (const title of ['one', 'two']) {
    const created = env.registry.createConversation({
      requestId: title,
      projectId: projectA.projectId,
      projectVersion: projectA.version,
    });
    if (!created.accepted) throw new Error('setup conversation');
    const id = created.value.conversationId;
    const piId = randomUUID();
    const sessionFile = path.join(dir, `2026-01-01T00-00-00-000Z_${piId}.jsonl`);
    const childId = `${id}::cw-helper`;
    const journal = `enso-${childId.replace(/[^A-Za-z0-9._-]/g, '_')}-gen1.jsonl`;
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'session', id: piId })}\n${JSON.stringify({ child: childId })}\n`
    );
    env.registry.markReady(id, sessionFile, { providerId: 'p', modelId: 'm' });
    writeFileSync(path.join(dir, journal), `${JSON.stringify({ sessionId: childId })}\n`);
    mkdirSync(path.join(dir, 'child-runs'), { recursive: true });
    writeFileSync(
      path.join(dir, 'child-runs', `${id}.jsonl`),
      `${JSON.stringify({ v: 1, childId, file: journal })}\n`
    );
    mkdirSync(path.join(dir, 'tool-output', id), { recursive: true });
    writeFileSync(path.join(dir, 'tool-output', id, 'out.txt'), 'long output');
    mkdirSync(path.join(dir, 'pasted-text', id, 'abcd'), { recursive: true });
    writeFileSync(path.join(dir, 'pasted-text', id, 'abcd', 'pasted-text.txt'), 'pasted');
    const worktree = { projectId: projectA.projectId, path: path.join(root, `wt-${title}`) };
    env.bindings[id] = worktree;
    env.rows.conversations[id] = {
      id,
      title,
      projectId: projectA.projectId,
      sessionFile,
      coworkerIds: [childId],
      worktree,
    };
    env.rows.conversations[childId] = {
      id: childId,
      title: 'helper',
      projectId: projectA.projectId,
      parentId: id,
      sessionFile: path.join(dir, journal),
    };
    env.rows.order.push(id);
  }
  for (const name of UNRELATED) writeFileSync(path.join(dir, name), 'user data');
  mkdirSync(path.join(dir, 'tool-output', randomUUID()), { recursive: true });
  writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
  env.saveRows();
  env.saveBindings();
  return { root, projectA, projectB };
}

interface Before {
  sessions: Record<string, string>;
  targetProjectId: string;
  point: string;
}

/** 先完整跑一遍数出崩溃点，再在每个崩溃点拍下磁盘、在快照上启动恢复 */
async function crashAtEveryPoint(
  mode: 'copy' | 'move',
  check: (recovered: ReturnType<typeof boot>, before: Before) => void
) {
  const run = async (crashAt: number) => {
    const setup = world();
    const start = boot(setup.root);
    const sessions = tree(start.sessionDir);
    const snapshot = path.join(tmpdir(), `enso-import-crashed-${randomUUID()}`);
    let seen = 0;
    let point = '';
    hooks.checkpoint = (name) => {
      seen += 1;
      if (seen !== crashAt) return;
      point = `#${seen} ${name}`;
      cpSync(setup.root, snapshot, { recursive: true });
    };
    const result = await handleImportProjectSessions(
      {
        sourceProjectId: setup.projectA.projectId,
        targetProjectId: setup.projectB.projectId,
        mode,
      },
      start.ports
    );
    hooks.checkpoint = () => {};
    expect(result.ok).toBe(true);
    if (crashAt === 0) return seen;
    await recoverProjectImports(boot(snapshot).ports);
    check(boot(snapshot), { sessions, targetProjectId: setup.projectB.projectId, point });
    const once = tree(snapshot);
    await recoverProjectImports(boot(snapshot).ports);
    expect(tree(snapshot), `${point} 恢复可重复执行`).toEqual(once);
    return seen;
  };
  const points = await run(0);
  expect(points).toBeGreaterThan(5);
  for (let at = 1; at <= points; at += 1) await run(at);
}

/** sessions 目录与权威表之外，agent 目录下不该留下任何文件（暂存副本、事务记录） */
const residue = (env: ReturnType<typeof boot>) =>
  Object.keys(tree(path.join(env.root, 'agent'))).filter(
    (file) => !file.startsWith(`sessions${path.sep}`) && file !== 'source-registry.json'
  );

describe('整项目导入在任意崩溃点之后启动恢复', () => {
  it('复制：没有孤儿副本、没有半登记，源文件与无关文件一个字节不变', async () => {
    await crashAtEveryPoint('copy', (env, { sessions: before, targetProjectId, point }) => {
      const after = tree(env.sessionDir);
      expect(after, `${point} 源文件或无关文件被改`).toMatchObject(before);

      const copies = env.registry
        .rendererProjection()
        .conversations.filter((c) => c.projectId === targetProjectId);
      expect([0, 2], `${point} 登记了 ${copies.length} 条`).toContain(copies.length);
      const rows = readJson<Rows>(env.files.rows).conversations;
      const copyRows = Object.values(rows).filter((row) => row.projectId === targetProjectId);
      const newFiles = Object.keys(after).filter((file) => !(file in before));
      if (copies.length === 0) {
        expect(copyRows, point).toEqual([]);
        expect(newFiles, `${point} 孤儿文件`).toEqual([]);
      } else {
        expect(copyRows, point).toHaveLength(4);
        const copyIds = copies.map((c) => c.conversationId);
        for (const id of copyIds) expect(rows[id], point).toBeDefined();
        const referenced = new Set(copyRows.map((row) => path.basename(String(row.sessionFile))));
        const sourceFiles = Object.keys(before).filter(
          (file) => !UNRELATED.includes(file) && file !== 'notes.txt'
        );
        expect(newFiles, point).toHaveLength(sourceFiles.length);
        for (const file of newFiles) {
          expect(
            referenced.has(path.basename(file)) || copyIds.some((id) => file.includes(id)),
            `${point} 无主文件 ${file}`
          ).toBe(true);
        }
      }
      expect(residue(env), `${point} 暂存或事务记录残留`).toEqual([]);
    });
  }, 60_000);

  it('移动：归属、会话行与 worktree 解绑要么全做完要么都没做，会话文件不动', async () => {
    await crashAtEveryPoint('move', (env, { sessions, targetProjectId, point }) => {
      expect(tree(env.sessionDir), point).toEqual(sessions);
      const rows = readJson<Rows>(env.files.rows).conversations;
      const bindings = readJson<Bindings>(env.files.worktrees);
      const roots = Object.values(rows).filter((row) => !row.parentId);
      const owners = new Set(
        roots.map((row) => env.registry.conversation(String(row.id))?.projectId)
      );
      expect(owners.size, `${point} 只移了一部分`).toBe(1);
      for (const root of roots) {
        const id = String(root.id);
        const owner = env.registry.conversation(id)?.projectId;
        const family = Object.values(rows).filter((row) => row.id === id || row.parentId === id);
        for (const row of family) expect(row.projectId, `${point} 会话行归属`).toBe(owner);
        if (owner === targetProjectId) {
          expect(bindings[id], `${point} worktree 未解绑`).toBeUndefined();
          expect(root.worktree, `${point} 行上 worktree 未清`).toBeUndefined();
        } else {
          expect(bindings[id], point).toBeDefined();
          expect(root.worktree, point).toBeDefined();
        }
      }
      expect(residue(env), `${point} 事务记录残留`).toEqual([]);
    });
  }, 60_000);

  it('读不懂的事务记录原样留着，不删任何文件，也不抛错', async () => {
    const setup = world();
    const env = boot(setup.root);
    const journalDir = path.join(setup.root, 'agent', 'session-import-journal');
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(
      path.join(journalDir, `${randomUUID()}.json`),
      JSON.stringify({ v: 1, kind: 'copy', files: ['../../settings.json', 'notes.txt'] })
    );
    const before = tree(setup.root);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recoverProjectImports(env.ports)).resolves.toBeUndefined();
    warn.mockRestore();
    expect(tree(setup.root)).toEqual(before);
  });
});
