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
    options?: { running?: boolean }
  ) => AuthorityMutationResult<ConversationAuthorityProjection>;
  isRunning: (conversationId: string) => boolean;
  readConversations: () => Record<string, Record<string, unknown>>;
  patchProjectIds: (ids: readonly string[], targetProjectId: string) => void;
}

export function handleConversationsMove(
  input: unknown,
  ports: ConversationsMovePorts
): ConversationsMoveResult {
  const parsed = parseMoveConversationInput(input);
  if (!parsed) return { ok: false, error: 'invalid' };
  const result = ports.moveConversation(parsed.conversationId, parsed.targetProjectId, {
    running: ports.isRunning(parsed.conversationId),
  });
  if (!result.accepted) return { ok: false, error: result.error };
  ports.patchProjectIds(
    conversationIdsToMove(ports.readConversations(), parsed.conversationId),
    parsed.targetProjectId
  );
  return { ok: true, value: result.value };
}
