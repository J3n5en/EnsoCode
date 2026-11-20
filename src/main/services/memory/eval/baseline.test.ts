import { beforeAll, describe, expect, it } from 'vitest';
import type { EvalDimension } from './cases';
import { type EvalReport, formatReport, type Metrics, runEvalWith } from './run';

// stub 实跑的真实值（见 README，51 条用例）。stub 完全确定，余量只吸收四位小数的舍入，
// 小于任何一条用例名次 / 噪声变化带来的最小波动（overall 上 MRR 9→10 名 ≈ 0.0002）：退一点就会红。
// 指标变好时请同步上调，别让基线停在旧值。
const MARGIN = 0.0001;
type Baseline = Pick<Metrics, 'recall5' | 'recall10' | 'mrr' | 'noise' | 'stale'>;
const OVERALL: Baseline = {
  recall5: 0.798,
  recall10: 0.827,
  mrr: 0.672,
  noise: 0.0488,
  stale: 0.1,
};
// semantic / crossLingual 不进断言：stub 只编码字面重合，这两维的非零值只来自字面重合的用例
// （保留原文的术语、恰好同词），不代表语义能力
const BY_DIMENSION: Partial<Record<EvalDimension, Baseline>> = {
  exact: { recall5: 1, recall10: 1, mrr: 1, noise: 0, stale: null },
  temporal: { recall5: 1, recall10: 1, mrr: 0.8056, noise: 0.05, stale: null },
  entity: { recall5: 1, recall10: 1, mrr: 1, noise: 0.04, stale: null },
  typeFilter: { recall5: 0.75, recall10: 0.8333, mrr: 0.75, noise: 0, stale: null },
  spaceIsolation: { recall5: 1, recall10: 1, mrr: 0.9, noise: 0, stale: null },
  distractor: { recall5: 1, recall10: 1, mrr: 0.7833, noise: 0.2167, stale: null },
  stale: { recall5: 0.857, recall10: 1, mrr: 0.5238, noise: null, stale: 0.1 },
};

function expectAtMost(actual: number | null, base: number | null, name: string) {
  if (base === null) expect(actual, name).toBeNull();
  else expect(actual, name).toBeLessThanOrEqual(base + MARGIN);
}

function expectAtLeast(actual: Metrics, base: Baseline) {
  expect(actual.recall5, 'recall5').toBeGreaterThanOrEqual(base.recall5 - MARGIN);
  expect(actual.recall10, 'recall10').toBeGreaterThanOrEqual(base.recall10 - MARGIN);
  expect(actual.mrr, 'mrr').toBeGreaterThanOrEqual(base.mrr - MARGIN);
  expectAtMost(actual.noise, base.noise, 'noise');
  expectAtMost(actual.stale, base.stale, 'stale');
}

describe('memory retrieval eval — stub baseline', () => {
  let report: EvalReport;
  // 52 条用例 + 85 条背景记忆，单文件跑约 9s；全量并发时机器负载高会超过默认 10s 钩子超时
  beforeAll(async () => {
    report = await runEvalWith('stub');
    if (process.env.ENSO_MEMORY_EVAL === 'stub') console.log(formatReport(report));
  }, 60_000);

  it('每个维度至少一条用例', () => {
    for (const [dim, m] of Object.entries(report.byDimension)) {
      expect(m.cases, dim).toBeGreaterThan(0);
    }
  });

  it('总体指标不低于基线', () => {
    expectAtLeast(report.overall, OVERALL);
  });

  it.each(Object.entries(BY_DIMENSION))('%s 维度不低于基线', (dim, base) => {
    expectAtLeast(report.byDimension[dim as EvalDimension], base);
  });

  it('space 隔离是硬约束：其它 space 的记忆一条都不能出现', () => {
    for (const r of report.cases.filter((c) => c.dimension === 'spaceIsolation')) {
      expect(r.excludedHits, r.id).toEqual([]);
    }
  });

  it('replaces 是硬约束：被替换的旧版本一条都不能出现', () => {
    const r = report.cases.find((c) => c.id === 'stale-replaces');
    expect(r?.staleHits).toEqual([]);
  });
});

// 手动：ENSO_MEMORY_EVAL=real pnpm vitest run src/main/services/memory/eval
describe.runIf(process.env.ENSO_MEMORY_EVAL === 'real')('memory retrieval eval — real', () => {
  it('输出报告', async () => {
    const report = await runEvalWith('real');
    console.log(formatReport(report));
    expect(report.cases.length).toBeGreaterThan(0);
  }, 600_000);
});
