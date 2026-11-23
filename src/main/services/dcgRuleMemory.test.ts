import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeDcgExemptRules,
  clearDcgRuleMemory,
  dcgRuleMemoryFile,
  exemptDcgRule,
  readDcgRuleState,
  recordDcgAllow,
} from './dcgRuleMemory';

const roots: string[] = [];
const tempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enso-dcg-rules-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const RULE = 'core.git:reset-hard';

describe('dcg 规则记忆持久化', () => {
  it('放过计数落盘，满 5 次提示，豁免绑定版本，清除后归零', async () => {
    const root = tempRoot();
    for (let i = 0; i < 4; i += 1) recordDcgAllow(root, RULE, '0.16.0');
    expect(recordDcgAllow(root, RULE, '0.16.0')).toEqual({
      allowCount: 5,
      exempt: false,
      suggestExempt: true,
    });
    expect(exemptDcgRule(root, RULE, '0.16.0').exempt).toBe(true);
    expect(activeDcgExemptRules(root, '0.16.0')).toEqual([RULE]);
    expect(activeDcgExemptRules(root, '0.17.0')).toEqual([]);
    await clearDcgRuleMemory(root);
    expect(fs.existsSync(dcgRuleMemoryFile(root))).toBe(false);
    expect(readDcgRuleState(root, RULE, '0.16.0')).toEqual({
      allowCount: 0,
      exempt: false,
      suggestExempt: false,
    });
  });

  it('文件损坏时按空表继续，不抛错', () => {
    const root = tempRoot();
    fs.writeFileSync(dcgRuleMemoryFile(root), '{oops');
    expect(readDcgRuleState(root, RULE, '0.16.0').allowCount).toBe(0);
    expect(recordDcgAllow(root, RULE, '0.16.0').allowCount).toBe(1);
  });
});
