import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { type AppliedFileChange, PROJECTED_FILE_TEXT_LIMIT } from '@shared/types/fileChanges';
import { APPLY_PATCH_NO_EDITS_HINT } from './guidance';
import { createLocalApplyPatchIo, normalizePatchPath } from './localIo';
import { parseApplyPatch, requireApplyPatchInput } from './parser';
import { applyUpdateChunks, decodePatchText, type MatchBudget } from './text';
import type {
  ApplyPatchDetails,
  ApplyPatchOperation,
  ApplyPatchPlan,
  PatchEntry,
  PatchIo,
} from './types';
import { PatchMutationUncertainError } from './types';

export const APPLY_PATCH_LIMITS = {
  patchBytes: 1024 * 1024,
  files: 100,
  chunks: 1000,
  fileBytes: 4 * 1024 * 1024,
  totalReadBytes: 16 * 1024 * 1024,
  comparisons: 1_000_000,
} as const;

interface ReadyPlan extends ApplyPatchPlan {
  io: PatchIo;
  snapshots: Map<string, PatchEntry>;
  actions: ReadyAction[];
  input: string;
}

interface PhysicalAction {
  path: string;
  type: 'add' | 'update' | 'delete';
  before: Buffer;
  after: Buffer;
  exclusive?: boolean;
}

interface ReadyAction extends PhysicalAction {
  change: AppliedFileChange;
}

let executionTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = executionTail.then(task, task);
  executionTail = next.catch(() => {});
  return next;
}

function normalizeOperations(
  operations: ApplyPatchOperation[],
  normalizePath: (value: string) => string
): ApplyPatchOperation[] {
  return mergeRepeatedUpdates(
    operations.map((operation) => {
      const normalizedPath = normalizePath(operation.path);
      if (operation.type !== 'update') return { ...operation, path: normalizedPath };
      return {
        ...operation,
        path: normalizedPath,
        ...(operation.movePath ? { movePath: normalizePath(operation.movePath) } : {}),
      };
    })
  );
}

/** 同一路径拆成多个 Update 段（都不改名）时合并成一段，免得整份补丁因重复路径被拒 */
function mergeRepeatedUpdates(operations: ApplyPatchOperation[]): ApplyPatchOperation[] {
  const merged: ApplyPatchOperation[] = [];
  const updates = new Map<string, Extract<ApplyPatchOperation, { type: 'update' }>>();
  for (const operation of operations) {
    if (operation.type !== 'update' || operation.movePath) {
      merged.push(operation);
      continue;
    }
    const key = pathIdentity(operation.path);
    const previous = updates.get(key);
    if (!previous) {
      const copy = { ...operation, chunks: [...operation.chunks] };
      updates.set(key, copy);
      merged.push(copy);
      continue;
    }
    operation.chunks.forEach((chunk, index) => {
      previous.chunks.push(index === 0 ? { ...chunk, restartSearch: true } : chunk);
    });
  }
  return merged;
}

function operationPaths(operations: readonly ApplyPatchOperation[]): string[] {
  return operations.flatMap((operation) =>
    operation.type === 'update' && operation.movePath
      ? [operation.path, operation.movePath]
      : [operation.path]
  );
}

function pathIdentity(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  return (normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized).normalize('NFC');
}

function assertPathConflicts(
  identities: readonly string[],
  displayPaths: readonly string[],
  canonical = false
): void {
  const exact = identities.map(pathIdentity);
  const duplicateIndex = exact.findIndex((value, index) => exact.indexOf(value) !== index);
  if (duplicateIndex >= 0) {
    const first = exact.indexOf(exact[duplicateIndex]);
    throw new Error(
      canonical
        ? `Patch paths resolve to the same target: ${displayPaths[first]}, ${displayPaths[duplicateIndex]}`
        : `Patch path is operated on more than once: ${displayPaths[duplicateIndex]}`
    );
  }
  const folded = exact.map((value) => value.toLowerCase());
  const aliasIndex = folded.findIndex((value, index) => folded.indexOf(value) !== index);
  if (aliasIndex >= 0)
    throw new Error(`Patch paths have a case alias: ${displayPaths[aliasIndex]}`);
  for (let left = 0; left < folded.length; left += 1) {
    const prefix = folded[left].endsWith('/') ? folded[left] : `${folded[left]}/`;
    const child = folded.findIndex((value, index) => index !== left && value.startsWith(prefix));
    if (child >= 0)
      throw new Error(`Patch paths have an ancestor conflict: ${displayPaths[child]}`);
  }
}

