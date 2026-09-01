export interface FilesDirEntry {
  name: string;
  kind: 'file' | 'dir';
}

export type FilesListResult = { ok: true; entries: FilesDirEntry[] } | { ok: false; error: string };

export type FilesReadRelResult = { ok: true; content: string } | { ok: false; error: string };

export type FilesWriteResult = { ok: true } | { ok: false; error: string };

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
