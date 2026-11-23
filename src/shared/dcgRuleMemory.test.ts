import { describe, expect, it } from 'vitest';
import {
  activeDcgExemptions,
  addDcgExemption,
  dcgRuleState,
  emptyDcgRuleMemory,
  isDcgRuleExemptible,
  isDcgRuleId,
  listActiveDcgExemptions,
  NON_EXEMPTIBLE_DCG_RULES,
  parseDcgRuleMemory,
  recordDcgRuleAllow,
  removeDcgExemption,
} from './dcgRuleMemory';

const RULE = 'core.git:reset-hard';
const allowTimes = (n: number) => {
  let memory = emptyDcgRuleMemory();
  for (let i = 0; i < n; i += 1) memory = recordDcgRuleAllow(memory, RULE);
  return memory;
};

describe('dcg 规则放过计数与记忆豁免', () => {
  it('按 rule_id 计数，互不影响', () => {
    const memory = recordDcgRuleAllow(allowTimes(2), 'core.git:clean-force');
    expect(dcgRuleState(memory, RULE, '0.16.0').allowCount).toBe(2);
    expect(dcgRuleState(memory, 'core.git:clean-force', '0.16.0').allowCount).toBe(1);
  });

  it('放过满 5 次才提示豁免，已豁免后不再提示', () => {
    expect(dcgRuleState(allowTimes(4), RULE, '0.16.0').suggestExempt).toBe(false);
    const five = allowTimes(5);
    expect(dcgRuleState(five, RULE, '0.16.0')).toEqual({
      allowCount: 5,
      exempt: false,
      suggestExempt: true,
    });
    const exempted = addDcgExemption(five, RULE, '0.16.0', 1);
    expect(dcgRuleState(exempted, RULE, '0.16.0')).toMatchObject({
      exempt: true,
      suggestExempt: false,
    });
    expect(activeDcgExemptions(exempted, '0.16.0')).toEqual([RULE]);
  });

  it('dcg 版本变化后豁免全部失效，重新提示', () => {
    const exempted = addDcgExemption(allowTimes(5), RULE, '0.16.0', 1);
    expect(activeDcgExemptions(exempted, '0.17.0')).toEqual([]);
    expect(dcgRuleState(exempted, RULE, '0.17.0')).toMatchObject({
      exempt: false,
      suggestExempt: true,
    });
    const renewed = addDcgExemption(exempted, RULE, '0.17.0', 2);
    expect(activeDcgExemptions(renewed, '0.17.0')).toEqual([RULE]);
  });

  it('脏数据按空表处理，坏条目逐条丢弃', () => {
    expect(parseDcgRuleMemory('x')).toEqual(emptyDcgRuleMemory());
    expect(parseDcgRuleMemory(null)).toEqual(emptyDcgRuleMemory());
    expect(
      parseDcgRuleMemory({
        allowCounts: { [RULE]: 3, bad: 2, 'core.git:x': -1, 'core.git:y': 'n' },
        exemptions: { [RULE]: { dcgVersion: '0.16.0', at: 1 }, 'core.git:z': { at: 1 } },
      })
    ).toEqual({
      allowCounts: { [RULE]: 3 },
      exemptions: { [RULE]: { dcgVersion: '0.16.0', at: 1 } },
    });
  });

  it('rule_id 只接受 pack:pattern 形态', () => {
    expect(isDcgRuleId('core.git:reset-hard')).toBe(true);
    expect(isDcgRuleId('system.disk:sg_format')).toBe(true);
    for (const bad of ['', 'reset-hard', '../x:y', 'a:b c', 1, null, `a:${'x'.repeat(200)}`])
      expect(isDcgRuleId(bad)).toBe(false);
  });

  it('高危底线规则永不可豁免：不提示、拒绝写入、解析丢弃', () => {
    for (const critical of [
      'core.filesystem:rm-rf-root-home',
      'core.filesystem:fork-bomb',
      'core.filesystem:credential-file-write',
      'heredoc.posix:pipeline-consumer',
      'system.disk:dd-device',
      'system.disk:mkfs',
      'system.disk:diskutil-erase',
    ]) {
      expect(NON_EXEMPTIBLE_DCG_RULES.has(critical)).toBe(true);
      expect(isDcgRuleExemptible(critical)).toBe(false);
      let memory = emptyDcgRuleMemory();
      for (let i = 0; i < 6; i += 1) memory = recordDcgRuleAllow(memory, critical);
      expect(dcgRuleState(memory, critical, '0.16.0')).toMatchObject({
        exempt: false,
        suggestExempt: false,
      });
      const after = addDcgExemption(memory, critical, '0.16.0', 1);
      expect(activeDcgExemptions(after, '0.16.0')).toEqual([]);
      const forged = parseDcgRuleMemory({
        allowCounts: { [critical]: 10 },
        exemptions: { [critical]: { dcgVersion: '0.16.0', at: 1 } },
      });
      expect(activeDcgExemptions(forged, '0.16.0')).toEqual([]);
    }
  });

  it('未满 5 次放行不能直接写入豁免', () => {
    const four = allowTimes(4);
    const after = addDcgExemption(four, RULE, '0.16.0', 1);
    expect(activeDcgExemptions(after, '0.16.0')).toEqual([]);
  });

  it('支持列出当前生效豁免并单条撤销（同时清零该规则计数）', () => {
    let memory = allowTimes(5);
    for (let i = 0; i < 5; i += 1) memory = recordDcgRuleAllow(memory, 'core.git:clean-force');
    memory = addDcgExemption(memory, RULE, '0.16.0', 100);
    memory = addDcgExemption(memory, 'core.git:clean-force', '0.16.0', 200);
    expect(listActiveDcgExemptions(memory, '0.16.0')).toEqual([
      { ruleId: 'core.git:clean-force', dcgVersion: '0.16.0', at: 200 },
      { ruleId: RULE, dcgVersion: '0.16.0', at: 100 },
    ]);
    const revoked = removeDcgExemption(memory, RULE);
    expect(listActiveDcgExemptions(revoked, '0.16.0')).toEqual([
      { ruleId: 'core.git:clean-force', dcgVersion: '0.16.0', at: 200 },
    ]);
    expect(dcgRuleState(revoked, RULE, '0.16.0')).toEqual({
      allowCount: 0,
      exempt: false,
      suggestExempt: false,
    });
  });
});
