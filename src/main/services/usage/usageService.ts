import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { aggregateUsage, type SessionActivity } from '@shared/usage/aggregate';
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

async function loadOne(file: string): Promise<ParsedSession | null> {
  let info: { mtimeMs: number; size: number };
  try {
    info = await stat(file);
  } catch {
    return null;
  }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.parsed;
  }
  let parsed: ParsedSession | null = null;
  try {
    parsed = parseSessionJsonl(await readFile(file, 'utf8'));
  } catch {
    parsed = null;
  }
  fileCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, parsed });
  return parsed;
}

/**
 * 逐文件按 mtime/size 复用解析结果；消失的文件顺手清掉。
 * 全程 promise IO：冷启动 60MB 级会话目录不能卡住主进程事件循环。
 */
export async function loadSessions(dir: string): Promise<ParsedSession[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const files = names.map((name) => path.join(dir, name));
  const seen = new Set(files);
  const sessions: ParsedSession[] = [];
  for (const file of files) {
    const parsed = await loadOne(file);
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
  const pricing = {
    input: pick(cost.input),
    output: pick(cost.output),
    cacheRead: pick(cost.cacheRead),
    cacheWrite: pick(cost.cacheWrite),
  };
  // 订阅计费的 catalog 条目四项全零：当「未定价」处理，否则 UI 会把它显示成误导性的 $0.00
  const priced = pricing.input || pricing.output || pricing.cacheRead || pricing.cacheWrite;
  return priced ? pricing : null;
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

const PRICING_TTL_MS = 10 * 60 * 1000;
let pricingCache: { table: PricingTable; loadedAt: number } | null = null;
let pricingInflight: Promise<PricingTable> | null = null;

/** catalog 单价表；失败回空表且不缓存，成功结果 10 分钟内复用（运行中新增 provider 可刷新到）。 */
function getPricingTable(): Promise<PricingTable> {
  if (pricingCache && Date.now() - pricingCache.loadedAt < PRICING_TTL_MS) {
    return Promise.resolve(pricingCache.table);
  }
  pricingInflight ??= (async () => {
    try {
      const runtime = await getRuntime();
      const table = buildPricingTable(runtime.getModels() as readonly CatalogCostModel[]);
      pricingCache = { table, loadedAt: Date.now() };
      return table;
    } catch {
      return {};
    } finally {
      pricingInflight = null;
    }
  })();
  return pricingInflight;
}

let sessionsInflight: Promise<ParsedSession[]> | null = null;

/** 连点周期 pill 只触发一次全量扫描 */
function loadSessionsOnce(): Promise<ParsedSession[]> {
  sessionsInflight ??= loadSessions(sessionDir()).finally(() => {
    sessionsInflight = null;
  });
  return sessionsInflight;
}

export async function getUsageSummary(days: UsageRangeDays): Promise<UsageSummaryResult> {
  try {
    const [sessions, pricing] = await Promise.all([loadSessionsOnce(), getPricingTable()]);
    const records: UsageRecord[] = [];
    const activity: SessionActivity[] = [];
    for (const session of sessions) {
      records.push(...session.records);
      activity.push({ sessionId: session.sessionId, spans: session.spans });
    }
    return {
      ok: true,
      summary: aggregateUsage(records, activity, pricing, { days, now: Date.now() }),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
