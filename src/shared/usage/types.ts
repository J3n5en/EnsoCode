import type { ModelPricing, PricingTable } from './pricing';

/** 用量统计跨进程传输类型。数据源为本应用的 pi session jsonl，费用为 Main 侧按 catalog 估算。 */

export const USAGE_RANGE_DAYS = [1, 7, 30, 90] as const;
export type UsageRangeDays = (typeof USAGE_RANGE_DAYS)[number];

export function isUsageRangeDays(value: unknown): value is UsageRangeDays {
  return (USAGE_RANGE_DAYS as readonly number[]).includes(value as number);
}

export interface UsageRecord {
  /** jsonl 行 id；fork 复制同一行时全局只计一次 */
  id: string;
  /** assistant 消息时间戳（ms） */
  ts: number;
  model: string;
  provider: string;
  /** cwd basename；缺失为 '' */
  project: string;
  sessionId: string;
  /** 未命中输入 */
  input: number;
  /** 含 reasoning */
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface UsageTotals {
  /** 有定价模型的费用之和；一条也定价不到时为 null */
  cost: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + cacheRead + cacheWrite */
  tokens: number;
  sessions: number;
  /** assistant 消息数 */
  messages: number;
  activeMs: number;
}

export interface UsageDailyPoint {
  /** YYYY-MM-DD，本地时区 */
  day: string;
  input: number;
  output: number;
  /** cacheRead + cacheWrite */
  cache: number;
  cost: number | null;
}

export interface UsageModelRow {
  model: string;
  cost: number | null;
  tokens: number;
  messages: number;
  /** tokens 占比 0..1 */
  share: number;
  /** 有效单价 $/M；无价为 null */
  pricing: ModelPricing | null;
}

export interface UsageProjectRow {
  project: string;
  cost: number | null;
  tokens: number;
  sessions: number;
}

export interface UsageSummary {
  days: UsageRangeDays;
  /** [rangeStart, rangeEnd)，ms */
  rangeStart: number;
  rangeEnd: number;
  totals: UsageTotals;
  /** 紧邻的上一个等长周期 */
  previous: UsageTotals;
  /** 恰好 days 个点，升序，无数据日补零 */
  daily: UsageDailyPoint[];
  /** 7×24，[weekday(0=周日)][hour]，值为 tokens */
  heatmap: number[][];
  byModel: UsageModelRow[];
  byProject: UsageProjectRow[];
  /** 周期内有 token 消耗但无定价的模型 id */
  unpricedModels: string[];
  /** 本次估算用的有效单价表（catalog + 覆盖） */
  pricing: PricingTable;
}

export type UsageSummaryResult = { ok: true; summary: UsageSummary } | { ok: false; error: string };
