export interface GitRequest {
  conversationId: string;
  projectId: string;
}

export interface GitPathsRequest extends GitRequest {
  /** 省略表示全部；空数组不会操作任何文件。 */
  paths?: string[];
}

export interface GitDiscardRequest extends GitRequest {
  paths: string[];
  confirmUntracked?: boolean;
}

export interface GitFileDiffRequest extends GitRequest {
  path: string;
  staged: boolean;
}

export interface GitHistoryRequest extends GitRequest {
  skip?: number;
  limit?: number;
  head?: string;
}

export interface GitCommitRequest extends GitRequest {
  hash: string;
}

export interface GitCommitDiffRequest extends GitCommitRequest {
  path: string;
}

export interface GitCreateCommitRequest extends GitRequest {
  message: string;
}

export interface GitFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'untracked' | 'conflicted';
}

export type GitErrorCode =
  | 'invalid-request'
  | 'unavailable'
  | 'workspace-busy'
  | 'workspace-running'
  | 'workspace-blocked'
  | 'invalid-path'
  | 'stale-file'
  | 'confirmation-required'
  | 'empty-index'
  | 'invalid-message'
  | 'git-busy'
  | 'conflict'
  | 'no-upstream'
  | 'no-remote'
  | 'dirty'
  | 'binary'
  | 'too-large'
  | 'unsupported'
  | 'invalid-encoding'
  | 'git-error';

export type GitFailure = { ok: false; code?: GitErrorCode; error: string; unavailable?: true };
export type GitOperationResult = { ok: true } | GitFailure;

export type GitStatusResult =
  | {
      ok: true;
      branch: string | null;
      head: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      staged: GitFile[];
      unstaged: GitFile[];
    }
  | GitFailure;

export type GitFileDiffResult =
  | { ok: true; path: string; oldText: string; newText: string }
  | GitFailure;

export interface GitHistoryEntry {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export type GitHistoryResult =
  | { ok: true; commits: GitHistoryEntry[]; hasMore: boolean }
  | GitFailure;

export type GitCommitFilesResult = { ok: true; files: GitFile[] } | GitFailure;
