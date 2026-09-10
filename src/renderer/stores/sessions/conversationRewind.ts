/**
 * 回退入口的纯判定：可见性、唤醒资格、时间线锚点。
 * spawn IPC ack 时 spawning 仍为 true；含该会话的 snapshot 或 parent-ready 会清 spawning，
 * worker 此时已 register，命令进同一 gate。热/冷发送前共用 shouldSendRewindCommand。
 */

export interface ConversationRewindView {
  started: boolean;
  spawning?: boolean;
  status: string;
  historyOnly?: boolean;
  parentId?: string;
  sessionFile?: string;
  historyBaseIndex?: number;
  worktreeMissing?: boolean;
  workspaceMigrating?: boolean;
}

export interface RewindHost {
  canRewind: boolean;
}

export function canWakeConversationForRewind(conversation: ConversationRewindView): boolean {
  return (
    !conversation.started &&
    !conversation.spawning &&
    !conversation.parentId &&
    Boolean(conversation.sessionFile) &&
    !conversation.historyOnly &&
    !conversation.worktreeMissing &&
    !conversation.workspaceMigrating &&
    conversation.status !== 'running'
  );
}

export function canShowConversationRewind(
  conversation: ConversationRewindView | null | undefined,
  host?: RewindHost | null
): boolean {
  if (host && !host.canRewind) return false;
  if (!conversation || conversation.historyOnly) return false;
  if (conversation.worktreeMissing || conversation.workspaceMigrating) return false;
  if (conversation.spawning || conversation.status === 'running') return false;
  if (conversation.started) return true;
  return canWakeConversationForRewind(conversation);
}

export function shouldSendRewindCommand(conversation: ConversationRewindView | undefined): boolean {
  return Boolean(
    conversation?.started &&
      !conversation.spawning &&
      conversation.status !== 'running' &&
      !conversation.historyOnly &&
      !conversation.worktreeMissing &&
      !conversation.workspaceMigrating
  );
}

export type RewindWorkerPhase = 'wait' | 'ready' | 'failed';

export function rewindWorkerPhase(
  conversation: ConversationRewindView | undefined,
  expectedSessionFile: string | undefined
): RewindWorkerPhase {
  if (
    !conversation ||
    conversation.sessionFile !== expectedSessionFile ||
    conversation.historyOnly ||
    conversation.worktreeMissing ||
    conversation.workspaceMigrating
  ) {
    return 'failed';
  }
  if (shouldSendRewindCommand(conversation)) return 'ready';
  if (
    !conversation.started ||
    conversation.status === 'failed' ||
    conversation.status === 'running'
  ) {
    return 'failed';
  }
  return 'wait';
}

export function resolveRewindConfirm(
  originId: string,
  displayedId: string | null | undefined,
  conversation: { messages: readonly { role: string }[]; historyBaseIndex?: number } | undefined,
  absIndex: number
): { conversationId: string; userIndexFromEnd: number } | null {
  if (!conversation || displayedId !== originId) return null;
  const userIndexFromEnd = userIndexFromEndForTimelineKey(conversation, absIndex);
  if (userIndexFromEnd === null) return null;
  return { conversationId: originId, userIndexFromEnd };
}

export function userIndexFromEndForTimelineKey(
  conversation: { messages: readonly { role: string }[]; historyBaseIndex?: number },
  absIndex: number
): number | null {
  if (!Number.isInteger(absIndex) || absIndex < 0) return null;
  const localIndex = absIndex - (conversation.historyBaseIndex ?? 0);
  if (localIndex < 0 || conversation.messages[localIndex]?.role !== 'user') return null;
  return conversation.messages.slice(localIndex + 1).filter((message) => message.role === 'user')
    .length;
}