function sameEntry(left: PatchEntry, right: PatchEntry): boolean {
  return (
    left.kind === right.kind &&
    left.canonicalPath === right.canonicalPath &&
    (left.kind !== 'file' ||
      (left.raw !== undefined && right.raw !== undefined && left.raw.equals(right.raw)))
  );
}

async function buildPlan(
  cwd: string,
  params: unknown,
  suppliedIo?: PatchIo,
  signal?: AbortSignal
): Promise<ReadyPlan> {
  const input = requireApplyPatchInput(params);
  if (Buffer.byteLength(input, 'utf8') > APPLY_PATCH_LIMITS.patchBytes) {
    throw new Error('apply_patch input exceeds size limit');
  }
  const io = suppliedIo ?? createLocalApplyPatchIo(cwd);
  const operations = normalizeOperations(
    parseApplyPatch(input),
    io.normalizePath ?? normalizePatchPath
  );
  if (operations.length === 0) throw new Error('No files were modified.');
  const chunks = operations.reduce(
    (count, operation) => count + (operation.type === 'update' ? operation.chunks.length : 0),
    0
  );
  if (chunks > APPLY_PATCH_LIMITS.chunks) throw new Error('apply_patch has too many chunks');
  const paths = operationPaths(operations);
  if (paths.length > APPLY_PATCH_LIMITS.files) throw new Error('apply_patch has too many files');
  assertPathConflicts(paths, paths);

  const snapshots = new Map<string, PatchEntry>();
  const canonicalPaths: string[] = [];
  let totalReadBytes = 0;
  for (const target of paths) {
    const remainingReadBytes = APPLY_PATCH_LIMITS.totalReadBytes - totalReadBytes;
    const entry = await io.inspect(
      target,
      Math.min(APPLY_PATCH_LIMITS.fileBytes, remainingReadBytes),
      signal
    );
    if (entry.kind === 'symlink') throw new Error(`Symbolic links cannot be patched: ${target}`);
    if (entry.kind === 'directory') throw new Error(`Directories cannot be patched: ${target}`);
    if (entry.kind === 'other') throw new Error(`Patch target is not a regular file: ${target}`);
    canonicalPaths.push(entry.canonicalPath);
    if (entry.raw) {
      totalReadBytes += entry.raw.length;
      if (totalReadBytes > APPLY_PATCH_LIMITS.totalReadBytes) {
        throw new Error('apply_patch total read limit exceeded');
      }
      decodePatchText(entry.raw, target);
    }
    snapshots.set(target, entry);
  }
  assertPathConflicts(canonicalPaths, paths, true);

  const actions: PhysicalAction[] = [];
  const matchBudget: MatchBudget = { remaining: APPLY_PATCH_LIMITS.comparisons };
  for (const operation of operations) {
    const source = snapshots.get(operation.path);
    if (!source) throw new Error(`Missing preflight snapshot: ${operation.path}`);
    if (operation.type === 'add') {
      if (source.kind !== 'missing')
        throw new Error(`Add target already exists: ${operation.path}`);
      actions.push({
        path: operation.path,
        type: 'add',
        before: Buffer.alloc(0),
        after: Buffer.from(operation.content, 'utf8'),
        exclusive: true,
      });
      continue;
    }
    if (source.kind !== 'file' || !source.raw) {
      throw new Error(`${operation.type} source does not exist: ${operation.path}`);
    }
    if (operation.type === 'delete') {
      actions.push({
        path: operation.path,
        type: 'delete',
        before: source.raw,
        after: Buffer.alloc(0),
      });
      continue;
    }
    const updated = applyUpdateChunks(source.raw, operation.path, operation.chunks, matchBudget);
    if (!operation.movePath) {
      if (updated.equals(source.raw)) throw new Error(`Update has no effect: ${operation.path}`);
      actions.push({
        path: operation.path,
        type: 'update',
        before: source.raw,
        after: updated,
      });
      continue;
    }
    const destination = snapshots.get(operation.movePath);
    if (destination?.kind !== 'missing') {
      throw new Error(`Move destination already exists: ${operation.movePath}`);
    }
    actions.push({
      path: operation.movePath,
      type: 'add',
      before: Buffer.alloc(0),
      after: updated,
      exclusive: true,
    });
    actions.push({
      path: operation.path,
      type: 'delete',
      before: source.raw,
      after: Buffer.alloc(0),
    });
  }
  const oversized = actions.find((action) => action.after.length > APPLY_PATCH_LIMITS.fileBytes);
  if (oversized) throw new Error(`Generated file exceeds apply_patch limit: ${oversized.path}`);
  const readyActions: ReadyAction[] = actions.map((action) => ({
    ...action,
    change: {
      path: action.path,
      oldText: decodePatchText(action.before, action.path),
      newText: decodePatchText(action.after, action.path),
      type: action.type,
    },
  }));
  return { operations, paths, io, snapshots, actions: readyActions, input };
}

