import { statSync } from 'node:fs';
import {
  conversationIdsToMove,
  type ImportProjectSessionsPreview,
  type ImportProjectSessionsResult,
  importCopyCount,
  type ProjectPairInput,
  parseImportProjectSessionsInput,
  parseMoveConversationInput,
  parseProjectPairInput,
  parseRemoveEmptyProjectInput,
  type RemoveEmptyProjectResult,
} from '@shared/moveConversation';
import type {
  AuthorityMutationResult,
  ConversationAuthorityProjection,
  ProjectAuthorityProjection,
  RemoveProjectAuthorityRequest,
} from '@shared/types/agent';
import {
  type CopyProjectSessionsPorts,
  copyProjectSessions,
  recoverCopy,
} from './conversationsCopy';
import {
  beginImportJournal,
  endImportJournal,
  type ImportJournal,
  pendingImportJournals,
  serializeImport,
} from './conversationsImportJournal';

export { conversationIdsToMove, parseMoveConversationInput };

export type ConversationsMoveResult =
  | { ok: true; value: ConversationAuthorityProjection }
  | { ok: false; error: string };

export interface ConversationsMovePorts {
  moveConversation: (
    conversationId: string,
    targetProjectId: string,
    options?: { running?: boolean; worktreeBusy?: boolean }
  ) => AuthorityMutationResult<ConversationAuthorityProjection>;
  /** 会话树（含子会话、预约、btw 旁路）是否在跑 */
  isRunning: (conversationId: string) => boolean;
  /** 会话绑定的 worktree 正被操作，或共用它的会话在跑 */
  worktreeBusy: (conversationId: string) => boolean;
  /** 移动前的归属；scratch 来源带上 scratch 根，移动后清理 `<根>/<会话 id>` */
  source: (conversationId: string) => { projectId: string; scratchRoot?: string } | undefined;
  readConversations: () => Record<string, Record<string, unknown>>;
  /** 会话行改挂目标项目，并清掉 rootIds 根会话行上的 worktree 绑定 */
  patchProjectIds: (
    ids: readonly string[],
    targetProjectId: string,
    rootIds: readonly string[]
  ) => void;
  /** 只解除登记，不删 worktree 目录 */
  unbindWorktree: (conversationId: string) => void;
  /** 释放 worker 里挂着的根会话与 btw 旁路，下次 spawn 按新项目推导 cwd；全部释放成功返回 true */
  releaseSessions: (conversationId: string) => Promise<boolean>;
  removeScratchWorkspace: (scratchRoot: string, conversationId: string) => void;
}

export async function handleConversationsMove(
  input: unknown,
  ports: ConversationsMovePorts
): Promise<ConversationsMoveResult> {
  const parsed = parseMoveConversationInput(input);
  if (!parsed) return { ok: false, error: 'invalid' };
  const { conversationId, targetProjectId } = parsed;
  const source = ports.source(conversationId);
  const result = ports.moveConversation(conversationId, targetProjectId, {
    running: ports.isRunning(conversationId),
    worktreeBusy: ports.worktreeBusy(conversationId),
  });
  if (!result.accepted) return { ok: false, error: result.error };
  if (!source || source.projectId === result.value.projectId) {
    return { ok: true, value: result.value };
  }
  try {
    ports.unbindWorktree(conversationId);
  } catch {}
  ports.patchProjectIds(
    conversationIdsToMove(ports.readConversations(), conversationId),
    targetProjectId,
    [conversationId]
  );
  const released = await ports.releaseSessions(conversationId).catch(() => false);
  if (released && source.scratchRoot)
    ports.removeScratchWorkspace(source.scratchRoot, conversationId);
  return { ok: true, value: result.value };
}

export type ImportProjectSessionsPorts = Pick<
  ConversationsMovePorts,
  | 'isRunning'
  | 'worktreeBusy'
  | 'readConversations'
  | 'patchProjectIds'
  | 'unbindWorktree'
  | 'releaseSessions'
