import { THINKING_LEVELS } from '../types/agent';
import type { UsageRecord } from './types';

/** 单价 $/M tokens，与 pi-ai `ModelCostRates` 同形 */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** key = model id */
export type PricingTable = Record<string, ModelPricing>;

const THINKING_SUFFIX = new RegExp(`-(${THINKING_LEVELS.join('|')})$`);

/**
 * 精确 id 优先；查不到时剥掉结尾的思考档位后缀再查一次。
 * 真实场景：部分账号 provider 把档位拼进 model id（grok-4.6-fast-max），catalog 只有基础 id。
 */
export function resolvePricing(model: string, table: PricingTable): ModelPricing | null {
  const exact = table[model];
  if (exact) return exact;
  const base = model.replace(THINKING_SUFFIX, '');
  return base !== model ? (table[base] ?? null) : null;
}

function pickRate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parsePricing(raw: unknown): ModelPricing | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const input = rec.input === undefined ? 0 : pickRate(rec.input);
  const output = rec.output === undefined ? 0 : pickRate(rec.output);
  const cacheRead = rec.cacheRead === undefined ? 0 : pickRate(rec.cacheRead);
  const cacheWrite = rec.cacheWrite === undefined ? 0 : pickRate(rec.cacheWrite);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;
  return { input, output, cacheRead, cacheWrite };
}

/** settings / 脏 JSON → 合法覆盖表；坏条目丢弃 */
export function parseUsageModelPricing(raw: unknown): PricingTable {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const table: PricingTable = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim();
    if (!id) continue;
    const pricing = parsePricing(value);
    if (pricing) table[id] = pricing;
  }
  return table;
}

/** 覆盖按精确 id 整组替换 catalog，不改入参 */
export function mergePricingTable(catalog: PricingTable, overrides: PricingTable): PricingTable {
  return { ...catalog, ...overrides };
}

/** 无定价返回 null（区别于免费模型的 0） */
export function costOf(
  record: Pick<UsageRecord, 'model' | 'input' | 'output' | 'cacheRead' | 'cacheWrite'>,
  table: PricingTable
): number | null {
  const p = resolvePricing(record.model, table);
  if (!p) return null;
  return (
    (record.input * p.input +
      record.output * p.output +
      record.cacheRead * p.cacheRead +
      record.cacheWrite * p.cacheWrite) /
    1_000_000
  );
}
