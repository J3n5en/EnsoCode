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

/** 无定价返回 null（区别于免费模型的 0） */
export function costOf(
  record: Pick<UsageRecord, 'model' | 'input' | 'output' | 'cacheRead' | 'cacheWrite'>,
  table: PricingTable
): number | null {
  const p = table[record.model];
  if (!p) return null;
  return (
    (record.input * p.input +
      record.output * p.output +
      record.cacheRead * p.cacheRead +
      record.cacheWrite * p.cacheWrite) /
    1_000_000
  );
}