> &
  CopyProjectSessionsPorts & {
    project: (projectId: string) => ProjectAuthorityProjection | undefined;
    projectKind: (projectId: string) => string | undefined;
    /** 项目下还有没有会话（含归档、Bot 会话）；已结束的不算 */
    projectHasConversations: (projectId: string) => boolean;
    moveConversations: (
      requests: { conversationId: string; running: boolean; worktreeBusy: boolean }[],
      targetProjectId: string
    ) => AuthorityMutationResult<{
      moved: string[];
      skipped: { conversationId: string; error: string }[];
    }>;
    /** 只改权威表的项目状态，不删任何文件 */
    removeProject: (
      request: RemoveProjectAuthorityRequest
    ) => AuthorityMutationResult<ProjectAuthorityProjection>;
  };

/** 源项目下仍有效的根会话；子会话不在权威表里，随根会话一起改归属 */
export function projectRootConversationIds(
  conversations: readonly ConversationAuthorityProjection[],
  projectId: string
): string[] {
  return conversations
    .filter(
      (conversation) =>
        conversation.projectId === projectId &&
        conversation.kind === 'root' &&
        conversation.lifecycle !== 'ended' &&
        !conversation.bot
    )
    .map((conversation) => conversation.conversationId);
}

/**
 * 整项目导入，移动或复制。临时会话、秘书来源一律拒绝：单条移出 scratch 会清理其工作区，
 * 整批导入不能顺带删文件；秘书会话固定在秘书里。
 */
export async function handleImportProjectSessions(
  input: unknown,
  ports: ImportProjectSessionsPorts
): Promise<ImportProjectSessionsResult> {
  const parsed = parseImportProjectSessionsInput(input);
  if (!parsed) return { ok: false, error: 'invalid' };
  const sourceKind = ports.projectKind(parsed.sourceProjectId);
  if (sourceKind === 'scratch' || sourceKind === 'secretary') {
    return { ok: false, error: `source-${sourceKind}` };
  }
  const result =
    parsed.mode === 'move'
      ? await moveProjectSessions(parsed, ports)
      : await copyProjectSessions(parsed, ports);
  return result.ok
    ? { ...result, sourceEmpty: !ports.projectHasConversations(parsed.sourceProjectId) }
    : result;
}

/**
 * 移动：权威归属一次提交、会话行一次补丁，运行中等会话级拒绝跳过并回报。
 * 归属、worktree 登记、会话行分属三份文件，先落事务记录；中途死掉由启动恢复补完解绑与会话行。
 */
function moveProjectSessions(
  { sourceProjectId, targetProjectId }: ProjectPairInput,
  ports: ImportProjectSessionsPorts
): Promise<ImportProjectSessionsResult> {
  return serializeImport(async () => {
    const requests = ports.rootConversationIds(sourceProjectId).map((conversationId) => ({
      conversationId,
      running: ports.isRunning(conversationId),
      worktreeBusy: ports.worktreeBusy(conversationId),
    }));
    let journal: string | undefined;
    if (requests.length > 0) {
      try {
        journal = await beginImportJournal(ports.sessionDir, ports.randomUuid(), {
          v: 1,
          kind: 'move',
          targetProjectId,
          conversationIds: requests.map((request) => request.conversationId),
        });
      } catch {
        return { ok: false, error: 'move-failed' };
      }
    }
    const result = ports.moveConversations(requests, targetProjectId);
    const moved = result.accepted ? result.value.moved : [];
    if (moved.length > 0) finishMove(moved, targetProjectId, ports);
    if (journal) await endImportJournal(journal, ports.durableFiles);
    if (!result.accepted) return { ok: false, error: result.error };
    await Promise.all(
      moved.map((conversationId) => ports.releaseSessions(conversationId).catch(() => false))
    );
    return {
      ok: true,
      mode: 'move',
      imported: moved,
      skipped: result.value.skipped,
      sourceEmpty: false,
    };
  });
}

