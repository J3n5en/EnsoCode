import { describe, expect, it } from 'vitest';
import { budgetDraft, budgetFormOf, limitsDraft, limitsFormOf } from './budget';

describe('budget form', () => {
  it('round-trips a stored budget and treats blanks as unlimited', () => {
    expect(budgetFormOf(undefined)).toEqual({ budgetCost: '', budgetTokens: '' });
    expect(budgetFormOf({ dailyCostUsd: 0.5, dailyTokens: 2000 })).toEqual({
      budgetCost: '0.5',
      budgetTokens: '2000',
    });
    expect(budgetDraft({ budgetCost: ' ', budgetTokens: '' })).toEqual({ ok: true, budget: null });
    expect(budgetDraft({ budgetCost: '1.25', budgetTokens: '' })).toEqual({
      ok: true,
      budget: { dailyCostUsd: 1.25 },
    });
    expect(budgetDraft({ budgetCost: '', budgetTokens: '1500' })).toEqual({
      ok: true,
      budget: { dailyTokens: 1500 },
    });
  });

  it('rejects non-positive or malformed caps', () => {
    for (const form of [
      { budgetCost: '0', budgetTokens: '' },
      { budgetCost: '-1', budgetTokens: '' },
      { budgetCost: 'abc', budgetTokens: '' },
      { budgetCost: '', budgetTokens: '1.5' },
      { budgetCost: '', budgetTokens: '0' },
    ])
      expect(budgetDraft(form).ok, JSON.stringify(form)).toBe(false);
  });
});

describe('limits form', () => {
  it('round-trips the delegation time limit and per-turn cap; blank = default (null)', () => {
    expect(limitsFormOf({})).toEqual({ delegationTimeout: '', maxTurnTokens: '' });
    expect(limitsFormOf({ delegationTimeoutMinutes: 30, maxTokensPerTurn: 8000 })).toEqual({
      delegationTimeout: '30',
      maxTurnTokens: '8000',
    });
    expect(limitsDraft({ delegationTimeout: ' ', maxTurnTokens: '' })).toEqual({
      ok: true,
      delegationTimeoutMinutes: null,
      maxTokensPerTurn: null,
    });
    expect(limitsDraft({ delegationTimeout: '90', maxTurnTokens: '5000' })).toEqual({
      ok: true,
      delegationTimeoutMinutes: 90,
      maxTokensPerTurn: 5000,
    });
    for (const delegationTimeout of ['0', '1.5', '1441', 'x'])
      expect(limitsDraft({ delegationTimeout, maxTurnTokens: '' }).ok, delegationTimeout).toBe(
        false
      );
    for (const maxTurnTokens of ['0', '1.5', '-1', 'x'])
      expect(limitsDraft({ delegationTimeout: '', maxTurnTokens }).ok, maxTurnTokens).toBe(false);
  });
});
