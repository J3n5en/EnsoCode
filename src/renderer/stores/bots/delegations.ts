import type { BotChat, Delegation, DelegationState } from '@shared/types/bot';
import { type SessionOwner, sessionOwners } from './selectors';

export const isActiveDelegation = (state: DelegationState) =>
  state === 'queued' || state === 'running';

/** 进行中委派的子会话 → 发起聊天；审批/提问归在那里显示「X 替 Y 执行」 */
export function delegationOwners(delegations: readonly Delegation[]): Record<string, SessionOwner> {
  const owners: Record<string, SessionOwner> = {};
  for (const item of delegations) {
    if (!item.chatId || !isActiveDelegation(item.state)) continue;
    owners[item.childConversationId] = {
      chatId: item.chatId,
      botId: item.targetBotId,
      delegation: { id: item.id, parentBotId: item.parentBotId },
    };
  }
  return owners;
}

/** 聊天成员会话 + 委派子会话 */
export function pendingOwners(
  chats: readonly BotChat[],
  delegations: readonly Delegation[]
): Record<string, SessionOwner> {
  return { ...sessionOwners(chats), ...delegationOwners(delegations) };
}

export function activeDelegations(
  delegations: readonly Delegation[],
  chatId: string
): Delegation[] {
  return delegations
    .filter((item) => item.chatId === chatId && isActiveDelegation(item.state))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 已有委派以 retryOf 指向它（Main 也据此拒绝再次重试） */
export function isRetried(item: Delegation, delegations: readonly Delegation[]): boolean {
  return delegations.some((other) => other.retryOf === item.id);
}

/** 失败的从断点重试；手动取消的由用户在「继续」「重新开始」之间选 */
export function delegationActions(state: DelegationState): {
  cancel: boolean;
  retry: boolean;
  resumeOrRestart: boolean;
} {
  return {
    cancel: isActiveDelegation(state),
    retry: state === 'failed',
    resumeOrRestart: state === 'canceled',
  };
}

/** 通知点击的跳转目标：委派子会话没有聊天绑定时归到委派所属聊天，都找不到就去收件箱 */
export function openTarget(
  event: { chatId?: string; conversationId?: string },
  delegations: readonly Delegation[]
): { kind: 'chat'; chatId: string } | { kind: 'inbox' } {
  const chatId =
    event.chatId ??
    delegations.find((item) => item.childConversationId === event.conversationId)?.chatId;
  return chatId ? { kind: 'chat', chatId } : { kind: 'inbox' };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)}h ${rest}m` : `${Math.floor(minutes / 60)}h`;
}