export async function validateApplyPatchTargets(
  cwd: string,
  params: unknown,
  io?: PatchIo,
  signal?: AbortSignal
): Promise<ApplyPatchPlan> {
  const plan = await buildPlan(cwd, params, io, signal);
  return { operations: plan.operations, paths: plan.paths };
}

async function recheck(plan: ReadyPlan, path: string, signal?: AbortSignal): Promise<void> {
  const expected = plan.snapshots.get(path);
  if (!expected) throw new Error(`Missing expected snapshot for ${path}`);
  const actual = await plan.io.inspect(path, APPLY_PATCH_LIMITS.fileBytes, signal);
  if (!sameEntry(expected, actual))
    throw new Error(`File changed after apply_patch preflight: ${path}`);
}

function toChange(action: ReadyAction): AppliedFileChange {
  return action.change;
}

async function readOutcome(
  plan: ReadyPlan,
  action: PhysicalAction
): Promise<'completed' | 'unchanged' | 'uncertain'> {
  try {
    const actual = await plan.io.inspect(
      action.path,
      APPLY_PATCH_LIMITS.fileBytes,
      undefined,
      5_000
    );
    if (action.type === 'delete')
      return actual.kind === 'missing'
        ? 'completed'
        : sameEntry(plan.snapshots.get(action.path)!, actual)
          ? 'unchanged'
          : 'uncertain';
    if (actual.kind === 'file' && actual.raw?.equals(action.after)) return 'completed';
    return sameEntry(plan.snapshots.get(action.path)!, actual) ? 'unchanged' : 'uncertain';
  } catch {
    return 'uncertain';
  }
}

function result(
  fileChanges: AppliedFileChange[],
  error?: string,
  failed: string[] = [],
  unattempted: string[] = [],
  uncertain: string[] = [],
  input?: string
): { content: Array<{ type: 'text'; text: string }>; details: ApplyPatchDetails } {
  const applied = fileChanges.map((change) => change.path);
  const status = error ? (applied.length > 0 ? 'partial' : 'failed') : 'success';
  const details: ApplyPatchDetails = {
    kind: 'apply_patch',
    status,
    // details 随会话落盘且常驻 worker 内存，全文会让会话涨到数十 MB；只留投影用得到的部分
    fileChanges: fileChanges.map((change) => ({
      ...change,
      oldText: capDetailText(change.oldText),
      newText: capDetailText(change.newText),
    })),
    applied,
    failed,
    ...(error ? { error } : {}),
    ...(error && input ? { input } : {}),
    unattempted,
    uncertain,
  };
  const lines =
    status === 'success'
      ? ['Applied patch successfully:', ...applied.map((path) => `- ${path}`)]
      : [
          `Patch ${status}.`,
          `Applied: ${applied.length ? applied.join(', ') : '(none)'}`,
          `Failed paths: ${failed.length ? failed.join(', ') : '(none)'}`,
          `Error: ${error}`,
          `Unattempted: ${unattempted.length ? unattempted.join(', ') : '(none)'}`,
          `Uncertain: ${uncertain.length ? uncertain.join(', ') : '(none)'}`,
          'Re-read failed or uncertain paths before retrying.',
          ...(error?.includes("has no '-'/'+' edits") ? [APPLY_PATCH_NO_EDITS_HINT] : []),
          ...(input ? ['Input:', input] : []),
        ];
  return { content: [{ type: 'text', text: lines.join('\n') }], details };
}

/** 与 projection 的 capText 同规则：投影结果与截断前一致，且仍标 truncated */
function capDetailText(text: string): string {
  return text.length <= PROJECTED_FILE_TEXT_LIMIT
    ? text
    : `${text.slice(0, PROJECTED_FILE_TEXT_LIMIT)}\n…`;
}

