import {
  conversationIdsToMove,
  type ImportProjectSessionsResult,
  parseImportProjectSessionsInput,
  parseMoveConversationInput,
} from '@shared/moveConversation';
import type { AuthorityMutationResult, ConversationAuthorityProjection } from '@shared/types/agent';

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
> & {
  projectKind: (projectId: string) => string | undefined;
  rootConversationIds: (projectId: string) => string[];
  moveConversations: (
    requests: { conversationId: string; running: boolean; worktreeBusy: boolean }[],
    targetProjectId: string
  ) => AuthorityMutationResult<{
    moved: string[];
    skipped: { conversationId: string; error: string }[];
  }>;
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
 * 整项目导入（移动，不复制）：权威归属一次提交、会话行一次补丁，运行中等会话级拒绝跳过并回报。
 * 临时会话来源拒绝：单条移出 scratch 会清理其工作区，整批导入不能顺带删文件。
 */
export async function handleImportProjectSessions(
  input: unknown,
  ports: ImportProjectSessionsPorts
): Promise<ImportProjectSessionsResult> {
  const parsed = parseImportProjectSessionsInput(input);
  if (!parsed) return { ok: false, error: 'invalid' };
  const { sourceProjectId, targetProjectId } = parsed;
  const sourceKind = ports.projectKind(sourceProjectId);
  if (sourceKind === 'scratch' || sourceKind === 'secretary') {
    return { ok: false, error: `source-${sourceKind}` };
  }
  const result = ports.moveConversations(
    ports.rootConversationIds(sourceProjectId).map((conversationId) => ({
      conversationId,
      running: ports.isRunning(conversationId),
      worktreeBusy: ports.worktreeBusy(conversationId),
    })),
    targetProjectId
  );
  if (!result.accepted) return { ok: false, error: result.error };
  const { moved, skipped } = result.value;
  if (moved.length === 0) return { ok: true, moved, skipped };
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
  await Promise.all(
    moved.map((conversationId) => ports.releaseSessions(conversationId).catch(() => false))
  );
  return { ok: true, moved, skipped };
}
