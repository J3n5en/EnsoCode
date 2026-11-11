import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PricingTable } from '@shared/usage/pricing';
import { costOf } from '@shared/usage/pricing';

export interface UsageCall {
  timestamp: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

export function priceUsage(
  model: string,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
  table: PricingTable
): number | null {
  return costOf(
    {
      model,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    },
    table
  );
}

export function usageCallRecord(call: UsageCall): Record<string, unknown> {
  return { type: 'call', ...call };
}

export function usageSummaryRecord(
  calls: readonly UsageCall[],
  timestamp: string
): Record<string, unknown> {
  let cost: number | null = null;
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const call of calls) {
    totals.inputTokens += call.inputTokens;
    totals.outputTokens += call.outputTokens;
    totals.cacheReadTokens += call.cacheReadTokens;
    totals.cacheWriteTokens += call.cacheWriteTokens;
    if (call.costUsd !== null) cost = (cost ?? 0) + call.costUsd;
  }
  return { type: 'summary', timestamp, ...totals, costUsd: cost, calls: calls.length };
}

/** 每个模型调用立刻落一行，进程被杀掉也能留下已完成的调用。 */
export class UsageLogWriter {
  private readonly file: string | undefined;

  constructor(file: string | undefined) {
    this.file = file;
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
  }

  write(record: Record<string, unknown>): void {
    if (!this.file) return;
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }
}
