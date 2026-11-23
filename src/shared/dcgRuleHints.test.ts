import { describe, expect, it } from 'vitest';
import { DCG_RULE_HINTS, explainDcgGuard } from './dcgRuleHints';

describe('dcg 规则中文解释', () => {
  it('命中对照表时给出会做什么、为什么危险和安全替代', () => {
    expect(
      explainDcgGuard({ ruleId: 'core.git:push-force-long', reason: 'Force push can destroy' })
    ).toEqual({
      what: expect.stringContaining('强制推送'),
      why: expect.any(String),
      alt: 'git push --force-with-lease',
    });
  });

  it('对照表条目没有替代时不带 alt 字段', () => {
    const hint = explainDcgGuard({ ruleId: 'core.filesystem:rm-rf-general', reason: 'rm -rf' });
    expect(hint.what).toContain('删除');
    expect(hint.why).toBeTruthy();
    expect(hint).not.toHaveProperty('alt');
  });

  it('查不到的规则回退 dcg 英文原因，不显示空', () => {
    expect(explainDcgGuard({ ruleId: 'system.disk:nwipe', reason: 'nwipe overwrites' })).toEqual({
      what: 'nwipe overwrites',
    });
  });

  it('覆盖至少 30 条规则，每条都有非空 zh / why，alt 不为空串', () => {
    const entries = Object.entries(DCG_RULE_HINTS);
    expect(entries.length).toBeGreaterThanOrEqual(30);
    for (const [ruleId, hint] of entries) {
      expect(ruleId).toMatch(/^[a-z]+\.[a-z]+:[a-z0-9-]+$/);
      expect(hint.zh.trim()).not.toBe('');
      expect(hint.why.trim()).not.toBe('');
      if ('alt' in hint) expect(hint.alt?.trim()).toBeTruthy();
    }
  });
});
