import { describe, expect, it } from 'vitest';
import { costOf, mergePricingTable, type PricingTable, parseUsageModelPricing } from './pricing';

describe('costOf', () => {
  it('未知模型返回 null', () => {
    const table: PricingTable = {
      'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    };
    expect(
      costOf(
        { model: 'unknown-model', input: 100, output: 100, cacheRead: 0, cacheWrite: 0 },
        table
      )
    ).toBeNull();
  });

  it('按四项单价与百万分之一 tokens 求和', () => {
    const table: PricingTable = {
      'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    };
    const cost = costOf(
      {
        model: 'claude-opus-5',
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
      },
      table
    );
    expect(cost).toBeCloseTo(15 + 75 + 1.5 + 18.75);
  });

  it('单价全为 0 时返回 0 而非 null', () => {
    const table: PricingTable = {
      'free-model': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    expect(
      costOf({ model: 'free-model', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }, table)
    ).toBe(0);
  });

  it('空定价表对任何模型都返回 null', () => {
    expect(
      costOf({ model: 'anything', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, {})
    ).toBeNull();
  });
});

describe('costOf — 思考档位后缀兜底', () => {
  const table: PricingTable = {
    'grok-4.6-fast': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    'claude-fable-5-max': { input: 10, output: 10, cacheRead: 10, cacheWrite: 10 },
    'claude-fable-5': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  };
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };

  // 真实场景：Antigravity / xAI 账号把思考档位拼进 model id（grok-4.6-fast-max），catalog 里只有基础 id
  it('精确 id 缺失时，剥掉结尾的思考档位后缀再查', () => {
    expect(costOf({ model: 'grok-4.6-fast-max', ...tokens }, table)).toBe(1);
    expect(costOf({ model: 'grok-4.6-fast-medium', ...tokens }, table)).toBe(1);
  });

  it('精确 id 存在时优先精确匹配，不剥后缀', () => {
    expect(costOf({ model: 'claude-fable-5-max', ...tokens }, table)).toBe(10);
  });

  it('剥掉后缀仍查不到则返回 null', () => {
    expect(costOf({ model: 'gemini-3.8-flash-high', ...tokens }, table)).toBeNull();
  });

  it('后缀不是思考档位的不剥', () => {
    expect(costOf({ model: 'grok-4.6-fast-turbo', ...tokens }, table)).toBeNull();
  });
});

describe('parseUsageModelPricing', () => {
  const ok = { input: 0.4, output: 3, cacheRead: 0.05, cacheWrite: 0 };

  it('空或缺对象返回空表', () => {
    expect(parseUsageModelPricing(undefined)).toEqual({});
    expect(parseUsageModelPricing(null)).toEqual({});
    expect(parseUsageModelPricing([])).toEqual({});
  });

  it('合法条目按 trim 后的精确 id 保留', () => {
    expect(parseUsageModelPricing({ ' qwen-3.8-27b ': ok })).toEqual({ 'qwen-3.8-27b': ok });
  });

  it('空 id、负值、非有限数字丢弃该条', () => {
    expect(
      parseUsageModelPricing({
        '': ok,
        '  ': ok,
        bad: { ...ok, input: -1 },
        nan: { ...ok, output: Number.NaN },
        inf: { ...ok, cacheRead: Number.POSITIVE_INFINITY },
        keep: ok,
      })
    ).toEqual({ keep: ok });
  });

  it('缺项按 0，四项全零仍保留（用户定价 $0）', () => {
    expect(parseUsageModelPricing({ free: { input: 0 } })).toEqual({
      free: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });
});

describe('mergePricingTable', () => {
  const catalog: PricingTable = {
    'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  };

  it('覆盖精确 id，catalog 其余不动', () => {
    expect(
      mergePricingTable(catalog, {
        'claude-opus-5': { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      })
    ).toEqual({
      'claude-opus-5': { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    });
  });

  it('未定价 id 可补进表，含全零覆盖', () => {
    expect(
      mergePricingTable(catalog, {
        'qwen-3.8-27b': { input: 0.4, output: 3, cacheRead: 0.05, cacheWrite: 0 },
        'gemini-3.8-flash-tiered': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })
    ).toEqual({
      'claude-opus-5': catalog['claude-opus-5'],
      'qwen-3.8-27b': { input: 0.4, output: 3, cacheRead: 0.05, cacheWrite: 0 },
      'gemini-3.8-flash-tiered': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('不改入参 catalog', () => {
    const before = { ...catalog };
    mergePricingTable(catalog, { extra: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } });
    expect(catalog).toEqual(before);
  });
});
