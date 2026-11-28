/**
 * 会话级 worktree 隔离的 IPC 层：参数校验 + 转发到 services/worktree。
 * 产品语义（默认本地、opt-in、拦截规则）见 docs/plans/2026-08-22-enso-code-design.md。
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app, ipcMain } from '@platform';
import { coalesceRuns, mapLimited } from '@shared/coalesceRuns';
import type { GitRequest } from '@shared/types/git';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type {
  SessionWorktree,
  WorkspaceBranches,
  WorkspaceBranchesResult,
  WorkspaceBranchFailure,
  WorkspaceBranchSwitchResult,
  WorktreeStatus,
} from '@shared/types/worktree';
import { resolveWorktreeRoot } from '@shared/worktreeRoot';
import {
  freezeWorkspace,
  readSettingsState,
  setWorkspaceBusyResolver,
  thawWorkspace,
} from '../services/agentHost';
import {
  checkWorkspaceBranchSwitch,
  type GitWorkspaceBranches,
  readWorkspaceBranches,
  switchWorkspaceBranch,
  validateWorkspaceBranch,
  WorkspaceBranchError,
  workspaceIdentityPath,
} from '../services/gitBranches';
import { GitOperationError } from '../services/gitVersionControl';
import { isMainRenderer } from '../services/renderers';
import { getSharedWorktreeRegistry, type WorktreeRegistry } from '../services/worktree/registry';
import {
  createSessionWorktree,
  rebuildSessionWorktree,
  removeSessionWorktree,
  repoIsClean,
  worktreeStatus,
} from '../services/worktree/service';
import { worktreeTrash } from '../services/worktree/trash';
import { getSourceAuthorityRegistry } from './agent';
import { agentSessionIndex } from './sessionIndex';

let registry: WorktreeRegistry | null = null;
const busyWorktrees = new Map<string, Promise<void>>();
const bindingConversations = new Map<string, Promise<void>>();
/** 批量查状态时同时跑的 git 数：每个状态要起几次 git，几百条登记不能一起 spawn */
const STATUS_CONCURRENCY = 4;

