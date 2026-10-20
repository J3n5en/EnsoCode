import { statSync } from 'node:fs';
import type { GitDiffResult } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import type {
  GitCommitDiffRequest,
  GitCommitRequest,
  GitCreateCommitRequest,
  GitDiscardRequest,
  GitFileDiffRequest,
  GitHistoryRequest,
  GitPathsRequest,
  GitRequest,
} from '@shared/types/git';
import { ipcMain } from 'electron';
import { diffHead, localGitDiffHost } from '../services/gitDiff';
import {
  GitOperationError,
  GitPreviewUnavailable,
  GitRepository,
} from '../services/gitVersionControl';
import { pickSessionCwd } from '../services/terminalService';
import { isMainWebContents } from '../windows/MainWindow';
import { getSourceAuthorityRegistry } from './agent';
import { sessionWorktree, withSessionGitWorkspace } from './worktree';

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isObject(value: unknown): value is object {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function toGitRequest(value: unknown): GitRequest | null {
  return isObject(value) &&
    'conversationId' in value &&
    'projectId' in value &&
    isNonEmptyString(value.conversationId) &&
    isNonEmptyString(value.projectId)
    ? { conversationId: value.conversationId, projectId: value.projectId }
    : null;
}

export function toGitPathsRequest(value: unknown): GitPathsRequest | null {
  const base = toGitRequest(value);
  if (!base || !isObject(value)) return null;
  if (!('paths' in value) || value.paths === undefined) return base;
  if (
    !Array.isArray(value.paths) ||
    value.paths.length > 10_000 ||
    !value.paths.every((path: unknown): path is string => typeof path === 'string')
  )
    return null;
  return { ...base, paths: value.paths };
}

export function toGitDiscardRequest(value: unknown): GitDiscardRequest | null {
  const base = toGitPathsRequest(value);
  if (!base?.paths || !isObject(value)) return null;
  if (
    'confirmUntracked' in value &&
    value.confirmUntracked !== undefined &&
    typeof value.confirmUntracked !== 'boolean'
  )
    return null;
  return {
    ...base,
    paths: base.paths,
    confirmUntracked: 'confirmUntracked' in value && value.confirmUntracked === true,
  };
}

function toFileDiffRequest(value: unknown): GitFileDiffRequest | null {
  const base = toGitRequest(value);
  return base &&
    isObject(value) &&
    'path' in value &&
    typeof value.path === 'string' &&
    'staged' in value &&
    typeof value.staged === 'boolean'
    ? { ...base, path: value.path, staged: value.staged }
    : null;
}

function toHistoryRequest(value: unknown): GitHistoryRequest | null {
  const base = toGitRequest(value);
  if (!base || !isObject(value)) return null;
  const skip = 'skip' in value ? value.skip : undefined;
  const limit = 'limit' in value ? value.limit : undefined;
  const head = 'head' in value ? value.head : undefined;
  if (skip !== undefined && (typeof skip !== 'number' || !Number.isSafeInteger(skip) || skip < 0))
    return null;
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
  )
    return null;
  if (head !== undefined && typeof head !== 'string') return null;
  return { ...base, skip, limit, head };
}

function toCommitRequest(value: unknown): GitCommitRequest | null {
  const base = toGitRequest(value);
  return base && isObject(value) && 'hash' in value && typeof value.hash === 'string'
    ? { ...base, hash: value.hash }
    : null;
}

function toCommitDiffRequest(value: unknown): GitCommitDiffRequest | null {
  const base = toCommitRequest(value);
  return base && isObject(value) && 'path' in value && typeof value.path === 'string'
    ? { ...base, path: value.path }
    : null;
}

function toCreateCommitRequest(value: unknown): GitCreateCommitRequest | null {
  const base = toGitRequest(value);
  return base && isObject(value) && 'message' in value && typeof value.message === 'string'
    ? { ...base, message: value.message }
    : null;
}

