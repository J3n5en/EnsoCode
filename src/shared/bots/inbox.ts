import type { BotRoutine, Delegation } from '../types/bot';
import type { BotInboxItem, BotInboxKind, BotSilence } from '../types/botIpc';
import type { BotUsageOverview } from '../usage/botUsage';

/** Main 收件箱的输入：时间戳与忽略 / 结束状态由存储维护 */
export type BotInboxInput = Omit<
  BotInboxItem,
  'createdAt' | 'updatedAt' | 'dismissedAt' | 'resolvedAt'
>;

/** 只是提示的条目可以忽略；审批、提问、例程待批准 / 阻塞需要处理才会消失 */
export const INBOX_DISMISSIBLE: readonly BotInboxKind[] = [
  'delegation-interrupted',
  'budget',
  'silence',
];

/** 已有委派以 retryOf 指向它，或之后出现同父会话、同目标、同任务的新委派（成员自己重新委派） */
function superseded(item: Delegation, delegations: readonly Delegation[]): boolean {
  return delegations.some(
    (other) =>
      other.retryOf === item.id ||
      (other.createdAt > item.createdAt &&
        other.parentConversationId === item.parentConversationId &&
        other.targetBotId === item.targetBotId &&
        other.task === item.task)
  );
}

/** 重启中断、未被重试的委派 */
export function delegationInboxItems(delegations: readonly Delegation[]): BotInboxInput[] {
  return delegations
    .filter(
      (item) =>
        item.chatId !== null &&
        item.state === 'failed' &&
        item.failure === 'interrupted' &&
        !superseded(item, delegations)
    )
    .map((item) => ({
      key: `delegation-interrupted:${item.id}`,
      kind: 'delegation-interrupted',
      chatId: item.chatId,
      botId: item.targetBotId,
      ownerBotId: item.parentBotId,
      delegationId: item.id,
      text: item.task,
    }));
}

/** 今日预算耗尽：按成员 + 自然日 */
export function budgetInboxItems(overview: {
  day: string;
  bots: Record<string, BotUsageOverview>;
}): BotInboxInput[] {
  return Object.entries(overview.bots).flatMap(([botId, usage]): BotInboxInput[] =>
    usage.exhausted
      ? [
          {
            key: `budget:${botId}:${overview.day}`,
            kind: 'budget',
            chatId: null,
            botId,
            budget: { reason: usage.exhausted, day: overview.day },
          },
        ]
      : []
  );
}

/** 成员提议 / 改动待批准（按版本，改动后重新出现）与依赖检查不通过被阻塞的例程 */
export function routineInboxItems(routines: readonly BotRoutine[]): BotInboxInput[] {
  return routines.flatMap((routine): BotInboxInput[] => {
    const ref = { botId: routine.botId, id: routine.id };
    if (routine.status === 'draft')
      return [
        {
          key: `routine-draft:${routine.botId}:${routine.id}:${routine.procedureVersion}`,
          kind: 'routine-draft',
          chatId: routine.chatId,
          botId: routine.botId,
          routine: ref,
          text: routine.title,
        },
      ];
    if (routine.status === 'blocked')
      return [
        {
          key: `routine-blocked:${routine.botId}:${routine.id}`,
          kind: 'routine-blocked',
          chatId: routine.chatId,
          botId: routine.botId,
          routine: ref,
          ...(routine.blockedReason ? { text: routine.blockedReason } : {}),
        },
      ];
    return [];
  });
}

/** 静默看门狗：每次静默一条；委派会话归到发起委派的聊天 */
export function silenceInboxItems(
  silences: readonly BotSilence[],
  delegations: readonly Delegation[]
): BotInboxInput[] {
  return silences.map((item) => {
    const record = item.delegationId
      ? delegations.find((entry) => entry.id === item.delegationId)
      : undefined;
    return {
      key: `silence:${item.conversationId}:${item.since}`,
      kind: 'silence',
      chatId: item.chatId ?? record?.chatId ?? null,
      botId: item.botId,
      conversationId: item.conversationId,
      ...(item.delegationId ? { delegationId: item.delegationId } : {}),
      ...(record ? { ownerBotId: record.parentBotId } : {}),
      since: item.since,
    };
  });
}

/** 收件箱显示：未结束、未忽略，新的在前 */
export function visibleInbox(items: readonly BotInboxItem[]): BotInboxItem[] {
  return items
    .filter((item) => item.resolvedAt === undefined && item.dismissedAt === undefined)
    .sort((a, b) => b.createdAt - a.createdAt);
}
