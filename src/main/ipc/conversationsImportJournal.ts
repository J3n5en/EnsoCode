import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * 整项目导入的事务记录：第一次改动任何东西之前落盘（fsync），提交完成后删掉。
 * 进程中途死掉时记录还在，下次启动据此补完或撤回，只动记录里列出的副本。
 */
export type ImportJournal =
  | {
      v: 1;
      kind: 'copy';
      targetProjectId: string;
      /** 新副本根会话 id，登记权威表时整批一次提交 */
      conversationIds: string[];
      /** 本次生成的全部新 uuid；副本路径一定含其中之一 */
      ids: string[];
      /** 副本落位路径，相对 sessions 目录；登记前它们都不存在 */
      files: string[];
      rows: Record<string, Record<string, unknown>>;
      placeBefore: Record<string, string>;
    }
  | { v: 1; kind: 'move'; targetProjectId: string; conversationIds: string[] };

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '');

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 只认 sessions 目录内、含本次新 id 的相对路径 */
const ownedCopy = (file: string, ids: readonly string[]) =>
  !path.isAbsolute(file) &&
  path.normalize(file) === file &&
  !file.split(/[\\/]/).includes('..') &&
  ids.some((id) => file.includes(id));

export function parseImportJournal(value: unknown): ImportJournal | null {
  if (!record(value) || value.v !== 1 || typeof value.targetProjectId !== 'string') return null;
  if (!strings(value.conversationIds) || value.conversationIds.length === 0) return null;
  const { targetProjectId, conversationIds } = value;
  if (value.kind === 'move') return { v: 1, kind: 'move', targetProjectId, conversationIds };
  if (value.kind !== 'copy') return null;
  const { ids, files, rows, placeBefore } = value;
  if (
    !strings(ids) ||
    !strings(files) ||
    !files.every((file) => ownedCopy(file, ids)) ||
    !record(rows) ||
    !Object.values(rows).every(record) ||
    !record(placeBefore) ||
    !Object.values(placeBefore).every((id) => typeof id === 'string')
  ) {
    return null;
  }
  return {
    v: 1,
    kind: 'copy',
    targetProjectId,
    conversationIds,
    ids,
    files,
    rows: rows as Record<string, Record<string, unknown>>,
    placeBefore: placeBefore as Record<string, string>,
  };
}

export const copyStagingDir = (sessionDir: string) =>
  path.join(path.dirname(sessionDir), 'session-copy-staging');

const journalDir = (sessionDir: string) =>
  path.join(path.dirname(sessionDir), 'session-import-journal');

/** fsync 文件或目录；平台不支持（如 Windows 目录）时跳过 */
async function sync(target: string) {
  try {
    const handle = await open(target, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {}
}

export async function beginImportJournal(
  sessionDir: string,
  id: string,
  journal: ImportJournal
): Promise<string> {
  const dir = journalDir(sessionDir);
  const file = path.join(dir, `${id}.json`);
  await mkdir(dir, { recursive: true });
  const handle = await open(`${file}.tmp`, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(journal));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(`${file}.tmp`, file);
  await sync(dir);
  return file;
}

/** 提交已完成：先让权威表、会话行等落到磁盘，再删记录。删不掉只记日志，下次启动补完是空操作 */
export async function endImportJournal(file: string, durableFiles: readonly string[]) {
  for (const target of durableFiles) {
    await sync(target);
    await sync(path.dirname(target));
  }
  try {
    await rm(file, { force: true });
    await sync(path.dirname(file));
  } catch (error) {
    console.warn('[project-import] 事务记录删除失败', file, error);
  }
}

/** 残留的事务记录；`.tmp` 说明记录本身没写完、还没改动任何东西，直接丢掉 */
export async function pendingImportJournals(
  sessionDir: string
): Promise<{ file: string; journal: ImportJournal | null }[]> {
  const dir = journalDir(sessionDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const pending: { file: string; journal: ImportJournal | null }[] = [];
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    if (name.endsWith('.json.tmp')) await rm(file, { force: true });
    if (!name.endsWith('.json')) continue;
    let journal: ImportJournal | null = null;
    try {
      journal = parseImportJournal(JSON.parse(await readFile(file, 'utf8')));
    } catch {}
    pending.push({ file, journal });
  }
  return pending;
}

let queue: Promise<unknown> = Promise.resolve();

/** 导入与启动恢复串行：恢复看到的记录一定属于已经死掉的那次导入 */
export function serializeImport<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run);
  queue = next.catch(() => {});
  return next;
}
