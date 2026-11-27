import type { DcgRuleExemption, DcgRuleState } from './types/dcg';

/** 本机 dcg 规则记忆：放过次数 + 按 dcg 版本绑定的豁免 */
export interface DcgRuleMemory {
  allowCounts: Record<string, number>;
  exemptions: Record<string, { dcgVersion: string; at: number }>;
}

export const DCG_EXEMPT_SUGGEST_AFTER = 5;

/** 高危毁灭性/凭据/远程脚本执行规则永不允许记忆豁免 */
export const NON_EXEMPTIBLE_DCG_RULES: ReadonlySet<string> = new Set([
  'core.filesystem:rm-rf-root-home',
  'core.filesystem:rm-r-f-separate-root-home',
  'core.filesystem:rm-recursive-force-root-home',
  'core.filesystem:find-delete-root-home',
  'core.filesystem:credential-file-write',
  'core.filesystem:fork-bomb',
  // 0.17.2 复核：摧毁备份还原点、格式化/清空磁盘、整域进程杀伤不允许记忆豁免
  'core.filesystem:cp-sensitive-then-delete',
  'core.filesystem:ln-symlink-sensitive-then-delete',
  'core.filesystem:rsync-sensitive-then-delete',
  'core.filesystem:rsync-delete-sensitive-dest',
  'core.filesystem:format-volume',
  'core.filesystem:clear-disk',
  'core.filesystem:vssadmin-delete-shadows',
  'core.filesystem:wmic-shadowcopy-delete',
  'core.filesystem:wmi-shadowcopy-delete',
  'heredoc.posix:pipeline-consumer',
  'system.disk:dd-device',
  'system.disk:mkfs',
  'system.disk:diskutil-erase',
  'system.processes:kill-every-process',
  'system.processes:launchctl-bootout-domain',
  'system.processes:interpreter-signals-everything',
]);

const RULE_ID = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;

export const isDcgRuleId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 128 && RULE_ID.test(value);

export const isDcgRuleExemptible = (ruleId: string): boolean =>
  isDcgRuleId(ruleId) && !ruleId.startsWith('enso.') && !NON_EXEMPTIBLE_DCG_RULES.has(ruleId);

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
        isDcgRuleExemptible(ruleId) &&
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
): DcgRuleMemory => {
  if (!isDcgRuleExemptible(ruleId)) return memory;
  if ((memory.allowCounts[ruleId] ?? 0) < DCG_EXEMPT_SUGGEST_AFTER) return memory;
  return {
    ...memory,
    exemptions: { ...memory.exemptions, [ruleId]: { dcgVersion, at } },
  };
};

/** 撤销单条规则豁免，并清零该规则放过计数，避免下次审批立刻再弹提示 */
export function removeDcgExemption(memory: DcgRuleMemory, ruleId: string): DcgRuleMemory {
  const { [ruleId]: _removedExemption, ...exemptions } = memory.exemptions;
  const { [ruleId]: _removedCount, ...allowCounts } = memory.allowCounts;
  return { allowCounts, exemptions };
}

/** 豁免只对记录时的 dcg 版本有效；版本一变全部失效、重新询问 */
export const activeDcgExemptions = (memory: DcgRuleMemory, dcgVersion: string): string[] =>
  Object.entries(memory.exemptions)
    .filter(([ruleId, entry]) => isDcgRuleExemptible(ruleId) && entry.dcgVersion === dcgVersion)
    .map(([ruleId]) => ruleId);

export const listActiveDcgExemptions = (
  memory: DcgRuleMemory,
  dcgVersion: string
): DcgRuleExemption[] =>
  Object.entries(memory.exemptions)
    .filter(([ruleId, entry]) => isDcgRuleExemptible(ruleId) && entry.dcgVersion === dcgVersion)
    .map(([ruleId, entry]) => ({ ruleId, dcgVersion: entry.dcgVersion, at: entry.at }))
    .sort((a, b) => b.at - a.at || a.ruleId.localeCompare(b.ruleId));

export function dcgRuleState(
  memory: DcgRuleMemory,
  ruleId: string,
  dcgVersion: string
): DcgRuleState {
  const allowCount = memory.allowCounts[ruleId] ?? 0;
  if (!isDcgRuleExemptible(ruleId)) {
    return { allowCount, exempt: false, suggestExempt: false };
  }
  const exempt = memory.exemptions[ruleId]?.dcgVersion === dcgVersion;
  return { allowCount, exempt, suggestExempt: !exempt && allowCount >= DCG_EXEMPT_SUGGEST_AFTER };
}
