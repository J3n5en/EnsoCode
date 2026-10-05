import { visibleInbox } from '@shared/bots/inbox';
import type { BotRoutine, Delegation } from '@shared/types/bot';
import type { BotInboxItem } from '@shared/types/botIpc';
import type { RoutineAlert } from './routines';
import type { PendingItem } from './selectors';

export interface InboxSections {
  pending: PendingItem[];
  budgets: BotInboxItem[];
  routines: RoutineAlert[];
  silences: BotInboxItem[];
  interrupted: { item: BotInboxItem; record: Delegation }[];
  count: number;
}

/** Main 收件箱条目 → 各类卡片；例程与委派卡片取本地权威记录，找不到就不渲染 */
export function inboxSections(
  items: readonly BotInboxItem[],
  ctx: { routines: readonly BotRoutine[]; delegations: readonly Delegation[] }
): InboxSections {
  const sections: InboxSections = {
    pending: [],
    budgets: [],
    routines: [],
    silences: [],
    interrupted: [],
    count: 0,
  };
  for (const item of visibleInbox(items)) {
    const owner = {
      chatId: item.chatId ?? '',
      botId: item.botId ?? '',
      ...(item.delegationId && item.ownerBotId
        ? { delegation: { id: item.delegationId, parentBotId: item.ownerBotId } }
        : {}),
    };
    if (item.kind === 'approval' && item.approval && item.conversationId)
      sections.pending.push({
        kind: 'approval',
        conversationId: item.conversationId,
        request: item.approval,
        ...owner,
      });
    else if (item.kind === 'ask' && item.ask && item.conversationId)
      sections.pending.push({
        kind: 'ask',
        conversationId: item.conversationId,
        request: item.ask,
        ...owner,
      });
    else if (item.kind === 'budget') sections.budgets.push(item);
    else if (item.kind === 'silence') sections.silences.push(item);
    else if (item.kind === 'routine-draft' || item.kind === 'routine-blocked') {
      const routine = ctx.routines.find(
        (entry) => entry.id === item.routine?.id && entry.botId === item.routine.botId
      );
      if (routine)
        sections.routines.push({
          kind: item.kind === 'routine-draft' ? 'approval' : 'blocked',
          routine,
        });
    } else if (item.kind === 'delegation-interrupted') {
      const record = ctx.delegations.find((entry) => entry.id === item.delegationId);
      if (record) sections.interrupted.push({ item, record });
    }
  }
  sections.count =
    sections.pending.length +
    sections.budgets.length +
    sections.routines.length +
    sections.silences.length +
    sections.interrupted.length;
  return sections;
}
