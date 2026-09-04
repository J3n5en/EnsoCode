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
