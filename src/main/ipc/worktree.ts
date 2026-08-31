/**
 * 会话级 worktree 隔离的 IPC 层：参数校验 + 转发到 services/worktree。
 * 产品语义（默认本地、opt-in、拦截规则）见 docs/plans/2026-08-22-enso-code-design.md。
 */

import path from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import type { SessionWorktree, WorktreeStatus } from '@shared/types/worktree';
import { app, ipcMain } from 'electron';
import { WorktreeRegistry } from '../services/worktree/registry';
import {
  createSessionWorktree,
  rebuildSessionWorktree,
  removeSessionWorktree,
  repoIsClean,
  worktreeStatus,
} from '../services/worktree/service';
import { isMainWebContents } from '../windows/MainWindow';
import { getSourceAuthorityRegistry } from './agent';

let registry: WorktreeRegistry | null = null;

function worktreesRoot(): string {
  return path.join(app.getPath('userData'), 'worktrees');
}

function ensureRegistry(): WorktreeRegistry {
  if (!registry) {
    registry = new WorktreeRegistry(path.join(app.getPath('userData'), 'worktrees.json'));
  }
  return registry;
}

/** spawn cwd 授权用：该会话登记过的 worktree 记录（main 权威，不信任 renderer 传路径） */
export function sessionWorktree(conversationId: string): SessionWorktree | undefined {
  return ensureRegistry().get(conversationId);
}

export type WorktreeResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: unknown): { ok: false; error: string } => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
});

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** 解析 conversationId+projectId 到项目根路径（走 source authority，不接受 renderer 路径） */
function resolveRepoPath(projectId: string): string | null {
  const authority = getSourceAuthorityRegistry();
  const project = authority?.project(projectId);
  // ssh 项目的 canonicalPath 是远端路径，本地 git worktree 操作无意义，一律拒绝（UI 已隐藏，此处防御）
  if (project?.kind === 'ssh') return null;
  return project?.state === 'active' ? project.canonicalPath : null;
}

export function registerWorktreeHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_CREATE,
    async (event, request: unknown): Promise<WorktreeResult<SessionWorktree>> => {
      const req = request as { conversationId?: unknown; projectId?: unknown };
      if (
        !isMainWebContents(event.sender.id) ||
        !isNonEmptyString(req?.conversationId) ||
        !isNonEmptyString(req?.projectId)
      ) {
        return { ok: false, error: 'invalid worktree create request' };
      }
      const repoPath = resolveRepoPath(req.projectId);
      if (!repoPath) return { ok: false, error: 'unknown or inactive project' };
      try {
        const record = await createSessionWorktree({
          repoPath,
          conversationId: req.conversationId,
          projectId: req.projectId,
          root: worktreesRoot(),
        });
        ensureRegistry().set(record);
        return { ok: true, value: record };
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_GET,
    (_event, conversationId: unknown): SessionWorktree | null =>
      isNonEmptyString(conversationId) ? (ensureRegistry().get(conversationId) ?? null) : null
  );

  ipcMain.handle(IPC_CHANNELS.WORKTREE_LIST, (): SessionWorktree[] => ensureRegistry().list());

  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_STATUS,
    async (_event, conversationId: unknown): Promise<WorktreeResult<WorktreeStatus>> => {
      if (!isNonEmptyString(conversationId)) return { ok: false, error: 'invalid conversationId' };
      const record = ensureRegistry().get(conversationId);
      if (!record) return { ok: false, error: 'no worktree for conversation' };
      try {
        return { ok: true, value: await worktreeStatus(record) };
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_REMOVE,
    async (event, conversationId: unknown): Promise<WorktreeResult<null>> => {
      if (!isMainWebContents(event.sender.id) || !isNonEmptyString(conversationId)) {
        return { ok: false, error: 'invalid worktree remove request' };
      }
      const record = ensureRegistry().get(conversationId);
      if (!record) return { ok: true, value: null }; // 幂等：没有记录视为已清理
      try {
        await removeSessionWorktree(record);
        ensureRegistry().delete(conversationId);
        return { ok: true, value: null };
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_REBUILD,
    async (event, conversationId: unknown): Promise<WorktreeResult<SessionWorktree>> => {
      if (!isMainWebContents(event.sender.id) || !isNonEmptyString(conversationId)) {
        return { ok: false, error: 'invalid worktree rebuild request' };
      }
      const record = ensureRegistry().get(conversationId);
      if (!record) return { ok: false, error: 'no worktree record for conversation' };
      try {
        const rebuilt = await rebuildSessionWorktree(record, worktreesRoot());
        ensureRegistry().set(rebuilt);
        return { ok: true, value: rebuilt };
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_REPO_CLEAN,
    async (_event, projectId: unknown): Promise<WorktreeResult<boolean>> => {
      if (!isNonEmptyString(projectId)) return { ok: false, error: 'invalid projectId' };
      const repoPath = resolveRepoPath(projectId);
      if (!repoPath) return { ok: false, error: 'unknown or inactive project' };
      try {
        return { ok: true, value: await repoIsClean(repoPath) };
      } catch (error) {
        return fail(error);
      }
    }
  );
}
