import { describe, expect, it } from 'vitest';
import type { BotRoutine, Delegation } from '../types/bot';
import type { BotInboxItem } from '../types/botIpc';
import {
  budgetInboxItems,
  delegationInboxItems,
  INBOX_DISMISSIBLE,
  routineInboxItems,
  silenceInboxItems,
  visibleInbox,
} from './inbox';

const record = (over: Partial<Delegation>): Delegation => ({
  id: 'd1',
  parentConversationId: 'p1',
  parentBotId: 'boss',
  targetBotId: 'ops',
  chatId: 'c1',
  task: 'deploy',
  context: '',
  childConversationId: 'k1',
  state: 'running',
  depth: 1,
  createdAt: 10,
  ...over,
});

describe('delegationInboxItems', () => {
  const interrupted = record({ state: 'failed', failure: 'interrupted', finishedAt: 50 });
  it('列出因重启中断、未被重试也未被成员重新委派、且有聊天的委派', () => {
    expect(delegationInboxItems([interrupted, record({ id: 'x', state: 'failed' })])).toEqual([
      {
        key: 'delegation-interrupted:d1',
        kind: 'delegation-interrupted',
        chatId: 'c1',
        botId: 'ops',
        ownerBotId: 'boss',
        delegationId: 'd1',
        text: 'deploy',
      },
    ]);
    expect(
      delegationInboxItems([interrupted, record({ id: 'd9', createdAt: 60, state: 'queued' })])
    ).toEqual([]);
    expect(
      delegationInboxItems([interrupted, record({ id: 'r', retryOf: 'd1', state: 'failed' })])
    ).toEqual([]);
    expect(delegationInboxItems([{ ...interrupted, chatId: null }])).toEqual([]);
  });
});

describe('budgetInboxItems', () => {
  const today = { tokens: 0, cost: null, messages: 0, sessions: 0 };
  const row = { today, week: today, month: today };
  it('按成员 + 自然日给出今日超额的成员', () => {
    expect(
      budgetInboxItems({
        day: '2026-10-04',
        bots: { a: { ...row, exhausted: 'tokens' }, b: row },
      })
    ).toEqual([
      {
        key: 'budget:a:2026-10-04',
        kind: 'budget',
        chatId: null,
        botId: 'a',
        budget: { reason: 'tokens', day: '2026-10-04' },
      },
    ]);
  });
});

describe('routineInboxItems', () => {
  const base = {
    botId: 'b',
    chatId: 'c',
    title: 't',
    prompt: 'p',
    schedule: '0 9 * * *',
    procedureVersion: 1,
    catchUp: true,
    createdAt: 0,
  };
  const routine = (id: string, over: Partial<BotRoutine>): BotRoutine =>
    ({ ...base, id, status: 'enabled', approvedVersion: 1, updatedAt: 1, ...over }) as BotRoutine;

  it('待批准的草稿按版本建键（改动后重新出现），被阻塞的按例程建键', () => {
    const items = routineInboxItems([
      routine('a', {}),
      routine('b', { status: 'draft', approvedVersion: undefined, procedureVersion: 3 }),
      routine('c', { status: 'blocked', blockedReason: 'chat-archived' }),
      routine('d', { status: 'paused', procedureVersion: 2 }),
    ]);
    expect(items.map((item) => [item.key, item.kind, item.chatId, item.text])).toEqual([
      ['routine-draft:b:b:3', 'routine-draft', 'c', 't'],
      ['routine-blocked:b:c', 'routine-blocked', 'c', 'chat-archived'],
    ]);
    expect(items[0].routine).toEqual({ botId: 'b', id: 'b' });
  });
});

describe('silenceInboxItems', () => {
  it('每次静默一条（按起点建键），委派会话归到发起委派的聊天', () => {
    const items = silenceInboxItems(
      [
        { conversationId: 's1', chatId: 'c1', botId: 'a', since: 5 },
        { conversationId: 'k1', chatId: null, botId: 'ops', delegationId: 'd1', since: 7 },
      ],
      [record({})]
    );
    expect(items).toEqual([
      {
        key: 'silence:s1:5',
        kind: 'silence',
        chatId: 'c1',
        botId: 'a',
        conversationId: 's1',
        since: 5,
      },
      {
        key: 'silence:k1:7',
        kind: 'silence',
        chatId: 'c1',
        botId: 'ops',
        conversationId: 'k1',
        delegationId: 'd1',
        ownerBotId: 'boss',
        since: 7,
      },
    ]);
  });
});

describe('visibleInbox', () => {
  it('只留未结束、未忽略的，新的在前', () => {
    const item = (key: string, over: Partial<BotInboxItem>): BotInboxItem => ({
      key,
      kind: 'budget',
      chatId: null,
      createdAt: 1,
      updatedAt: 1,
      ...over,
    });
    expect(
      visibleInbox([
        item('a', { createdAt: 1 }),
        item('b', { createdAt: 3 }),
        item('c', { dismissedAt: 4 }),
        item('d', { resolvedAt: 4 }),
      ]).map((entry) => entry.key)
    ).toEqual(['b', 'a']);
    expect(INBOX_DISMISSIBLE).toEqual(['delegation-interrupted', 'budget', 'silence']);
  });
});
