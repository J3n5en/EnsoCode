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

/** 一轮的活跃区间 [start, end]，由 parser 算好并截断；聚合时按周期裁剪 */
export interface ActivitySpan {
  start: number;
  end: number;
}

export interface SessionActivity {
  sessionId: string;
  spans: ActivitySpan[];
}

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

/** 本地日历零点再偏移 N 天：跨 DST 也落在真正的 00:00，不用 ms×86400000 硬算 */
function startOfLocalDay(ts: number, offsetDays = 0): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.getTime();
}

function localDayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Σ span 与 [start, end) 的重叠；同 sessionId 只取首个条目 */
function activeMsWithin(activity: SessionActivity[], start: number, end: number): number {
  const seen = new Set<string>();
  let total = 0;
  for (const a of activity) {
    if (seen.has(a.sessionId)) continue;
    seen.add(a.sessionId);
    for (const span of a.spans) {
      const overlap = Math.min(span.end, end) - Math.max(span.start, start);
      if (overlap > 0) total += overlap;
    }
  }
  return total;
}

function sumTotals(
  records: UsageRecord[],
  activity: SessionActivity[],
  pricing: PricingTable,
  start: number,
  end: number
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
  totals.activeMs = activeMsWithin(activity, start, end);
  return totals;
}

/**
 * 周期 = 本地今天 00:00 + 1 天往前 days 个日历日，[start, end)。
 * previous 为紧邻其前的等长周期；daily / heatmap / 排行只用当前周期。
 */
export function aggregateUsage(
  records: UsageRecord[],
  activity: SessionActivity[],
  pricing: PricingTable,
  opts: AggregateOptions
): UsageSummary {
  const rangeEnd = startOfLocalDay(opts.now, 1);
  const rangeStart = startOfLocalDay(opts.now, 1 - opts.days);
  const prevStart = startOfLocalDay(opts.now, 1 - 2 * opts.days);

  const current: UsageRecord[] = [];
  const previous: UsageRecord[] = [];
  for (const r of records) {
    if (r.ts >= rangeStart && r.ts < rangeEnd) current.push(r);
    else if (r.ts >= prevStart && r.ts < rangeStart) previous.push(r);
  }

  const totals = sumTotals(current, activity, pricing, rangeStart, rangeEnd);

  const daily: UsageDailyPoint[] = [];
  const dayIndex = new Map<string, number>();
  for (let i = 0; i < opts.days; i++) {
    const day = localDayKey(startOfLocalDay(rangeStart, i));
    dayIndex.set(day, daily.length);
    daily.push({ day, input: 0, output: 0, cache: 0, cost: null });
  }
  const heatmap: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const byModel = new Map<string, UsageModelRow>();
  const byProject = new Map<string, UsageProjectRow & { sessionIds: Set<string> }>();
  const unpriced = new Set<string>();

  for (const r of current) {
    const cost = costOf(r, pricing);
    const tokens = tokensOf(r);

    const point = daily[dayIndex.get(localDayKey(r.ts)) ?? daily.length - 1];
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
    if (cost === null && tokens > 0) unpriced.add(r.model);

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
    previous: sumTotals(previous, activity, pricing, prevStart, rangeStart),
    daily,
    heatmap,
    byModel: modelRows,
    byProject: projectRows,
    unpricedModels: [...unpriced],
  };
}
