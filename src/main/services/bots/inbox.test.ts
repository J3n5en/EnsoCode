import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentWorkerEvent, ConversationAuthority } from '../../../shared/types/agent';
import type { BotRoutine, Delegation } from '../../../shared/types/bot';
import type { BotEvent, BotSilence } from '../../../shared/types/botIpc';
import type { BotUsageOverview } from '../../../shared/usage/botUsage';
import { BotInboxService } from './inbox';
import { BotInboxStore } from './inboxStore';

let root: string;
let events: BotEvent[];
let delegations: Delegation[];
let routines: BotRoutine[];
let silences: BotSilence[];
let exhausted: boolean;
const conversations: Record<string, Partial<ConversationAuthority>> = {
  s1: { bot: { botId: 'alice', chatId: 'c1' } },
  k1: { bot: { botId: 'ops', chatId: null, delegationId: 'd1' } },
};

const make = () =>
  new BotInboxService({
    store: new BotInboxStore(join(root, 'inbox.jsonl')),
    conversation: (id) => conversations[id] as ConversationAuthority | undefined,
    delegations: () => delegations,
    routines: () => routines,
    usage: async (): Promise<{ day: string; bots: Record<string, BotUsageOverview> }> => ({
      day: '2026-10-04',
      bots: exhausted
        ? {
            alice: {
              today: { tokens: 0, cost: null, messages: 0, sessions: 0 },
              week: { tokens: 0, cost: null, messages: 0, sessions: 0 },
              month: { tokens: 0, cost: null, messages: 0, sessions: 0 },
              exhausted: 'cost',
            },
          }
        : {},
    }),
    silences: () => silences,
    emit: (event) => events.push(event),
  });
const ev = (event: Record<string, unknown>, sessionId: string): AgentWorkerEvent =>
  ({ seq: 1, identity: { sessionId, generation: 'g' }, ...event }) as AgentWorkerEvent;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-inbox-svc-'));
  events = [];
  delegations = [
    {
      id: 'd1',
      parentConversationId: 'p',
      parentBotId: 'boss',
      targetBotId: 'ops',
      chatId: 'g1',
      task: 'deploy',
      context: '',
      childConversationId: 'k1',
      state: 'running',
      depth: 1,
      createdAt: 1,
    },
  ];
  routines = [];
  silences = [];
  exhausted = false;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('BotInboxService', () => {
  it('tracks approvals and questions (delegated ones under the delegating chat) until resolved', () => {
    const inbox = make();
    inbox.observe(
      ev(
        { type: 'approval-request', request: { requestId: 'r1', tool: 'bash', summary: 'ls' } },
        's1'
      )
    );
    inbox.observe({
      type: 'ask-request',
      seq: 2,
      identity: {
        sessionId: 'k1::c',
        generation: 'g',
        parent: { sessionId: 'k1', generation: 'g' },
      },
      ask: { requestId: 'q1', question: 'Which env?' },
    } as unknown as AgentWorkerEvent);
    inbox.observe(ev({ type: 'approval-request', request: { requestId: 'x' } }, 'code-session'));
    expect(inbox.list().map((item) => [item.key, item.chatId, item.ownerBotId, item.text])).toEqual(
      [
        ['approval:s1:r1', 'c1', undefined, 'bash · ls'],
        ['ask:k1:q1', 'g1', 'boss', 'Which env?'],
      ]
    );
    expect(events).toEqual([{ kind: 'inbox' }, { kind: 'inbox' }]);
    inbox.observe(ev({ type: 'approval-resolved', requestId: 'r1' }, 's1'));
    inbox.turnFinished('k1');
    expect(inbox.list()).toEqual([]);
    inbox.observe(
      ev(
        { type: 'approval-request', request: { requestId: 'r2', tool: 'bash', summary: 'x' } },
        's1'
      )
    );
    inbox.observe({ type: 'worker-exited' });
    expect(inbox.list()).toEqual([]);
  });

  it('re-derives delegations, routines, budget and silences from their sources', async () => {
    const inbox = make();
    delegations = [{ ...delegations[0], state: 'failed', failure: 'interrupted' }];
    routines = [
      {
        id: 'r',
        botId: 'alice',
        chatId: 'c1',
        title: 'Daily',
        prompt: 'p',
        schedule: '0 9 * * *',
        status: 'draft',
        procedureVersion: 1,
        catchUp: true,
        createdAt: 0,
        updatedAt: 0,
      } as BotRoutine,
    ];
    silences = [{ conversationId: 's1', chatId: 'c1', botId: 'alice', since: 5 }];
    exhausted = true;
    for (const kind of ['delegation', 'routine', 'silence', 'budget'] as const)
      inbox.onBotEvent({ kind });
    await vi.waitFor(() => expect(inbox.list()).toHaveLength(4));
    expect(inbox.dismiss('routine-draft:alice:r:1')).toEqual({
      ok: false,
      error: 'not-dismissible',
    });
    expect(inbox.dismiss('silence:s1:5')).toEqual({ ok: true });
    expect(inbox.dismiss('nope')).toEqual({ ok: false, error: 'not-found' });
    silences = [];
    inbox.onBotEvent({ kind: 'silence' });
    expect(inbox.list().some((item) => item.kind === 'silence')).toBe(false);
    // 忽略状态持久：重启后仍然隐藏；启动时上一进程的审批 / 静默全部结束
    expect(
      make()
        .list()
        .map((item) => item.kind)
        .sort()
    ).toEqual(['budget', 'delegation-interrupted', 'routine-draft']);
  });
});
