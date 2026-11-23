import fs from 'node:fs';
import path from 'node:path';
import {
  activeDcgExemptions,
  addDcgExemption,
  type DcgRuleMemory,
  dcgRuleState,
  parseDcgRuleMemory,
  recordDcgRuleAllow,
} from '@shared/dcgRuleMemory';
import type { DcgRuleState } from '@shared/types/dcg';
import { readJson, writeJsonAtomic } from './bots/files';

// 放在 dcg/ 之外：安装 / 卸载 dcg 会清空 dcg/ 目录
export const dcgRuleMemoryFile = (root: string): string => path.join(root, 'dcg-rules.json');

const read = (root: string): DcgRuleMemory => parseDcgRuleMemory(readJson(dcgRuleMemoryFile(root)));

function update(root: string, change: (memory: DcgRuleMemory) => DcgRuleMemory): DcgRuleMemory {
  const next = change(read(root));
  writeJsonAtomic(dcgRuleMemoryFile(root), next);
  return next;
}

export const readDcgRuleState = (root: string, ruleId: string, version: string): DcgRuleState =>
  dcgRuleState(read(root), ruleId, version);

export const recordDcgAllow = (root: string, ruleId: string, version: string): DcgRuleState =>
  dcgRuleState(
    update(root, (memory) => recordDcgRuleAllow(memory, ruleId)),
    ruleId,
    version
  );

export const exemptDcgRule = (root: string, ruleId: string, version: string): DcgRuleState =>
  dcgRuleState(
    update(root, (memory) => addDcgExemption(memory, ruleId, version, Date.now())),
    ruleId,
    version
  );

export const activeDcgExemptRules = (root: string, version: string): string[] =>
  activeDcgExemptions(read(root), version);

/** 清除豁免与放过计数 */
export async function clearDcgRuleMemory(root: string): Promise<void> {
  await fs.promises.rm(dcgRuleMemoryFile(root), { force: true });
}
