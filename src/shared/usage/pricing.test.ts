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

describe('costOf — 中转命名空间前缀', () => {
  const tokens = {
    input: 1_000_000,
    output: 2_000_000,
    cacheRead: 3_000_000,
    cacheWrite: 4_000_000,
  };
  const gptRates = { input: 2, output: 5, cacheRead: 1, cacheWrite: 3 };
  const deepseekRates = { input: 1, output: 4, cacheRead: 0.5, cacheWrite: 2 };

  it('完整 ID 精确命中时保留全零单价', () => {
    const table: PricingTable = {
      'relay/gpt-6.1-sol-high': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      'relay/gpt-6.1-sol': gptRates,
      'gpt-6.1-sol': deepseekRates,
    };
    expect(costOf({ model: 'relay/gpt-6.1-sol-high', ...tokens }, table)).toBe(0);
  });

  it.each(['constructor', '__proto__', 'toString', 'constructor-high'])(
    '命名空间回退不把继承属性 %s 当作价格',
    (model) => {
      expect(costOf({ model: `relay/${model}`, ...tokens }, {})).toBeNull();
    }
  );

  it('忽略继承的价格条目，但保留同名自有条目的优先级', () => {
    const table: PricingTable = { 'gpt-6.1-sol': gptRates };
    Object.setPrototypeOf(table, { 'relay/gpt-6.1-sol': deepseekRates });
    expect(costOf({ model: 'relay/gpt-6.1-sol', ...tokens }, table)).toBeCloseTo(27);
    table['relay/gpt-6.1-sol'] = deepseekRates;
    expect(costOf({ model: 'relay/gpt-6.1-sol', ...tokens }, table)).toBeCloseTo(18.5);
  });

  it('codex/gpt-6.1-sol 回落到去前缀后的模型 ID', () => {
    expect(
      costOf({ model: 'codex/gpt-6.1-sol', ...tokens }, { 'gpt-6.1-sol': gptRates })
    ).toBeCloseTo(27);
  });

  it('workbuddy-ai/deepseek-v4.1-flash 回落到去前缀后的模型 ID', () => {
    expect(
      costOf(
        { model: 'workbuddy-ai/deepseek-v4.1-flash', ...tokens },
        {
          'deepseek-v4.1-flash': deepseekRates,
        }
      )
    ).toBeCloseTo(18.5);
  });

  it('剥思考档位时优先匹配带命名空间的基础 ID', () => {
    const table: PricingTable = {
      'relay/gpt-6.1-sol': gptRates,
      'gpt-6.1-sol-high': deepseekRates,
    };
    expect(costOf({ model: 'relay/gpt-6.1-sol-high', ...tokens }, table)).toBeCloseTo(27);
  });

  it('逐段剥除多层命名空间后匹配模型 ID', () => {
    expect(
      costOf({ model: 'relay/openai/gpt-6.1-sol', ...tokens }, { 'gpt-6.1-sol': gptRates })
    ).toBeCloseTo(27);
    expect(
      costOf({ model: 'relay/openai/gpt-6.1-sol-high', ...tokens }, { 'gpt-6.1-sol': gptRates })
    ).toBeCloseTo(27);
  });

  it('模型 ID 自带斜杠时优先保留更长的剩余路径', () => {
    const table: PricingTable = {
      'meta-llama/model': gptRates,
      model: deepseekRates,
    };
    expect(costOf({ model: 'relay/meta-llama/model', ...tokens }, table)).toBeCloseTo(27);
  });

  it('前缀回落不改写点号或连字符，也不剥未识别后缀', () => {
    expect(
      costOf({ model: 'codex/gpt-6.1-sol', ...tokens }, { 'gpt-6-1-sol': deepseekRates })
    ).toBeNull();
    expect(
      costOf({ model: 'codex/gpt-6.1-sol-turbo', ...tokens }, { 'gpt-6.1-sol': gptRates })
    ).toBeNull();
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
