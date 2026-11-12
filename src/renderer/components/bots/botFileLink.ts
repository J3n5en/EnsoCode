import type { BotChat, Delegation } from '@shared/types/bot';
import type { MarkdownLinkContextValue } from '@/components/chat/Markdown';
import { useBotsStore } from '@/stores/bots';

function sessionProject(chat: BotChat, session: BotChat['sessions'][string]): string | undefined {
  if (session.projectId) return session.projectId;
  return chat.workspace.kind === 'member-home' ? undefined : chat.workspace.projectId;
}

/** 当前会话、或委派子会话（取被委派成员在该聊天里的会话项目，拿不到就不猜）的 projectId */
export function projectIdForBotConversation(
  chats: readonly BotChat[] | undefined,
  delegations: readonly Delegation[] | undefined,
  conversationId: string
): string | undefined {
  for (const chat of chats ?? []) {
    for (const session of Object.values(chat.sessions)) {
      if (session.conversationId === conversationId) return sessionProject(chat, session);
    }
  }
  for (const delegation of delegations ?? []) {
    if (delegation.childConversationId !== conversationId || !delegation.chatId) continue;
    const chat = chats?.find((item) => item.id === delegation.chatId);
    const session = chat?.sessions[delegation.targetBotId];
    if (chat && session) return sessionProject(chat, session);
  }
  return undefined;
}

export function useBotFileLink(
  conversationId: string | null,
  explicitProjectId?: string
): MarkdownLinkContextValue | null {
  const stored = useBotsStore((state) =>
    conversationId
      ? projectIdForBotConversation(state.chats, state.delegations, conversationId)
      : undefined
  );
  const projectId = explicitProjectId ?? stored;
  if (!conversationId || !projectId) return null;
  return { conversationId, projectId };
}