function lockWorktree(worktreePath: string): () => void {
  let release!: () => void;
  busyWorktrees.set(
    worktreePath,
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  return () => {
    busyWorktrees.delete(worktreePath);
    release();
  };
}

function worktreesRoot(): string {
  return resolveWorktreeRoot(
    readSettingsState()?.worktreeRoot,
    path.join(app.getPath('userData'), 'worktrees')
  );
}

function ensureRegistry(): WorktreeRegistry {
  if (!registry) {
    registry = getSharedWorktreeRegistry(path.join(app.getPath('userData'), 'worktrees.json'));
  }
  return registry;
}

/** Workflow/usage 等 Main 服务必须复用该唯一实例，避免多个 JSON 缓存互相覆盖。 */
export function getWorktreeRegistry(): WorktreeRegistry {
  return ensureRegistry();
}

/** spawn cwd 授权用：该会话登记过的 worktree 记录（main 权威，不信任 renderer 传路径） */
export function sessionWorktree(conversationId: string): SessionWorktree | undefined {
  return ensureRegistry().get(conversationId);
}

export function sessionWorktreeBusy(conversationId: string): boolean {
  const rootId = agentSessionIndex.workspaceRoot(conversationId);
  const record = sessionWorktree(rootId);
  const authority = getSourceAuthorityRegistry()?.conversation(rootId);
  const cwd = record?.path ?? (authority && resolveRepoPath(authority.projectId));
  return bindingConversations.has(rootId) || Boolean(cwd && workspaceOperation(cwd));
}

/** 移动会话前判定：工作区正被操作，或共用该 worktree 的任一会话（含 btw 旁路、子会话预约）在跑 */
export function sessionWorktreeInUse(conversationId: string): boolean {
  if (sessionWorktreeBusy(conversationId)) return true;
  const record = sessionWorktree(agentSessionIndex.workspaceRoot(conversationId));
  return Boolean(
    record &&
      ensureRegistry()
        .bindings(record)
        .some(
          ({ conversationId: id }) =>
            sessionWorktreeBusy(id) ||
            agentSessionIndex.workspaceTreeRunning(id) ||
            agentSessionIndex.btwTreeRunning(id)
        )
  );
}

/** 只解除会话与 worktree 的登记，不删目录；其他共用它的会话保持绑定 */
export function unbindSessionWorktree(conversationId: string): void {
  ensureRegistry().delete(conversationId);
}

const physicalPath = workspaceIdentityPath;

function workspaceOperation(cwd: string): Promise<void> | undefined {
  for (const [key, pending] of busyWorktrees) {
    if (physicalPath(key) === physicalPath(cwd)) return pending;
  }
  return undefined;
}

export function shareSessionWorktree(fromConversationId: string, toConversationId: string): void {
  const record = sessionWorktree(fromConversationId);
  if (!record) return;
  const source = activeRoot(fromConversationId);
  const target = activeRoot(toConversationId);
  if (
    !source ||
    !target ||
    target.projectId !== source.projectId ||
    record.projectId !== source.projectId ||
    record.repoPath !== resolveRepoPath(source.projectId) ||
    target.lifecycle !== 'draft' ||
    target.sessionFile ||
    target.forkedFrom?.conversationId !== fromConversationId ||
    sessionWorktreeBusy(fromConversationId) ||
    sessionWorktreeBusy(toConversationId) ||
    sessionWorktree(toConversationId)
  ) {
    throw new Error('worktree cannot be shared with this fork');
  }
  ensureRegistry().share(fromConversationId, toConversationId);
}

export async function removeRegisteredWorktree(
  conversationId: string,
  expected?: SessionWorktree
): Promise<void> {
  for (;;) {
    const record = sessionWorktree(conversationId);
    const pending =
      bindingConversations.get(conversationId) ?? (record && workspaceOperation(record.path));
    if (pending) {
      await pending;
      continue;
    }
    if (
      !record ||
      (expected &&
        (record.path !== expected.path ||
          record.projectId !== expected.projectId ||
          record.repoPath !== expected.repoPath ||
          record.createdAt !== expected.createdAt))
    )
      return;
    const release = lockWorktree(record.path);
    try {
      if (ensureRegistry().bindings(record).length === 1)
        await removeSessionWorktree(record, worktreesRoot());
      ensureRegistry().delete(conversationId);
      return;
    } finally {
      release();
    }
  }
}

export type WorktreeResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Main 内部建 worktree（秘书派活）：与 WORKTREE_CREATE 同一套校验与串行化 */
export async function createConversationWorktree(
  conversationId: string,
  projectId: string,
  base?: { checkout?: string; baseRef?: string; branch?: string }
): Promise<WorktreeResult<SessionWorktree>> {
  const repoPath = resolveRepoPath(projectId);
  if (!repoPath || activeRoot(conversationId)?.projectId !== projectId) {
    return { ok: false, error: 'unknown or inactive conversation project' };
  }
  if (sessionWorktree(conversationId) || sessionWorktreeBusy(conversationId)) {
    return { ok: false, error: 'conversation already has a worktree operation' };
  }
  let release!: () => void;
  bindingConversations.set(
    conversationId,
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  try {
    const record = await createSessionWorktree({
      repoPath,
      conversationId,
      projectId,
      root: worktreesRoot(),
      ...(base?.baseRef ? { baseRef: base.baseRef } : {}),
      ...(base?.branch ? { branch: base.branch } : {}),
    });
    if (activeRoot(conversationId)?.projectId !== projectId) {
      await removeSessionWorktree(record, worktreesRoot());
      return { ok: false, error: 'conversation authority changed' };
    }
    ensureRegistry().set(record);
    return { ok: true, value: record };
  } catch (error) {
    return fail(error);
  } finally {
    bindingConversations.delete(conversationId);
    release();
  }
}

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
  // ssh 项目的 canonicalPath 是远端路径，本地 git worktree 操作无意义；scratch / secretary 没有仓库
  if (project?.kind === 'ssh' || project?.kind === 'scratch' || project?.kind === 'secretary') {
    return null;
  }
  return project?.state === 'active' ? project.canonicalPath : null;
}

function activeRoot(conversationId: string) {
  const conversation = getSourceAuthorityRegistry()?.conversation(conversationId);
  return conversation?.kind === 'root' &&
    conversation.lifecycle !== 'ended' &&
    resolveRepoPath(conversation.projectId)
    ? conversation
    : undefined;
}

function bindable(conversationId: string, sourceId: string, record: SessionWorktree): boolean {
  const target = activeRoot(conversationId);
  const source = activeRoot(sourceId);
  return Boolean(
    target &&
      source &&
      target.projectId === source.projectId &&
      source.projectId === record.projectId &&
      resolveRepoPath(source.projectId) === record.repoPath &&
      target.lifecycle === 'draft' &&
      !target.sessionFile &&
      !target.forkedFrom &&
      !agentSessionIndex.currentIdentity(conversationId) &&
      !ensureRegistry().get(conversationId) &&
      ensureRegistry().get(sourceId) === record
  );
}

function workspaceContext(conversationId: string) {
  const conversation = activeRoot(conversationId);
  if (!conversation) return undefined;
  const repoPath = resolveRepoPath(conversation.projectId)!;
  const record = sessionWorktree(conversationId);
  if (
    record &&
    (record.projectId !== conversation.projectId ||
      physicalPath(record.repoPath) !== physicalPath(repoPath))
  )
    return undefined;
  return { conversation, repoPath, path: record?.path ?? repoPath, record };
}

function workspaceRoots(cwd: string): string[] {
  return (getSourceAuthorityRegistry()?.projection().conversations ?? [])
    .filter((conversation) => {
      const context = workspaceContext(conversation.conversationId);
      return context && physicalPath(context.path) === physicalPath(cwd);
    })
    .map((conversation) => conversation.conversationId);
}

export async function withSessionGitWorkspace<T>(
  request: GitRequest,
  mutate: boolean,
  action: (cwd: string, assertCurrent: () => void) => Promise<T>
): Promise<T> {
  const rootId = agentSessionIndex.workspaceRoot(request.conversationId);
  const context = workspaceContext(rootId);
  const assertCurrent = () => {
    const conversation = getSourceAuthorityRegistry()?.conversation(request.conversationId);
    const current = workspaceContext(rootId);
    if (
      !context ||
      !current ||
      !conversation ||
      conversation.lifecycle === 'ended' ||
      conversation.projectId !== request.projectId ||
      current.conversation.projectId !== request.projectId ||
      current.path !== context.path ||
      current.repoPath !== context.repoPath ||
      current.conversation.version !== context.conversation.version ||
      agentSessionIndex.workspaceRoot(request.conversationId) !== rootId
    ) {
      throw new GitOperationError('unavailable', '会话工作区不可用或授权已变更。');
    }
  };
  assertCurrent();
  if (!context) throw new GitOperationError('unavailable', '本地工作区不可用。');
  const roots = workspaceRoots(context.path);
  if (roots.some(sessionWorktreeBusy)) {
    throw new GitOperationError('workspace-busy', '工作区操作正在进行，请稍后重试。');
  }
  if (mutate && roots.some((id) => agentSessionIndex.workspaceTreeRunning(id))) {
    throw new GitOperationError(
      'workspace-running',
      '使用该工作区的会话正在运行，请先停止后再修改 Git。'
    );
  }
  if (!mutate) {
    const result = await action(context.path, assertCurrent);
    assertCurrent();
    if (roots.some(sessionWorktreeBusy)) {
      throw new GitOperationError('workspace-busy', '工作区操作正在进行，请稍后重试。');
    }
    return result;
  }
  const release = lockWorktree(context.path);
  const requestId = randomUUID();
  let frozen = false;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const result = await freezeWorkspace(requestId, roots);
    frozen = result.ok || result.needsThaw === true;
    if (!result.ok) {
      throw new GitOperationError('workspace-running', result.error ?? '无法冻结工作区。');
    }
    assertCurrent();
    outcome = { ok: true, value: await action(context.path, assertCurrent) };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    if (frozen) {
      const resume = () => thawWorkspace(requestId, roots).catch(() => ({ ok: false }));
      let result = await resume();
      if (!result.ok) result = await resume();
      frozen = !result.ok;
    }
    if (!frozen) release();
  }
  if (frozen) {
    throw new GitOperationError(
      'workspace-blocked',
      'Git 操作结束但工作区未能解锁，请重启 EnsoCode 后刷新 Git 状态。'
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function occupiedConversation(repoPath: string, cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  return ensureRegistry()
    .list()
    .find(
      (record) =>
        physicalPath(record.path) === physicalPath(cwd) &&
        physicalPath(record.repoPath) === physicalPath(repoPath) &&
        workspaceContext(record.conversationId)?.path === record.path
    )?.conversationId;
}

function branchProjection(
  context: NonNullable<ReturnType<typeof workspaceContext>>,
  snapshot: GitWorkspaceBranches,
  ignoreBusy = false
): WorkspaceBranches {
  const affectedConversationIds = workspaceRoots(context.path);
  const blockedReason =
    snapshot.busy || (!ignoreBusy && affectedConversationIds.some(sessionWorktreeBusy))
      ? 'busy'
      : affectedConversationIds.some((id) => agentSessionIndex.workspaceTreeRunning(id))
        ? 'running'
        : snapshot.dirty
          ? 'dirty'
          : undefined;
  return {
    currentBranch: snapshot.currentBranch,
    defaultBranch: snapshot.defaultBranch ?? null,
    headCommit: snapshot.headCommit,
    affectedConversationIds,
    ...(blockedReason ? { blockedReason } : {}),
    branches: snapshot.branches.map(({ name, worktreePath }) => {
      const occupied = Boolean(
        worktreePath && physicalPath(worktreePath) !== physicalPath(context.path)
      );
      const worktreeConversationId = occupied
        ? occupiedConversation(context.repoPath, worktreePath)
        : undefined;
      return { name, occupied, ...(worktreeConversationId ? { worktreeConversationId } : {}) };
    }),
  };
}

function branchFailure(error: unknown): WorkspaceBranchFailure {
  return {
    ok: false,
    code: error instanceof WorkspaceBranchError ? error.code : 'git-error',
    error: error instanceof Error ? error.message : String(error),
  };
}

export function registerWorktreeHandlers(): void {
  setWorkspaceBusyResolver(sessionWorktreeBusy);
  const STATUS_CACHE_TTL_MS = 5_000;
  let statusCache: { at: number; value: Record<string, WorktreeStatus> } | null = null;
  const invalidateStatusCache = (): void => {
    statusCache = null;
  };
  // 上次没删完的回收目录：启动稍后在后台重试，不拖慢启动
  setTimeout(() => {
    void (async () => {
      const { defaultCleanupWorktreeRoots } = await import('../services/secretary/cleanup');
      const managed = path.join(app.getPath('userData'), 'worktrees');
      const roots = new Set([worktreesRoot(), ...defaultCleanupWorktreeRoots(managed)]);
      for (const root of roots) await worktreeTrash.sweep(root);
    })().catch((error) => console.warn('[worktree-trash] startup sweep failed', error));
  }, 30_000).unref?.();
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_BRANCHES,
    async (event, conversationId: unknown): Promise<WorkspaceBranchesResult> => {
      if (!isMainRenderer(event.sender.id) || !isNonEmptyString(conversationId))
        return { ok: false, code: 'unavailable', error: 'Invalid workspace request.' };
      const context = workspaceContext(conversationId);
      if (!context)
        return { ok: false, code: 'unavailable', error: 'Local root workspace is unavailable.' };
      try {
        const snapshot = await readWorkspaceBranches(context.path);
        if (workspaceContext(conversationId)?.path !== context.path)
          return { ok: false, code: 'unavailable', error: 'Workspace authority changed.' };
        return { ok: true, value: branchProjection(context, snapshot) };
      } catch (error) {
        return branchFailure(error);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_SWITCH_BRANCH,
    async (event, request: unknown): Promise<WorkspaceBranchSwitchResult> => {
      if (
        !isMainRenderer(event.sender.id) ||
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        !('conversationId' in request) ||
        !isNonEmptyString(request.conversationId) ||
        !('branch' in request) ||
        typeof request.branch !== 'string' ||
        ('create' in request && request.create !== undefined && typeof request.create !== 'boolean')
      ) {
        return { ok: false, code: 'unavailable', error: 'Invalid branch switch request.' };
      }
      const { conversationId, branch } = request;
      const create = 'create' in request && request.create === true;
      const context = workspaceContext(conversationId);
      if (!context)
        return { ok: false, code: 'unavailable', error: 'Local root workspace is unavailable.' };
      const roots = workspaceRoots(context.path);
      if (roots.some(sessionWorktreeBusy))
        return { ok: false, code: 'busy', error: 'Workspace operation in progress.' };
      if (roots.some((id) => agentSessionIndex.workspaceTreeRunning(id)))
        return { ok: false, code: 'running', error: 'A session using this workspace is running.' };
      const release = lockWorktree(context.path);
      const requestId = randomUUID();
      let frozen = false;
      let changed = false;
      let applied: WorkspaceBranchFailure['changed'];
      const resumeWorkspace = async () => {
        const attempt = () =>
          thawWorkspace(requestId, roots, changed ? branch : undefined).catch((error) => ({
            ok: false,
            error: String(error),
          }));
        let result = await attempt();
        if (!result.ok) result = await attempt();
        frozen = !result.ok;
        if (frozen && applied) applied.blockedReason = 'busy';
        return result;
      };
      const perform = async (): Promise<WorkspaceBranchSwitchResult> => {
        await validateWorkspaceBranch(context.path, branch);
        const before = await readWorkspaceBranches(context.path);
        try {
          checkWorkspaceBranchSwitch(context.path, before, branch, create);
        } catch (error) {
          const failure = branchFailure(error);
          const worktreeConversationId =
            failure.code === 'occupied'
              ? occupiedConversation(
                  context.repoPath,
                  before.branches.find((item) => item.name === branch)?.worktreePath
                )
              : undefined;
          return { ...failure, ...(worktreeConversationId ? { worktreeConversationId } : {}) };
        }
        const locked = await freezeWorkspace(requestId, roots);
        frozen = locked.ok || locked.needsThaw === true;
        if (!locked.ok) {
          return {
            ok: false,
            code: 'running',
            error: locked.error ?? 'Workspace could not be frozen.',
          };
        }
        const current = workspaceContext(conversationId);
        if (
          !current ||
          current.path !== context.path ||
          current.conversation.version !== context.conversation.version ||
          roots.some((id) => agentSessionIndex.workspaceTreeRunning(id))
        ) {
          return {
            ok: false,
            code: 'unavailable',
            error: 'Workspace authority or activity changed.',
          };
        }
        const after = await switchWorkspaceBranch(
          context.path,
          branch,
          create,
          () => {
            const latest = workspaceContext(conversationId);
            if (
              !latest ||
              latest.path !== context.path ||
              latest.conversation.version !== context.conversation.version
            )
              throw new WorkspaceBranchError('unavailable', 'Workspace authority changed.');
          },
          (snapshot) => {
            changed = true;
            const bindings = ensureRegistry()
              .list()
              .filter(
                (record) =>
                  physicalPath(record.path) === physicalPath(context.path) &&
                  physicalPath(record.repoPath) === physicalPath(context.repoPath)
              );
            applied = {
              requestId,
              ...branchProjection(context, snapshot, true),
              worktrees: bindings.map((record) => ({ ...record, branch })),
            };
            ensureRegistry().updateBranches(
              bindings.map((record) => record.conversationId),
              branch
            );
          }
        );
        applied = {
          requestId,
          ...branchProjection(context, after, true),
          worktrees: applied?.worktrees ?? [],
        };
        return { ok: true, value: applied };
      };
      let result: WorkspaceBranchSwitchResult;
      try {
        result = await perform();
      } catch (error) {
        const failure = branchFailure(error);
        result = applied
          ? {
              ...failure,
              changed: applied,
              error: `Branch switched, but synchronization failed: ${failure.error}`,
            }
          : failure;
      } finally {
        try {
          if (frozen) await resumeWorkspace();
        } finally {
          if (!frozen) release();
        }
      }
      invalidateStatusCache();
      return frozen
        ? {
            ok: false,
            code: applied ? 'git-error' : 'busy',
            workspaceBlocked: true,
            ...(applied ? { changed: applied } : {}),
            error: `${applied ? 'Branch switched, but the workspace' : 'Workspace'} remains blocked. Restart EnsoCode to recover.${result.ok ? '' : ` ${result.error}`}`,
          }
        : result;
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_BIND,
    async (
      event,
      conversationId: unknown,
      sourceId: unknown
    ): Promise<WorktreeResult<SessionWorktree>> => {
      if (
        !isMainRenderer(event.sender.id) ||
        !isNonEmptyString(conversationId) ||
        !isNonEmptyString(sourceId) ||
        conversationId === sourceId
      ) {
        return { ok: false, error: 'invalid worktree bind request' };
      }
      const record = ensureRegistry().get(sourceId);
      if (!record || !bindable(conversationId, sourceId, record)) {
        return {
          ok: false,
          error: 'worktree binding requires fresh same-project root conversations',
        };
      }
      if (workspaceOperation(record.path) || sessionWorktreeBusy(conversationId)) {
        return { ok: false, error: 'worktree operation in progress' };
      }
      const release = lockWorktree(record.path);
      bindingConversations.set(conversationId, busyWorktrees.get(record.path)!);
      try {
        if (!(await worktreeStatus(record)).exists)
          return { ok: false, error: 'worktree is missing' };
        if (!bindable(conversationId, sourceId, record))
          return { ok: false, error: 'worktree authority changed' };
        ensureRegistry().share(sourceId, conversationId);
        invalidateStatusCache();
        return { ok: true, value: ensureRegistry().get(conversationId)! };
      } catch (error) {
        return fail(error);
      } finally {
        bindingConversations.delete(conversationId);
        release();
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_RENAME,
    (event, conversationId: unknown, name: unknown): WorktreeResult<SessionWorktree[]> => {
      if (
        !isMainRenderer(event.sender.id) ||
        !isNonEmptyString(conversationId) ||
        typeof name !== 'string'
      ) {
        return { ok: false, error: 'invalid worktree rename request' };
      }
      const record = ensureRegistry().get(conversationId);
      const authority = activeRoot(conversationId);
      if (
        !record ||
        authority?.projectId !== record.projectId ||
        resolveRepoPath(record.projectId) !== record.repoPath ||
        workspaceOperation(record.path)
      ) {
        return { ok: false, error: 'worktree is unavailable' };
      }
      try {
        const renamed = ensureRegistry().rename(conversationId, name);
        invalidateStatusCache();
        return { ok: true, value: renamed };
      } catch (error) {
        return fail(error);
      }
    }
  );
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_CREATE,
    async (event, request: unknown): Promise<WorktreeResult<SessionWorktree>> => {
      if (
        !isMainRenderer(event.sender.id) ||
        !request ||
        typeof request !== 'object' ||
        !('conversationId' in request) ||
        !('projectId' in request) ||
        !isNonEmptyString(request.conversationId) ||
        !isNonEmptyString(request.projectId)
      ) {
        return { ok: false, error: 'invalid worktree create request' };
      }
      const { conversationId, projectId } = request;
      const result = await createConversationWorktree(conversationId, projectId);
      invalidateStatusCache();
      return result;
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
        const value = await worktreeStatus(record);
        invalidateStatusCache();
        return { ok: true, value };
      } catch (error) {
        return fail(error);
      }
    }
  );

  // 侧栏徽标与自动归档要全部状态：一次请求代替逐条往返（远端每条都要过隧道）；
  // 本机与远端各窗口同时刷新共用一轮，途中再来的等下一轮，保证看到调用之后的状态
  const allStatuses = coalesceRuns(async (): Promise<Record<string, WorktreeStatus>> => {
    const entries = await mapLimited(
      ensureRegistry().list(),
      STATUS_CONCURRENCY,
      async (record) => {
        try {
          return [record.conversationId, await worktreeStatus(record)] as const;
        } catch {
          return null;
        }
      }
    );
    return Object.fromEntries(entries.filter((entry) => entry !== null));
  });
  ipcMain.handle(IPC_CHANNELS.WORKTREE_STATUSES, async () => {
    if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_TTL_MS) {
      return statusCache.value;
    }
    const value = await allStatuses();
    statusCache = { at: Date.now(), value };
    return value;
  });

  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_REMOVE,
    async (event, conversationId: unknown): Promise<WorktreeResult<null>> => {
      if (!isMainRenderer(event.sender.id) || !isNonEmptyString(conversationId)) {
        return { ok: false, error: 'invalid worktree remove request' };
      }
      try {
        await removeRegisteredWorktree(conversationId);
        invalidateStatusCache();
        return { ok: true, value: null };
      } catch (error) {
        return fail(error);
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_REBUILD,
    async (event, conversationId: unknown): Promise<WorktreeResult<SessionWorktree>> => {
      if (!isMainRenderer(event.sender.id) || !isNonEmptyString(conversationId)) {
        return { ok: false, error: 'invalid worktree rebuild request' };
      }
      const record = ensureRegistry().get(conversationId);
      if (!record) return { ok: false, error: 'no worktree record for conversation' };
      if (workspaceOperation(record.path))
        return { ok: false, error: 'worktree operation in progress' };
      const release = lockWorktree(record.path);
      try {
        if ((await worktreeStatus(record)).exists) return { ok: true, value: record };
        if (
          ensureRegistry()
            .bindings(record)
            .some((binding) => agentSessionIndex.isAlive(binding.conversationId))
        ) {
          return { ok: false, error: 'release all sessions using this worktree before rebuilding' };
        }
        const rebuilt = await rebuildSessionWorktree(record, worktreesRoot());
        ensureRegistry().replaceBindings(record, rebuilt);
        invalidateStatusCache();
        return { ok: true, value: rebuilt };
      } catch (error) {
        return fail(error);
      } finally {
        release();
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
