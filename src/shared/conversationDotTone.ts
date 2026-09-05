export type ConversationDotTone = 'running' | 'failed' | 'waiting' | 'unread' | 'idle';

type ChildActivityConversation = {
  status: string;
  spawning?: boolean;
  subagents?: readonly { status: string }[];
  coworkerIds?: readonly string[];
};

export function conversationHasRunningChild(
  conversation: ChildActivityConversation,
  conversations: Readonly<Record<string, ChildActivityConversation | undefined>>
): boolean {
  return (
    conversation.subagents?.some((agent) => agent.status === 'running') === true ||
    conversation.coworkerIds?.some((childId) => {
      const child = conversations[childId];
      return Boolean(child && (child.spawning || child.status === 'running'));
    }) === true
  );
}

export function conversationDotTone(input: {
  status: string;
  spawning?: boolean;
  unread?: boolean;
  pendingAskCount?: number;
  hasRunningChild?: boolean;
}): ConversationDotTone {
  if (input.status === 'failed' && !input.spawning) return 'failed';
  if ((input.pendingAskCount ?? 0) > 0) return 'waiting';
  if (input.status === 'running' || input.spawning || input.hasRunningChild) return 'running';
  if (input.unread) return 'unread';
  return 'idle';
}