async function runPlan(plan: ReadyPlan, signal?: AbortSignal) {
  const fail = (
    fileChanges: AppliedFileChange[],
    error: string,
    failed: string[] = [],
    unattempted: string[] = [],
    uncertain: string[] = []
  ) => result(fileChanges, error, failed, unattempted, uncertain, plan.input);
  for (const target of plan.paths) await recheck(plan, target, signal);
  const changes: AppliedFileChange[] = [];
  for (let index = 0; index < plan.actions.length; index += 1) {
    const action = plan.actions[index];
    if (signal?.aborted) {
      return fail(
        changes,
        'apply_patch cancelled',
        [],
        plan.actions.slice(index).map((entry) => entry.path)
      );
    }
    try {
      await recheck(plan, action.path, signal);
    } catch (error) {
      if (signal?.aborted) {
        return fail(
          changes,
          'apply_patch cancelled',
          [],
          plan.actions.slice(index).map((entry) => entry.path)
        );
      }
      return fail(
        changes,
        error instanceof Error ? error.message : String(error),
        [action.path],
        plan.actions.slice(index + 1).map((entry) => entry.path)
      );
    }
    if (signal?.aborted) {
      return fail(
        changes,
        'apply_patch cancelled',
        [],
        plan.actions.slice(index).map((entry) => entry.path)
      );
    }
    try {
      if (action.type === 'delete') await plan.io.remove(action.path, signal);
      else
        await plan.io.write(action.path, action.after, {
          exclusive: action.exclusive === true,
          signal,
        });
      changes.push(toChange(action));
    } catch (error) {
      if (error instanceof PatchMutationUncertainError) {
        return fail(
          changes,
          error.message,
          [],
          plan.actions.slice(index + 1).map((entry) => entry.path),
          [action.path]
        );
      }
      const outcome = await readOutcome(plan, action);
      if (outcome === 'completed') changes.push(toChange(action));
      const uncertain = outcome === 'uncertain' ? [action.path] : [];
      return fail(
        changes,
        error instanceof Error ? error.message : String(error),
        outcome === 'unchanged' ? [action.path] : [],
        plan.actions.slice(index + 1).map((entry) => entry.path),
        uncertain
      );
    }
  }
  return result(changes);
}

function peekApplyPatchInput(params: unknown): string | undefined {
  try {
    return requireApplyPatchInput(params);
  } catch {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
    const input = (params as Record<string, unknown>).input;
    return typeof input === 'string' && input.length > 0 ? input : undefined;
  }
}

/** 与 pi edit/write 共用同文件队列；解析失败不取锁，交给 buildPlan 报错 */
async function mutationTargets(cwd: string, params: unknown, io?: PatchIo): Promise<string[]> {
  let operations: ApplyPatchOperation[];
  try {
    operations = normalizeOperations(
      parseApplyPatch(requireApplyPatchInput(params)),
      io?.normalizePath ?? normalizePatchPath
    );
  } catch {
    return [];
  }
  const keys = await Promise.all(
    operationPaths(operations).map((value) => mutationQueueKey(path.resolve(cwd, value)))
  );
  return [...new Set(keys)].sort();
}

/**
 * 按 pi 文件锁的键去重(realpath,取不到时用 resolve 结果,与 pi 一致):只按 resolve 字符串去重时,
 * 同一文件的两种写法(大小写、符号链接)会各取一次锁而同键嵌套自锁,外层全局队列随之让此后所有 apply_patch 挂起
 */
async function mutationQueueKey(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return target;
  }
}

function withMutationQueues<T>(targets: readonly string[], task: () => Promise<T>): Promise<T> {
  return targets.reduceRight<() => Promise<T>>(
    (next, target) => () => withFileMutationQueue(target, next),
    task
  )();
}

export function executeApplyPatch(
  cwd: string,
  params: unknown,
  options: { io?: PatchIo; signal?: AbortSignal } = {}
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: ApplyPatchDetails }> {
  return enqueue(async () => {
    try {
      return await withMutationQueues(await mutationTargets(cwd, params, options.io), async () =>
        runPlan(await buildPlan(cwd, params, options.io, options.signal), options.signal)
      );
    } catch (error) {
      return result(
        [],
        error instanceof Error ? error.message : String(error),
        [],
        [],
        [],
        peekApplyPatchInput(params)
      );
    }
  });
}
