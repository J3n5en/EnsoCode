import { conversationIdsToMove, parseMoveConversationInput } from '@shared/moveConversation';
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
  patchProjectIds: (ids: readonly string[], targetProjectId: string, rootId: string) => void;
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
    conversationId
  );
  const released = await ports.releaseSessions(conversationId).catch(() => false);
  if (released && source.scratchRoot)
    ports.removeScratchWorkspace(source.scratchRoot, conversationId);
  return { ok: true, value: result.value };
}
