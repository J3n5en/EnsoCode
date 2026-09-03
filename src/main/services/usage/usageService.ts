import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { aggregateUsage } from '@shared/usage/aggregate';
import type { ModelPricing, PricingTable } from '@shared/usage/pricing';
import type { UsageRangeDays, UsageRecord, UsageSummaryResult } from '@shared/usage/types';
import { app } from 'electron';
import { getRuntime } from '../oauthProviders';
import { type ParsedSession, parseSessionJsonl } from './parseSession';

interface CacheEntry {
  mtimeMs: number;
  size: number;
  parsed: ParsedSession | null;
}

const fileCache = new Map<string, CacheEntry>();

function sessionDir(): string {
  return path.join(app.getPath('userData'), 'agent', 'sessions');
}

/** 逐文件按 mtime/size 复用解析结果；消失的文件顺手清掉。 */
export function loadSessions(dir: string): ParsedSession[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const sessions: ParsedSession[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    seen.add(file);
    let stat: { mtimeMs: number; size: number };
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    const cached = fileCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      if (cached.parsed) sessions.push(cached.parsed);
      continue;
    }
    let parsed: ParsedSession | null = null;
    try {
      parsed = parseSessionJsonl(readFileSync(file, 'utf8'));
    } catch {
      parsed = null;
    }
    fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
    if (parsed) sessions.push(parsed);
  }
  for (const file of fileCache.keys()) {
    if (!seen.has(file)) fileCache.delete(file);
  }
  return sessions;
}

interface CatalogCostModel {
  id: string;
  cost?: Partial<ModelPricing> | null;
}

function toPricing(cost: CatalogCostModel['cost']): ModelPricing | null {
  if (!cost || typeof cost !== 'object') return null;
  const pick = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    input: pick(cost.input),
    output: pick(cost.output),
    cacheRead: pick(cost.cacheRead),
    cacheWrite: pick(cost.cacheWrite),
  };
}

function isFullyPriced(p: ModelPricing): boolean {
  return p.input > 0 && p.output > 0 && p.cacheRead > 0 && p.cacheWrite > 0;
}

/** 同 id 多 provider：四项单价均非零者优先，否则保留先到的。纯函数，便于测试。 */
export function buildPricingTable(models: readonly CatalogCostModel[]): PricingTable {
  const table: PricingTable = {};
  for (const model of models) {
    if (typeof model.id !== 'string' || !model.id) continue;
    const pricing = toPricing(model.cost);
    if (!pricing) continue;
    const existing = table[model.id];
    if (!existing || (!isFullyPriced(existing) && isFullyPriced(pricing))) {
      table[model.id] = pricing;
    }
  }
  return table;
}

let pricingPromise: Promise<PricingTable> | null = null;

/** catalog 单价表；任一步失败回空表（UI 显示未定价，不阻塞统计）。 */
function getPricingTable(): Promise<PricingTable> {
  pricingPromise ??= (async () => {
    try {
      const runtime = await getRuntime();
      return buildPricingTable(runtime.getModels() as readonly CatalogCostModel[]);
    } catch {
      pricingPromise = null;
      return {};
    }
  })();
  return pricingPromise;
}

export async function getUsageSummary(days: UsageRangeDays): Promise<UsageSummaryResult> {
  try {
    const [sessions, pricing] = await Promise.all([
      Promise.resolve().then(() => loadSessions(sessionDir())),
      getPricingTable(),
    ]);
    const records: UsageRecord[] = [];
    for (const session of sessions) records.push(...session.records);
    const activity = sessions.map((s) => ({ sessionId: s.sessionId, activeMs: s.activeMs }));
    return {
      ok: true,
      summary: aggregateUsage(records, activity, pricing, { days, now: Date.now() }),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
