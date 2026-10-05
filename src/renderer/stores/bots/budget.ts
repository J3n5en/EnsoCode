import {
  type BotBudget,
  type BotProfile,
  isDelegationTimeoutMinutes,
  isTokenCap,
} from '@shared/types/bot';
import type { BotUsageOverview } from '@shared/usage/botUsage';

/** 表单里以字符串编辑，留空 = 不限 */
export interface BudgetForm {
  budgetCost: string;
  budgetTokens: string;
}

/** 成员级上限：留空 = 默认 */
export interface LimitsForm {
  delegationTimeout: string;
  maxTurnTokens: string;
}

export interface BotUsageSnapshot {
  day: string;
  bots: Record<string, BotUsageOverview>;
}

export function budgetFormOf(budget: BotBudget | undefined): BudgetForm {
  return {
    budgetCost: budget?.dailyCostUsd !== undefined ? String(budget.dailyCostUsd) : '',
    budgetTokens: budget?.dailyTokens !== undefined ? String(budget.dailyTokens) : '',
  };
}

/** budget:null = 不限；ok:false = 有非法输入 */
export function budgetDraft(
  form: BudgetForm
): { ok: true; budget: BotBudget | null } | { ok: false } {
  const budget: BotBudget = {};
  const cost = form.budgetCost.trim();
  if (cost) {
    const value = Number(cost);
    if (!Number.isFinite(value) || value <= 0) return { ok: false };
    budget.dailyCostUsd = value;
  }
  const tokens = form.budgetTokens.trim();
  if (tokens) {
    const value = Number(tokens);
    if (!Number.isSafeInteger(value) || value <= 0) return { ok: false };
    budget.dailyTokens = value;
  }
  return { ok: true, budget: Object.keys(budget).length > 0 ? budget : null };
}

export function limitsFormOf(
  bot: Pick<BotProfile, 'delegationTimeoutMinutes' | 'maxTokensPerTurn'>
): LimitsForm {
  return {
    delegationTimeout:
      bot.delegationTimeoutMinutes !== undefined ? String(bot.delegationTimeoutMinutes) : '',
    maxTurnTokens: bot.maxTokensPerTurn !== undefined ? String(bot.maxTokensPerTurn) : '',
  };
}

/** null = 默认；ok:false = 有非法输入 */
export function limitsDraft(
  form: LimitsForm
):
  | { ok: true; delegationTimeoutMinutes: number | null; maxTokensPerTurn: number | null }
  | { ok: false } {
  const timeout = form.delegationTimeout.trim() ? Number(form.delegationTimeout) : null;
  const cap = form.maxTurnTokens.trim() ? Number(form.maxTurnTokens) : null;
  if (
    (timeout !== null && !isDelegationTimeoutMinutes(timeout)) ||
    (cap !== null && !isTokenCap(cap))
  )
    return { ok: false };
  return { ok: true, delegationTimeoutMinutes: timeout, maxTokensPerTurn: cap };
}
