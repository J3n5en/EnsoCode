import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isUuid } from '@shared/builtinAgents';

export type ChildRunRecord = {
  v: 1;
  childId: string;
  name: string;
  /** 用户看见的任务标题；缺省时界面退回实例名 */
  title?: string;
  agentType?: string;
  /** basename，相对 sessions 目录 */
  file: string;
  startedAt: number;
};

export type ChildRunFileFormat = 'pi' | 'safe-journal';

function isSafeBasename(file: string): boolean {
  return (
    file.length > 0 &&
    file === path.basename(file) &&
    !file.includes('/') &&
    !file.includes('\\') &&
    !file.includes('..') &&
    file !== '.' &&
    file !== '..'
  );
}

export function normalizeChildRunTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const title = value.trim().replace(/\s+/g, ' ').slice(0, 80);
  return title || undefined;
}

function readTitle(value: unknown): string | undefined {
  return typeof value === 'string' ? normalizeChildRunTitle(value) : undefined;
}

function catalogPath(sessionDir: string, parentId: string): string {
  return path.join(sessionDir, 'child-runs', `${parentId}.jsonl`);
}

function parseLine(line: string): ChildRunRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.v !== 1 || typeof row.childId !== 'string' || !row.childId) return null;
  if (typeof row.name !== 'string' || !row.name) return null;
  if (typeof row.file !== 'string' || !isSafeBasename(row.file)) return null;
  if (typeof row.startedAt !== 'number' || !Number.isFinite(row.startedAt)) return null;
  if (row.agentType !== undefined && (typeof row.agentType !== 'string' || !row.agentType)) {
    return null;
  }
  const title = readTitle(row.title);
  return {
    v: 1,
    childId: row.childId,
    name: row.name,
    ...(title ? { title } : {}),
    ...(typeof row.agentType === 'string' ? { agentType: row.agentType } : {}),
    file: row.file,
    startedAt: row.startedAt,
  };
}

function readFolded(sessionDir: string, parentId: string): ChildRunRecord[] {
  if (!isUuid(parentId)) return [];
  let text: string;
  try {
    text = readFileSync(catalogPath(sessionDir, parentId), 'utf8');
  } catch {
    return [];
  }
  const folded = new Map<string, ChildRunRecord>();
  for (const line of text.split('\n')) {
    const row = parseLine(line);
    if (!row) continue;
    if (!row.childId.startsWith(`${parentId}::cw-`)) continue;
    const prev = folded.get(row.childId);
    folded.set(
      row.childId,
      prev
        ? {
            ...row,
            startedAt: prev.startedAt,
            ...(row.title ? {} : prev.title ? { title: prev.title } : {}),
          }
        : row
    );
  }
  return [...folded.values()];
}

export function recordChildRun(
  sessionDir: string,
  parentId: string,
  record: ChildRunRecord
): boolean {
  if (!isUuid(parentId)) return false;
  if (!record.childId.startsWith(`${parentId}::cw-`)) return false;
  if (record.v !== 1 || !record.name || !isSafeBasename(record.file)) return false;
  if (!Number.isFinite(record.startedAt)) return false;
  if (record.agentType !== undefined && !record.agentType) return false;
  const title = normalizeChildRunTitle(record.title);
  const prev = readFolded(sessionDir, parentId).find((item) => item.childId === record.childId);
  if (prev && prev.file === record.file) return true;
  const dir = path.join(sessionDir, 'child-runs');
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    v: 1 as const,
    childId: record.childId,
    name: record.name,
    ...(title ? { title } : {}),
    ...(record.agentType ? { agentType: record.agentType } : {}),
    file: record.file,
    startedAt: record.startedAt,
  });
  appendFileSync(path.join(dir, `${parentId}.jsonl`), `${line}\n`, 'utf8');
  return true;
}

export function listChildRuns(sessionDir: string, parentId: string): ChildRunRecord[] {
  return readFolded(sessionDir, parentId);
}

export function resolveChildRunFile(
  sessionDir: string,
  parentId: string,
  childId: string
): { path: string; format: ChildRunFileFormat } | null {
  const record = readFolded(sessionDir, parentId).find((item) => item.childId === childId);
  if (!record) return null;
  const root = path.resolve(sessionDir);
  const resolved = path.resolve(root, record.file);
  if (resolved !== path.join(root, record.file) || !resolved.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return {
    path: resolved,
    format: record.file.startsWith('enso-') ? 'safe-journal' : 'pi',
  };
}

export function removeChildRuns(sessionDir: string, parentId: string): void {
  if (!isUuid(parentId)) return;
  const root = path.resolve(sessionDir);
  for (const record of readFolded(sessionDir, parentId)) {
    const located = resolveChildRunFile(sessionDir, parentId, record.childId);
    if (!located?.path.startsWith(`${root}${path.sep}`)) continue;
    try {
      rmSync(located.path, { force: true });
    } catch {}
  }
  try {
    rmSync(catalogPath(sessionDir, parentId), { force: true });
  } catch {}
}
