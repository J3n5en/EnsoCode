import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import {
  type CopiedFrom,
  conversationIdsToMove,
  type ImportProjectSessionsResult,
  type ProjectPairInput,
} from '@shared/moveConversation';
import type {
  AuthorityMutationResult,
  ConversationAuthority,
  ConversationAuthorityProjection,
} from '@shared/types/agent';
import {
  beginImportJournal,
  copyStagingDir,
  endImportJournal,
  type ImportJournal,
  serializeImport,
} from './conversationsImportJournal';

export interface CopyProjectSessionsPorts {
  sessionDir: string;
  /** 提交后、删事务记录前要 fsync 的权威文件（权威表、会话行等） */
  durableFiles: readonly string[];
  conversation: (conversationId: string) => ConversationAuthorityProjection | undefined;
  rootConversationIds: (projectId: string) => string[];
  isRunning: (conversationId: string) => boolean;
  insertConversations: (
    targetProjectId: string,
    records: Pick<
      ConversationAuthority,
      'conversationId' | 'lifecycle' | 'sessionFile' | 'selection' | 'forkedFrom'
    >[]
  ) => AuthorityMutationResult<string[]>;
  discardConversations: (conversationIds: readonly string[]) => void;
  readConversations: () => Record<string, Record<string, unknown>>;
  /** 一次补丁写入新会话行并落盘；placeBefore：新根会话 id → 排在哪条源会话前面 */
  addConversations: (
    rows: Record<string, Record<string, unknown>>,
    placeBefore: Record<string, string>
  ) => boolean;
  randomUuid: () => string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const PI_SESSION_FILE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** 副本不带的东西：worktree 绑定、未读、排队与续跑、秘书派发、后台任务、工作区提醒 */
const NOT_COPIED_ROW_KEYS = [
  'worktree',
  'worktreeMissing',
  'unread',
  'activeRenewedAt',
  'queuedMessages',
  'goal',
  'driver',
  'secretaryOrigin',
  'pendingWorkspaceNote',
  'pendingWorkspaceBranch',
  'backgroundTasks',
  'subagents',
  'draftText',
  'draftImages',
  'draftAppend',
  'copiedFrom',
] as const;

/** 副本里引用到本批会话的 uuid（会话 id、pi 会话 id）一律换成副本的 */
const remap = (text: string, ids: ReadonlyMap<string, string>) =>
  text.replace(UUID, (id) => ids.get(id) ?? id);

type Entry = { from: string; rel: string; rewrite: boolean };

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

/** 会话文件平铺在 sessions 目录；按文件名定位（权威记录可能是 realpath），不跟随别处的路径 */
function inSessionDir(sessionDir: string, file: unknown): string | undefined {
  return typeof file === 'string' && file !== ''
    ? path.join(sessionDir, path.basename(file))
    : undefined;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** 一条根会话在 sessions 目录下的全部附属物：jsonl、子会话 journal、child-runs、超长输出、粘贴文本 */
async function conversationEntries(
  sessionDir: string,
  rootId: string,
  sessionFiles: readonly string[]
): Promise<string[]> {
  const files = new Set(sessionFiles);
  const journalPrefix = `enso-${`${rootId}::cw-`.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  for (const name of await listDir(sessionDir)) {
    if (name.startsWith(journalPrefix)) files.add(path.join(sessionDir, name));
  }
  const catalog = path.join(sessionDir, 'child-runs', `${rootId}.jsonl`);
  if (await exists(catalog)) {
    files.add(catalog);
    for (const line of (await readFile(catalog, 'utf8')).split('\n')) {
      try {
        const file = inSessionDir(sessionDir, JSON.parse(line).file);
        if (file) files.add(file);
      } catch {}
    }
  }
  for (const name of await listDir(path.join(sessionDir, 'tool-output'))) {
    if (name === rootId || name.startsWith(`${rootId}-`) || name.startsWith(`${rootId}::`)) {
      files.add(path.join(sessionDir, 'tool-output', name));
    }
  }
  files.add(path.join(sessionDir, 'pasted-text', rootId));
  const present: string[] = [];
  for (const file of files) if (await exists(file)) present.push(file);
  return present;
}

/** jsonl 逐行改写身份后写到暂存位置；其余文件/目录原样复制 */
async function stage(entry: Entry, staged: string, ids: ReadonlyMap<string, string>) {
  await mkdir(path.dirname(staged), { recursive: true });
  if (!entry.rewrite) {
    await cp(entry.from, staged, { recursive: true, errorOnExist: true, force: false });
    return;
  }
  const input = createReadStream(entry.from, { encoding: 'utf8' });
  const output = createWriteStream(staged, { flags: 'wx', mode: 0o600 });
  const failed = Promise.race([once(input, 'error'), once(output, 'error')]).then(([error]) => {
    throw error;
  });
  const copy = (async () => {
    for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
      if (!output.write(`${remap(line, ids)}\n`)) await once(output, 'drain');
    }
    output.end();
    await finished(output);
  })();
  copy.catch(() => {});
  failed.catch(() => {});
  try {
    await Promise.race([copy, failed]);
  } finally {
    input.destroy();
    output.destroy();
  }
}

/** 限并发执行；任一失败就不再领新活，等在途的都停下后再抛，免得清理时还有人在写 */
async function inPool<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>) {
  let next = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (!failure && next < items.length) {
        const item = items[next];
        next += 1;
        try {
          await run(item);
        } catch (error) {
          failure ??= { error };
        }
      }
    })
  );
  if (failure) throw failure.error;
}

/**
 * 整项目复制：每条根会话及其子会话、分支生成新 id，jsonl 等附属物复制成新文件并改写其中的身份引用。
 * 源文件只读不写。先落盘事务记录，附属物复制到暂存目录，全部成功后落位，再一次登记权威表、一次补丁会话行；
 * 任一步失败都撤掉已落位的文件和已登记的会话；进程中途死掉则由启动恢复按事务记录收尾。多次复制串行执行。
 */
export function copyProjectSessions(
  input: ProjectPairInput,
  ports: CopyProjectSessionsPorts
): Promise<ImportProjectSessionsResult> {
  return serializeImport(() => copyNow(input, ports));
}

/** 启动恢复：已登记的补完会话行；未登记的撤回登记残片并只删记录里列出的副本 */
export async function recoverCopy(
  journal: Extract<ImportJournal, { kind: 'copy' }>,
  ports: CopyProjectSessionsPorts
): Promise<void> {
  const registered = journal.conversationIds.filter((id) => ports.conversation(id));
  if (registered.length === journal.conversationIds.length) {
    const existing = ports.readConversations();
    const rows = Object.fromEntries(Object.entries(journal.rows).filter(([id]) => !existing[id]));
    const placeBefore = Object.fromEntries(
      Object.entries(journal.placeBefore).filter(([id]) => id in rows)
    );
    if (Object.keys(rows).length > 0 && !ports.addConversations(rows, placeBefore)) {
      throw new Error('rows rejected');
    }
  } else {
    if (registered.length > 0) ports.discardConversations(registered);
    for (const file of journal.files) {
      await rm(path.join(ports.sessionDir, file), { recursive: true, force: true });
    }
  }
  await rm(copyStagingDir(ports.sessionDir), { recursive: true, force: true });
}

async function copyNow(
  { sourceProjectId, targetProjectId }: ProjectPairInput,
  ports: CopyProjectSessionsPorts
): Promise<ImportProjectSessionsResult> {
  const { sessionDir } = ports;
  const skipped: { conversationId: string; error: string }[] = [];
  const roots: ConversationAuthorityProjection[] = [];
  for (const id of ports.rootConversationIds(sourceProjectId)) {
    const conversation = ports.conversation(id);
    if (!conversation) continue;
    if (ports.isRunning(id)) skipped.push({ conversationId: id, error: 'running' });
    else roots.push(conversation);
  }
  const done = (imported: string[]): ImportProjectSessionsResult => ({
    ok: true,
    mode: 'copy',
    imported,
    skipped,
    sourceEmpty: false,
  });
  if (roots.length === 0) return done([]);

  const rows = ports.readConversations();
  const ids = new Map<string, string>();
  for (const root of roots) ids.set(root.conversationId, ports.randomUuid());
  const entries: Entry[] = [];
  const trees = new Map<string, string[]>();
  for (const root of roots) {
    const tree = conversationIdsToMove(rows, root.conversationId);
    trees.set(root.conversationId, tree);
    const sessionFiles = [root.sessionFile, ...tree.map((id) => rows[id]?.sessionFile)]
      .map((file) => inSessionDir(sessionDir, file))
      .filter((file): file is string => file !== undefined);
    for (const from of await conversationEntries(sessionDir, root.conversationId, sessionFiles)) {
      const piId = PI_SESSION_FILE.exec(path.basename(from))?.[1];
      if (piId && !ids.has(piId)) ids.set(piId, ports.randomUuid());
      entries.push({
        from,
        rel: path.relative(sessionDir, from),
        rewrite: from.endsWith('.jsonl'),
      });
    }
  }
  for (const entry of entries) {
    entry.rel = remap(entry.rel, ids);
    if (path.join(sessionDir, entry.rel) === entry.from) return { ok: false, error: 'copy-failed' };
    // 落位路径事先都不存在，事务记录里列出的才一定是本次自己产生的副本
    if (await exists(path.join(sessionDir, entry.rel))) return { ok: false, error: 'copy-failed' };
  }
  const copiedFile = (file: unknown) => {
    const from = inSessionDir(sessionDir, file);
    return from && entries.some((entry) => entry.from === from)
      ? path.join(sessionDir, remap(path.basename(from), ids))
      : undefined;
  };

  const records = roots.map((root) => {
    const conversationId = ids.get(root.conversationId) ?? '';
    const sessionFile = copiedFile(root.sessionFile);
    const forkedTo = root.forkedFrom && ids.get(root.forkedFrom.conversationId);
    return {
      conversationId,
      lifecycle:
        root.lifecycle === 'ready' && sessionFile ? ('ready' as const) : ('draft' as const),
      ...(sessionFile ? { sessionFile } : {}),
      ...(root.selection ? { selection: root.selection } : {}),
      ...(root.forkedFrom && forkedTo
        ? { forkedFrom: { ...root.forkedFrom, conversationId: forkedTo } }
        : {}),
    };
  });
  const copies: Record<string, Record<string, unknown>> = {};
  const placeBefore: Record<string, string> = {};
  for (const root of roots) {
    placeBefore[ids.get(root.conversationId) ?? ''] = root.conversationId;
    for (const id of trees.get(root.conversationId) ?? []) {
      const source = rows[id];
      const copyId = remap(id, ids);
      if (!source || copyId === id) continue;
      const row: Record<string, unknown> = JSON.parse(remap(JSON.stringify(source), ids));
      for (const key of NOT_COPIED_ROW_KEYS) delete row[key];
      row.id = copyId;
      row.projectId = targetProjectId;
      const sessionFile = copiedFile(source.sessionFile);
      if (sessionFile) row.sessionFile = sessionFile;
      else delete row.sessionFile;
      const forkedFrom = source.forkedFromConversationId;
      if (typeof forkedFrom === 'string' && !ids.has(forkedFrom)) {
        delete row.forkedFromConversationId;
        delete row.forkedFromEntryId;
      }
      if (id === root.conversationId) {
        row.copiedFrom = { projectId: sourceProjectId, conversationId: id } satisfies CopiedFrom;
      }
      copies[copyId] = row;
    }
  }
  const conversationIds = records.map((record) => record.conversationId);

  const staging = copyStagingDir(sessionDir);
  let journal: string;
  try {
    journal = await beginImportJournal(sessionDir, ports.randomUuid(), {
      v: 1,
      kind: 'copy',
      targetProjectId,
      conversationIds,
      ids: [...ids.values()],
      files: entries.map((entry) => entry.rel),
      rows: copies,
      placeBefore,
    });
  } catch {
    return { ok: false, error: 'copy-failed' };
  }
  const placed: string[] = [];
  let registered: string[] = [];
  try {
    await rm(staging, { recursive: true, force: true });
    await inPool(entries, 4, (entry) => stage(entry, path.join(staging, entry.rel), ids));
    for (const entry of entries) {
      const final = path.join(sessionDir, entry.rel);
      await mkdir(path.dirname(final), { recursive: true });
      await rename(path.join(staging, entry.rel), final);
      placed.push(final);
    }
    const inserted = ports.insertConversations(targetProjectId, records);
    if (!inserted.accepted) throw new Error(inserted.error);
    registered = inserted.value;
    if (!ports.addConversations(copies, placeBefore)) throw new Error('rows rejected');
  } catch {
    try {
      if (registered.length > 0) ports.discardConversations(registered);
      await Promise.all(placed.map((file) => rm(file, { recursive: true, force: true })));
      await endImportJournal(journal, ports.durableFiles);
    } catch {}
    return { ok: false, error: 'copy-failed' };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await endImportJournal(journal, ports.durableFiles);
  return done(conversationIds);
}
