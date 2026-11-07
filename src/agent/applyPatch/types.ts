import type { AppliedFileChange } from '@shared/types/fileChanges';

export class PatchMutationUncertainError extends Error {
  override readonly name = 'PatchMutationUncertainError';
}

export interface PatchEntry {
  kind: 'missing' | 'file' | 'directory' | 'symlink' | 'other';
  canonicalPath: string;
  raw?: Buffer;
}

export interface PatchIo {
  normalizePath?(path: string): string;
  inspect(
    path: string,
    maxBytes?: number,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<PatchEntry>;
  write(
    path: string,
    raw: Buffer,
    options: { exclusive: boolean; signal?: AbortSignal; timeoutMs?: number }
  ): Promise<void>;
  remove(path: string, signal?: AbortSignal, timeoutMs?: number): Promise<void>;
}

export interface ApplyPatchChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  contextLineIndices: Array<[number, number]>;
  endOfFile: boolean;
  /** 合并进来的同文件后续 Update 段：从文件开头重新查找 */
  restartSearch?: boolean;
}

export type ApplyPatchOperation =
  | { type: 'add'; path: string; content: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; movePath?: string; chunks: ApplyPatchChunk[] };

export interface ApplyPatchDetails {
  kind: 'apply_patch';
  status: 'success' | 'partial' | 'failed';
  fileChanges: AppliedFileChange[];
  applied: string[];
  failed: string[];
  error?: string;
  input?: string;
  unattempted: string[];
  uncertain: string[];
}

export interface ApplyPatchPlan {
  operations: ApplyPatchOperation[];
  paths: string[];
}