/** 归属已提交之后的收尾，可重复执行：解绑 worktree，会话行改挂目标项目并清掉根会话上的 worktree */
function finishMove(
  moved: readonly string[],
  targetProjectId: string,
  ports: Pick<
    ImportProjectSessionsPorts,
    'unbindWorktree' | 'patchProjectIds' | 'readConversations'
  >
) {
  for (const conversationId of moved) {
    try {
      ports.unbindWorktree(conversationId);
    } catch {}
  }
  ports.patchProjectIds(
    conversationIdsToMove(ports.readConversations(), moved),
    targetProjectId,
    moved
  );
}

function recoverMove(
  journal: Extract<ImportJournal, { kind: 'move' }>,
  ports: ImportProjectSessionsPorts
) {
  const moved = journal.conversationIds.filter(
    (id) => ports.conversation(id)?.projectId === journal.targetProjectId
  );
  if (moved.length > 0) finishMove(moved, journal.targetProjectId, ports);
}

/**
 * 启动时在后台收尾上次中途死掉的整项目导入。只处理事务记录列出的会话与副本，
 * 不按「没被引用」推断删除任何文件；读不懂的记录原样保留。失败只记日志。
 */
export function recoverProjectImports(ports: ImportProjectSessionsPorts): Promise<void> {
  return serializeImport(async () => {
    try {
      for (const { file, journal } of await pendingImportJournals(ports.sessionDir)) {
        if (!journal) {
          console.warn('[project-import] 无法识别的事务记录，保留不动', file);
          continue;
        }
        try {
          if (journal.kind === 'copy') await recoverCopy(journal, ports);
          else recoverMove(journal, ports);
          await endImportJournal(file, ports.durableFiles);
        } catch (error) {
          console.warn('[project-import] 恢复失败，下次启动再试', file, error);
        }
      }
    } catch (error) {
      console.warn('[project-import] 恢复失败', error);
    }
  });
}

/** 弹窗用：源目录还在不在（决定默认移动还是复制），以及目标里已有几份副本 */
export function handleImportProjectSessionsPreview(
  input: unknown,
  ports: Pick<ImportProjectSessionsPorts, 'project' | 'readConversations'>
): ImportProjectSessionsPreview {
  const parsed = parseProjectPairInput(input);
  if (!parsed) return { ok: false, error: 'invalid' };
  const source = ports.project(parsed.sourceProjectId);
  if (source?.state !== 'active') return { ok: false, error: 'unavailable' };
  let sourceExists = true;
  if (source.kind !== 'ssh') {
    try {
      sourceExists = statSync(source.canonicalPath).isDirectory();
    } catch {
      sourceExists = false;
    }
  }
  return {
    ok: true,
    sourceExists,
    copies: importCopyCount(
      ports.readConversations(),
      parsed.sourceProjectId,
      parsed.targetProjectId
    ),
  };
}

/**
 * 移动后清理空的旧项目：只把项目从列表里去掉。与「移除项目」不同，不清理任何会话文件，
 * 不碰项目目录与 worktree；项目里还有会话时拒绝。
 */
export function handleRemoveEmptyProject(
  input: unknown,
  ports: Pick<ImportProjectSessionsPorts, 'project' | 'projectHasConversations' | 'removeProject'>
): RemoveEmptyProjectResult {
  const parsed = parseRemoveEmptyProjectInput(input);
  if (!parsed) return { ok: false, error: 'invalid' };
  const project = ports.project(parsed.projectId);
  if (project?.state !== 'active') return { ok: false, error: 'unavailable' };
  if (project.kind === 'scratch' || project.kind === 'secretary' || project.kind === 'bot-home') {
    return { ok: false, error: 'reserved' };
  }
  if (ports.projectHasConversations(project.projectId)) return { ok: false, error: 'not-empty' };
  const removed = ports.removeProject({
    requestId: crypto.randomUUID(),
    projectId: project.projectId,
    version: project.version,
  });
  return removed.accepted ? { ok: true } : { ok: false, error: removed.error };
}
