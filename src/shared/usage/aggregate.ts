import { costOf, type PricingTable } from './pricing';
import type {
  UsageDailyPoint,
  UsageModelRow,
  UsageProjectRow,
  UsageRangeDays,
  UsageRecord,
  UsageSummary,
  UsageTotals,
} from './types';

export interface AggregateOptions {
  days: UsageRangeDays;
  /** ms */
  now: number;
}

/** 会话活跃时长由 parser 算好，聚合只做求和 */
export interface SessionActivity {
  sessionId: string;
  activeMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyTotals(): UsageTotals {
  return {
    cost: null,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens: 0,
    sessions: 0,
    messages: 0,
    activeMs: 0,
  };
}

function tokensOf(r: UsageRecord): number {
  return r.input + r.output + r.cacheRead + r.cacheWrite;
}

function addCost(current: number | null, cost: number | null): number | null {
  if (cost === null) return current;
  return (current ?? 0) + cost;
}

function localDayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sumTotals(
  records: UsageRecord[],
  activity: SessionActivity[],
  pricing: PricingTable
): UsageTotals {
  const totals = emptyTotals();
  const sessions = new Set<string>();
  for (const r of records) {
    totals.input += r.input;
    totals.output += r.output;
    totals.cacheRead += r.cacheRead;
    totals.cacheWrite += r.cacheWrite;
    totals.tokens += tokensOf(r);
    totals.messages += 1;
    totals.cost = addCost(totals.cost, costOf(r, pricing));
    sessions.add(r.sessionId);
  }
  totals.sessions = sessions.size;
  for (const a of activity) {
    if (sessions.has(a.sessionId)) totals.activeMs += a.activeMs;
  }
  return totals;
}

/**
 * 周期 = 本地今天 00:00 + 24h 往前 days 天，[start, end)。
 * previous 为紧邻其前的等长周期；daily / heatmap / 排行只用当前周期。
 */
export function aggregateUsage(
  records: UsageRecord[],
  activity: SessionActivity[],
  pricing: PricingTable,
  opts: AggregateOptions
): UsageSummary {
  const today = new Date(opts.now);
  today.setHours(0, 0, 0, 0);
  const rangeEnd = today.getTime() + DAY_MS;
  const rangeStart = rangeEnd - opts.days * DAY_MS;
  const prevStart = rangeStart - opts.days * DAY_MS;

  const current: UsageRecord[] = [];
  const previous: UsageRecord[] = [];
  for (const r of records) {
    if (r.ts >= rangeStart && r.ts < rangeEnd) current.push(r);
    else if (r.ts >= prevStart && r.ts < rangeStart) previous.push(r);
  }

  const totals = sumTotals(current, activity, pricing);

  const daily: UsageDailyPoint[] = Array.from({ length: opts.days }, (_, i) => ({
    day: localDayKey(rangeStart + i * DAY_MS),
    input: 0,
    output: 0,
    cache: 0,
    cost: null,
  }));
  const heatmap: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const byModel = new Map<string, UsageModelRow>();
  const byProject = new Map<string, UsageProjectRow & { sessionIds: Set<string> }>();
  const unpriced = new Set<string>();

  for (const r of current) {
    const cost = costOf(r, pricing);
    const tokens = tokensOf(r);

    const dayIndex = Math.min(opts.days - 1, Math.floor((r.ts - rangeStart) / DAY_MS));
    const point = daily[dayIndex];
    point.input += r.input;
    point.output += r.output;
    point.cache += r.cacheRead + r.cacheWrite;
    point.cost = addCost(point.cost, cost);

    const d = new Date(r.ts);
    heatmap[d.getDay()][d.getHours()] += tokens;

    const modelRow = byModel.get(r.model) ?? {
      model: r.model,
      cost: null,
      tokens: 0,
      messages: 0,
      share: 0,
    };
    modelRow.tokens += tokens;
    modelRow.messages += 1;
    modelRow.cost = addCost(modelRow.cost, cost);
    byModel.set(r.model, modelRow);
    if (cost === null) unpriced.add(r.model);

    const projectRow = byProject.get(r.project) ?? {
      project: r.project,
      cost: null,
      tokens: 0,
      sessions: 0,
      sessionIds: new Set<string>(),
    };
    projectRow.tokens += tokens;
    projectRow.cost = addCost(projectRow.cost, cost);
    projectRow.sessionIds.add(r.sessionId);
    byProject.set(r.project, projectRow);
  }

  const modelRows = [...byModel.values()]
    .map((row) => ({ ...row, share: totals.tokens > 0 ? row.tokens / totals.tokens : 0 }))
    .sort((a, b) => b.tokens - a.tokens);
  const projectRows = [...byProject.values()]
    .map(({ sessionIds, ...row }) => ({ ...row, sessions: sessionIds.size }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    days: opts.days,
    rangeStart,
    rangeEnd,
    totals,
    previous: sumTotals(previous, activity, pricing),
    daily,
    heatmap,
    byModel: modelRows,
    byProject: projectRows,
    unpricedModels: [...unpriced],
  };
}
