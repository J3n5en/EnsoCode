import type { BotRoutine, Delegation } from '@shared/types/bot';
import type { BotInboxItem } from '@shared/types/botIpc';
import { describe, expect, it } from 'vitest';
import { inboxSections } from './inbox';

const item = (key: string, over: Partial<BotInboxItem>): BotInboxItem => ({
  key,
  kind: 'budget',
  chatId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('inboxSections', () => {
  it('按卡片类型分组，审批 / 提问还原成可答复的待处理项，找不到权威记录的跳过', () => {
    const approval = { requestId: 'r', tool: 'bash', kind: 'exec', summary: 'ls' } as never;
    const routine = { id: 'rt', botId: 'b', status: 'draft' } as BotRoutine;
    const record = { id: 'd1', chatId: 'c' } as Delegation;
    const sections = inboxSections(
      [
        item('a', { kind: 'approval', chatId: 'c', botId: 'b', conversationId: 's', approval }),
        item('q', {
          kind: 'ask',
          chatId: 'c',
          botId: 'ops',
          conversationId: 'k',
          delegationId: 'd1',
          ownerBotId: 'boss',
          ask: { requestId: 'q', question: '?' },
        }),
        item('x', { kind: 'approval', chatId: 'c', botId: 'b' }),
        item('budget', { kind: 'budget', botId: 'b', budget: { reason: 'cost', day: 'd' } }),
        item('rd', { kind: 'routine-draft', routine: { botId: 'b', id: 'rt' } }),
        item('gone', { kind: 'routine-blocked', routine: { botId: 'b', id: 'missing' } }),
        item('s', { kind: 'silence', since: 3 }),
        item('i', { kind: 'delegation-interrupted', delegationId: 'd1' }),
        item('hidden', { kind: 'silence', dismissedAt: 2 }),
      ],
      { routines: [routine], delegations: [record] }
    );
    expect(sections.pending).toEqual([
      { kind: 'approval', conversationId: 's', request: approval, chatId: 'c', botId: 'b' },
      {
        kind: 'ask',
        conversationId: 'k',
        request: { requestId: 'q', question: '?' },
        chatId: 'c',
        botId: 'ops',
        delegation: { id: 'd1', parentBotId: 'boss' },
      },
    ]);
    expect(sections.budgets.map((entry) => entry.key)).toEqual(['budget']);
    expect(sections.routines).toEqual([{ kind: 'approval', routine }]);
    expect(sections.silences.map((entry) => entry.key)).toEqual(['s']);
    expect(sections.interrupted).toEqual([{ item: expect.objectContaining({ key: 'i' }), record }]);
    expect(sections.count).toBe(6);
  });
});
