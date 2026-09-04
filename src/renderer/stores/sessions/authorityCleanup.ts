/**
 * 删除会话时对 source authority 的收尾：end 后 remove。
 * remove 成功才触发主进程的 jsonl 清理（见 main/ipc/agent.ts SOURCE_CONVERSATION_REMOVE），
 * 所以 end 成功、remove 失败会留下 lifecycle='ended' 的注册项 + 磁盘上的孤儿 jsonl；
 * 重删时必须接受 ended 状态并直接补 remove。
 */

import type { ConversationAuthorityProjection } from '@shared/types/agent';

interface AuthorityMutationLike {
  accepted: boolean;
  value?: ConversationAuthorityProjection;
}

export interface ConversationAuthorityPort {
  read(): Promise<{ readonly conversations: readonly ConversationAuthorityProjection[] }>;
  endConversation(request: {
    requestId: string;
    conversationId: string;
    version: number;
  }): Promise<AuthorityMutationLike>;
  removeConversation(request: {
    requestId: string;
    conversationId: string;
    version: number;
  }): Promise<AuthorityMutationLike>;
}

export async function purgeConversationAuthority(
  port: ConversationAuthorityPort,
  conversationId: string,
  newRequestId: () => string
): Promise<boolean> {
  const projection = await port.read();
  const authority = projection.conversations.find(
    (candidate) => candidate.conversationId === conversationId
  );
  if (!authority) return false;

  let version = authority.version;
  if (authority.lifecycle !== 'ended') {
    const ended = await port.endConversation({
      requestId: newRequestId(),
      conversationId,
      version,
    });
    if (!ended.accepted || !ended.value) return false;
    version = ended.value.version;
  }
  const removed = await port.removeConversation({
    requestId: newRequestId(),
    conversationId,
    version,
  });
  return removed.accepted;
}
