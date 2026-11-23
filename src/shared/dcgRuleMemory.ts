import type { DcgRuleState } from './types/dcg';

/** 本机 dcg 规则记忆：放过次数 + 按 dcg 版本绑定的豁免 */
export interface DcgRuleMemory {
  allowCounts: Record<string, number>;
  exemptions: Record<string, { dcgVersion: string; at: number }>;
}

export const DCG_EXEMPT_SUGGEST_AFTER = 5;

const RULE_ID = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;

export const isDcgRuleId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 128 && RULE_ID.test(value);

export const emptyDcgRuleMemory = (): DcgRuleMemory => ({ allowCounts: {}, exemptions: {} });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseDcgRuleMemory(raw: unknown): DcgRuleMemory {
  const memory = emptyDcgRuleMemory();
  if (!isRecord(raw)) return memory;
  if (isRecord(raw.allowCounts)) {
    for (const [ruleId, count] of Object.entries(raw.allowCounts)) {
      if (isDcgRuleId(ruleId) && Number.isSafeInteger(count) && (count as number) > 0)
        memory.allowCounts[ruleId] = count as number;
    }
  }
  if (isRecord(raw.exemptions)) {
    for (const [ruleId, entry] of Object.entries(raw.exemptions)) {
      if (
        isDcgRuleId(ruleId) &&
        isRecord(entry) &&
        typeof entry.dcgVersion === 'string' &&
        entry.dcgVersion &&
        typeof entry.at === 'number'
      )
        memory.exemptions[ruleId] = { dcgVersion: entry.dcgVersion, at: entry.at };
    }
  }
  return memory;
}

export const recordDcgRuleAllow = (memory: DcgRuleMemory, ruleId: string): DcgRuleMemory => ({
  ...memory,
  allowCounts: { ...memory.allowCounts, [ruleId]: (memory.allowCounts[ruleId] ?? 0) + 1 },
});

export const addDcgExemption = (
  memory: DcgRuleMemory,
  ruleId: string,
  dcgVersion: string,
  at: number
): DcgRuleMemory => ({
  ...memory,
  exemptions: { ...memory.exemptions, [ruleId]: { dcgVersion, at } },
});

/** 豁免只对记录时的 dcg 版本有效；版本一变全部失效、重新询问 */
export const activeDcgExemptions = (memory: DcgRuleMemory, dcgVersion: string): string[] =>
  Object.entries(memory.exemptions)
    .filter(([, entry]) => entry.dcgVersion === dcgVersion)
    .map(([ruleId]) => ruleId);

export function dcgRuleState(
  memory: DcgRuleMemory,
  ruleId: string,
  dcgVersion: string
): DcgRuleState {
  const allowCount = memory.allowCounts[ruleId] ?? 0;
  const exempt = memory.exemptions[ruleId]?.dcgVersion === dcgVersion;
  return { allowCount, exempt, suggestExempt: !exempt && allowCount >= DCG_EXEMPT_SUGGEST_AFTER };
}
