export interface FilesDirEntry {
  name: string;
  kind: 'file' | 'dir';
}

export type FilesListResult = { ok: true; entries: FilesDirEntry[] } | { ok: false; error: string };

export type FilesReadRelResult = { ok: true; content: string } | { ok: false; error: string };

export type FilesReadImageResult = { ok: true; dataUrl: string } | { ok: false; error: string };

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
