export type ConversationDotTone = 'running' | 'failed' | 'waiting' | 'unread' | 'idle';

export function conversationDotTone(input: {
  status: string;
  spawning?: boolean;
  unread?: boolean;
  pendingAskCount?: number;
}): ConversationDotTone {
  if (input.status === 'failed' && !input.spawning) return 'failed';
  if ((input.pendingAskCount ?? 0) > 0) return 'waiting';
  if (input.status === 'running' || input.spawning) return 'running';
  if (input.unread) return 'unread';
  return 'idle';
}