function register<T extends GitRequest, R>(
  channel: string,
  parse: (value: unknown) => T | null,
  mutate: boolean,
  action: (repository: GitRepository, request: T) => Promise<R>
): void {
  ipcMain.handle(channel, async (event, value: unknown) => {
    if (!isMainWebContents(event.sender.id)) {
      return { ok: false, code: 'unavailable', error: '无权访问 Git 工作区。' };
    }
    const request = parse(value);
    if (!request) return { ok: false, code: 'invalid-request', error: '无效的 Git 请求。' };
    try {
      return await withSessionGitWorkspace(request, mutate, async (cwd, assertCurrent) => {
        const repository = await GitRepository.open(cwd, assertCurrent);
        const result = await action(repository, request);
        assertCurrent();
        return result;
      });
    } catch (error) {
      return {
        ok: false,
        code: error instanceof GitOperationError ? error.code : 'git-error',
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof GitPreviewUnavailable ? { unavailable: true } : {}),
      };
    }
  });
}

const completed = async (operation: Promise<void>): Promise<{ ok: true }> => {
  await operation;
  return { ok: true };
};

export function registerGitHandlers(): void {
  register(IPC_CHANNELS.GIT_STATUS, toGitRequest, false, (git) => git.status());
  register(IPC_CHANNELS.GIT_FILE_DIFF, toFileDiffRequest, false, (git, request) =>
    git.fileDiff(request.path, request.staged)
  );
  register(IPC_CHANNELS.GIT_HISTORY, toHistoryRequest, false, (git, request) =>
    git.history(request.skip, request.limit, request.head)
  );
  register(IPC_CHANNELS.GIT_COMMIT_FILES, toCommitRequest, false, (git, request) =>
    git.commitFiles(request.hash)
  );
  register(IPC_CHANNELS.GIT_COMMIT_DIFF, toCommitDiffRequest, false, (git, request) =>
    git.commitDiff(request.hash, request.path)
  );
  register(IPC_CHANNELS.GIT_STAGE, toGitPathsRequest, true, (git, request) =>
    completed(git.stage(request.paths))
  );
  register(IPC_CHANNELS.GIT_UNSTAGE, toGitPathsRequest, true, (git, request) =>
    completed(git.unstage(request.paths))
  );
  register(IPC_CHANNELS.GIT_DISCARD, toGitDiscardRequest, true, (git, request) =>
    completed(git.discard(request.paths, request.confirmUntracked === true))
  );
  register(IPC_CHANNELS.GIT_COMMIT, toCreateCommitRequest, true, (git, request) =>
    completed(git.commit(request.message))
  );
  register(IPC_CHANNELS.GIT_FETCH, toGitRequest, true, (git) => completed(git.fetch()));
  register(IPC_CHANNELS.GIT_PULL, toGitRequest, true, (git) => completed(git.pull()));
  register(IPC_CHANNELS.GIT_PUSH, toGitRequest, true, (git) => completed(git.push()));
  ipcMain.handle(
    IPC_CHANNELS.GIT_DIFF_HEAD,
    async (_event, request: unknown): Promise<GitDiffResult> => {
      if (!request || typeof request !== 'object') return { ok: false, error: 'unavailable' };
      const conversationId = 'conversationId' in request ? request.conversationId : undefined;
      const projectId = 'projectId' in request ? request.projectId : undefined;
      if (!isNonEmptyString(conversationId) || !isNonEmptyString(projectId)) {
        return { ok: false, error: 'unavailable' };
      }

      const project = getSourceAuthorityRegistry()?.project(projectId);
      if (project?.kind === 'ssh') return { ok: false, error: 'unavailable' };

      const worktreePath = sessionWorktree(conversationId)?.path;
      const projectPath = project?.state === 'active' ? project.canonicalPath : undefined;
      const cwd = pickSessionCwd({
        worktreePath,
        projectPath,
        home: '',
        exists: isDirectory,
      });
      if (!cwd) return { ok: false, error: 'unavailable' };
      return diffHead(cwd, localGitDiffHost());
    }
  );
}
