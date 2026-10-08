import type {
  BotChat,
  Delegation,
  DelegationRetryBy,
  DelegationState,
  DelegationTrigger,
} from '@shared/types/bot';
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

/** 排队 / 进行中，或失败后正在等自动重试（Main 视同未结束：不回传、不唤醒委派人） */
export function activeDelegations(
  delegations: readonly Delegation[],
  chatId: string
): Delegation[] {
  return delegations
    .filter(
      (item) =>
        item.chatId === chatId &&
        (isActiveDelegation(item.state) || isAwaitingAutoRetry(item, delegations))
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 「查看过程」分流：排队/进行中的委派子会话看实时投影（排队时还未落盘，历史是空的），
 * 已结束的看历史快照。返回目标成员 id，非活动委派或非委派会话返回 undefined。
 */
export function delegationLiveTarget(
  delegations: readonly Delegation[],
  conversationId: string
): { botId: string } | undefined {
  const item = delegations.find(
    (record) => record.childConversationId === conversationId && isActiveDelegation(record.state)
  );
  return item ? { botId: item.targetBotId } : undefined;
}

export interface DelegationRunMark {
  key: string;
  at: number;
  /** 本会话内第几次执行 */
  n: number;
  trigger: DelegationTrigger;
}

/** 「查看过程」分隔：同一子会话有两次以上已开工的执行时，按开工时间（旧记录用发起时间）编号 */
export function delegationRunMarks(
  delegations: readonly Delegation[],
  conversationId: string
): DelegationRunMark[] {
  const runs = delegations.flatMap((record) => {
    if (record.childConversationId !== conversationId) return [];
    const at = record.startedAt ?? (record.state === 'queued' ? undefined : record.createdAt);
    return at === undefined ? [] : [{ record, at }];
  });
  if (runs.length < 2) return [];
  return runs
    .sort((a, b) => a.at - b.at)
    .map(({ record, at }, index) => ({
      key: `run:${record.id}`,
      at,
      n: index + 1,
      trigger: record.trigger ?? 'delegate',
    }));
}

/** 已有委派以 retryOf 指向它（Main 也据此拒绝再次重试） */
export function isRetried(item: Delegation, delegations: readonly Delegation[]): boolean {
  return delegations.some((other) => other.retryOf === item.id);
}

/** 失败后已排定自动重试、接替记录还没出现：显示「将自动重试」，不是最终失败（与 Main pendingAutoRetry 同一判定） */
export function isAwaitingAutoRetry(item: Delegation, delegations: readonly Delegation[]): boolean {
  return item.state === 'failed' && item.autoRetryAt !== undefined && !isRetried(item, delegations);
}

/** 由自动重试发起的接替记录，仍在排队 / 进行 */
export function isAutoRetrying(item: Delegation): boolean {
  return Boolean(item.retryOf) && item.retryBy === 'auto' && isActiveDelegation(item.state);
}

/** 第几次重试：沿 retryOf 往上数（原始委派为 0）；上游已不在列表里按已知部分计，成环即停 */
export function retryAttempt(item: Delegation, delegations: readonly Delegation[]): number {
  let count = 0;
  const seen = new Set<string>();
  for (let current: Delegation | undefined = item; current?.retryOf && !seen.has(current.id); ) {
    seen.add(current.id);
    count++;
    const previous: string = current.retryOf;
    current = delegations.find((other) => other.id === previous);
  }
  return count;
}

/** 重试来源；非重试记录返回 undefined，旧数据没有 retryBy 视为界面手动重试 */
export function retrySource(item: Delegation): DelegationRetryBy | undefined {
  return item.retryOf ? (item.retryBy ?? 'human') : undefined;
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
