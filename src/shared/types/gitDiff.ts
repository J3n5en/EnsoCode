export type GitDiffStatus = 'modified' | 'added' | 'deleted' | 'untracked';

export interface GitDiffFile {
  path: string;
  status: GitDiffStatus;
  oldText: string;
  newText: string;
}

export type GitDiffResult =
  | { ok: true; files: GitDiffFile[] }
  | { ok: false; error: 'not-repo' | 'unavailable' };
