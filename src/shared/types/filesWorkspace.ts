export interface FilesDirEntry {
  name: string;
  kind: 'file' | 'dir';
}

export type FilesListResult = { ok: true; entries: FilesDirEntry[] } | { ok: false; error: string };

export type FilesReadRelResult = { ok: true; content: string } | { ok: false; error: string };

export type FilesReadImageResult = { ok: true; dataUrl: string } | { ok: false; error: string };

export interface FilesOpenRequest {
  conversationId: string;
  projectId: string;
  rel: string;
}

export interface FilesOpenContextRequest extends FilesOpenRequest {
  itemId: string;
}

export type FilesOpenResult =
  | { ok: true; target: 'internal'; viewer: 'text' | 'markdown' | 'image'; rel: string }
  | { ok: true; target: 'handled' }
  | { ok: false; error: string };

export type FilesFetchRemoteImageResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string };

export type FilesWriteResult = { ok: true } | { ok: false; error: string };

export type FilesMutateResult = { ok: true; rel?: string } | { ok: false; error: string };

export type FilesAbsResult =
  | { ok: true; abs: string; fileUrl: string; local: true }
  | { ok: true; abs: string; fileUrl?: undefined; local: false }
  | { ok: false; error: string };

export type FilesWatchResult = { ok: true } | { ok: false; error: string };

export interface FilesWatchEvent {
  conversationId: string;
  rel: string;
  type: 'change' | 'rename';
}

export interface FilesWorkspaceRequest {
  conversationId: string;
  projectId: string;
  rel?: string;
}

export type FilesSearchMode = 'names' | 'content';

export interface FilesSearchRequest {
  conversationId: string;
  projectId: string;
  query: string;
  mode: FilesSearchMode;
  maxResults?: number;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface FilesSearchNameHit {
  relativePath: string;
  name: string;
}

export interface FilesSearchContentHit {
  relativePath: string;
  line: number;
  column: number;
  matchLength: number;
  content: string;
}

export type FilesSearchResult =
  | { ok: true; mode: 'names'; hits: FilesSearchNameHit[] }
  | { ok: true; mode: 'content'; hits: FilesSearchContentHit[]; truncated: boolean }
  | { ok: false; error: string };
