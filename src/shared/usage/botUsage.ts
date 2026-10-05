import type { ConversationAuthority } from '../types/agent';
import type { BotBudget } from '../types/bot';
import { startOfLocalDay } from './aggregate';
import { costOf, type PricingTable } from './pricing';
import type { UsageRecord } from './types';

/** 成员超出日预算时投递 / 回合的统一错误码 */
export const BOT_BUDGET_ERROR = 'budget-exceeded';
/** 回合内用量超过成员单回合上限而被停止 */
export const BOT_TURN_LIMIT_ERROR = 'turn-token-limit';

export interface BotUsageTotals {
  tokens: number;
  /** 一条也定价不到时为 null */
  cost: number | null;
  messages: number;
  sessions: number;
}

export type BotBudgetVerdict = 'tokens' | 'cost';

export interface BotUsageRow extends BotUsageTotals {
  botId: string;
  name: string;
}

export interface BotUsageOverview {
  today: BotUsageTotals;
  week: BotUsageTotals;
  month: BotUsageTotals;
  /** 今日已触达的上限；未设预算或未超额时缺省 */
  exhausted?: BotBudgetVerdict;
}

export type BotUsageSummaryResult =
  | { ok: true; rows: BotUsageRow[] }
  | { ok: false; error: string };
export type BotUsageOverviewResult =
  | { ok: true; day: string; bots: Record<string, BotUsageOverview> }
  | { ok: false; error: string };

export const localDayStart = startOfLocalDay;

/** 私聊、群聊、委派子会话（binding 记目标成员）都按 authority 的 bot.botId 归属；Code 会话没有 bot */
export function botOfConversation(conversation: ConversationAuthority): string | undefined {
  return conversation.bot?.botId;
}

/** 同一 jsonl entry id 全局只计一次 */
export function attributeBotRecords(
  sessions: readonly { botId: string; records: readonly UsageRecord[] }[]
): Map<string, UsageRecord[]> {
  const seen = new Set<string>();
  const byBot = new Map<string, UsageRecord[]>();
  for (const session of sessions) {
    for (const record of session.records) {
      if (!record.id || seen.has(record.id)) continue;
      seen.add(record.id);
      const list = byBot.get(session.botId);
      if (list) list.push(record);
      else byBot.set(session.botId, [record]);
    }
  }
  return byBot;
}

/** [start, end) 内的 token（input+output+cacheRead+cacheWrite）与估算成本 */
export function sumBotUsage(
  records: readonly UsageRecord[],
  pricing: PricingTable,
  start: number,
  end: number
): BotUsageTotals {
  const totals: BotUsageTotals = { tokens: 0, cost: null, messages: 0, sessions: 0 };
  const sessions = new Set<string>();
  for (const r of records) {
    if (r.ts < start || r.ts >= end) continue;
    totals.tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
    totals.messages += 1;
    const cost = costOf(r, pricing);
    if (cost !== null) totals.cost = (totals.cost ?? 0) + cost;
    sessions.add(r.sessionId);
  }
  totals.sessions = sessions.size;
  return totals;
}

/** 达到任一上限即超额；未定价（cost=null）不触发成本上限 */
export function budgetVerdict(
  budget: BotBudget | undefined,
  today: BotUsageTotals
): BotBudgetVerdict | null {
  if (budget?.dailyTokens !== undefined && today.tokens >= budget.dailyTokens) return 'tokens';
  if (
    budget?.dailyCostUsd !== undefined &&
    today.cost !== null &&
    today.cost >= budget.dailyCostUsd
  )
    return 'cost';
  return null;
}
