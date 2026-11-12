import { conversationDotTone, conversationHasRunningChild } from '../conversationDotTone';

/** 与插件 `session_status` 同名同序 */
export const THEME_STATES = ['idle', 'running', 'waiting', 'error'] as const;
export type ThemeState = (typeof THEME_STATES)[number];

interface StateConversation {
  status?: string;
  spawning?: boolean;
  unread?: boolean;
  parentId?: string;
  btwParentId?: string;
  pendingAsks?: readonly unknown[];
  pendingApprovals?: readonly unknown[];
  subagents?: readonly { status: string }[];
  coworkerIds?: readonly string[];
}

type Conversations = Readonly<Record<string, StateConversation | undefined>>;

export function sessionThemeState(
  conversation: StateConversation | undefined,
  conversations: Conversations
): ThemeState {
  if (!conversation) return 'idle';
  return conversationThemeState({
    ...conversation,
    hasRunningChild: conversationHasRunningChild(
      { ...conversation, status: conversation.status ?? 'idle' },
      conversations
    ),
  });
}

/** 子会话是否在跑已由调用方算好（如侧栏目录投影的 `hasRunningChild`），其余与 sessionThemeState 相同 */
export function conversationThemeState(
  conversation: StateConversation & { hasRunningChild?: boolean }
): ThemeState {
  const tone = conversationDotTone({
    status: conversation.status ?? 'idle',
    spawning: conversation.spawning,
    pendingAskCount:
      (conversation.pendingAsks?.length ?? 0) + (conversation.pendingApprovals?.length ?? 0),
    hasRunningChild: conversation.hasRunningChild,
  });
  return tone === 'failed' ? 'error' : tone === 'unread' ? 'idle' : tone;
}

export function appActivityState(conversations: Conversations): ThemeState {
  let rank = 0;
  for (const conversation of Object.values(conversations)) {
    if (!conversation || conversation.parentId || conversation.btwParentId) continue;
    rank = Math.max(rank, THEME_STATES.indexOf(sessionThemeState(conversation, conversations)));
  }
  return THEME_STATES[rank];
}
