import { describe, expect, it } from 'vitest';
import { costOf, type PricingTable } from './pricing';

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
