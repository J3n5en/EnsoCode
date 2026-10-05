import { describe, expect, it } from 'vitest';
import {
  attributeBotRecords,
  BOT_BUDGET_ERROR,
  botOfConversation,
  budgetVerdict,
  localDayStart,
  sumBotUsage,
} from './botUsage';
import type { UsageRecord } from './types';

function rec(id: string, ts: number, extra: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id,
    ts,
    model: 'm',
    provider: 'p',
    project: '',
    sessionId: 's',
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 0,
    reasoning: 0,
    ...extra,
  };
}

const pricing = { m: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } };

describe('botOfConversation', () => {
  it('attributes private, group and delegation-child sessions to their bound bot', () => {
    const base = { projectId: 'p', kind: 'root' as const, lifecycle: 'ready' as const, version: 1 };
    expect(
      botOfConversation({ ...base, conversationId: 'a', bot: { botId: 'alice', chatId: 'dm' } })
    ).toBe('alice');
    // 委派子会话 binding 记的是目标成员
    expect(
      botOfConversation({
        ...base,
        conversationId: 'c',
        bot: { botId: 'bob', chatId: null, delegationId: 'd1' },
      })
    ).toBe('bob');
    expect(botOfConversation({ ...base, conversationId: 'code' })).toBeUndefined();
  });
});

describe('attributeBotRecords', () => {
  it('groups by bot and counts each jsonl entry once', () => {
    const map = attributeBotRecords([
      { botId: 'a', records: [rec('1', 1), rec('2', 2)] },
      { botId: 'b', records: [rec('3', 3)] },
      { botId: 'a', records: [rec('2', 2)] },
    ]);
    expect(map.get('a')?.map((r) => r.id)).toEqual(['1', '2']);
    expect(map.get('b')?.map((r) => r.id)).toEqual(['3']);
  });
});

describe('sumBotUsage', () => {
  it('sums tokens and cost inside [start, end) only', () => {
    const totals = sumBotUsage(
      [rec('1', 10, { sessionId: 'x' }), rec('2', 20, { sessionId: 'y' }), rec('3', 30)],
      pricing,
      10,
      30
    );
    expect(totals.tokens).toBe(320);
    expect(totals.messages).toBe(2);
    expect(totals.sessions).toBe(2);
    expect(totals.cost).toBeCloseTo((2 * (100 + 100 + 5)) / 1_000_000);
  });

  it('keeps cost null when no record is priced', () => {
    expect(sumBotUsage([rec('1', 1, { model: 'unknown' })], pricing, 0, 10).cost).toBeNull();
  });
});

describe('localDayStart', () => {
  it('resets at local midnight', () => {
    const midnight = new Date(2026, 9, 4, 0, 0, 0, 0).getTime();
    expect(localDayStart(midnight)).toBe(midnight);
    expect(localDayStart(midnight - 1)).toBe(new Date(2026, 9, 3).getTime());
    expect(localDayStart(new Date(2026, 9, 4, 23, 59, 59).getTime(), 1)).toBe(
      new Date(2026, 9, 5).getTime()
    );
    const today = sumBotUsage(
      [rec('y', midnight - 1), rec('t', midnight)],
      pricing,
      localDayStart(midnight + 3_600_000),
      localDayStart(midnight + 3_600_000, 1)
    );
    expect(today.messages).toBe(1);
  });
});

describe('budgetVerdict', () => {
  const used = { tokens: 1000, cost: 0.5, messages: 1, sessions: 1 };
  it('is unlimited without a budget', () => {
    expect(budgetVerdict(undefined, used)).toBeNull();
    expect(budgetVerdict({}, used)).toBeNull();
  });
  it('trips when either cap is reached', () => {
    expect(budgetVerdict({ dailyTokens: 1000 }, used)).toBe('tokens');
    expect(budgetVerdict({ dailyTokens: 1001 }, used)).toBeNull();
    expect(budgetVerdict({ dailyCostUsd: 0.5 }, used)).toBe('cost');
    expect(budgetVerdict({ dailyCostUsd: 1 }, { ...used, cost: null })).toBeNull();
  });
  it('exposes a stable error code', () => {
    expect(BOT_BUDGET_ERROR).toBe('budget-exceeded');
  });
});
