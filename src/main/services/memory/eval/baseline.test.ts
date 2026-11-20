import { beforeAll, describe, expect, it } from 'vitest';
import type { EvalDimension } from './cases';
import { type EvalReport, formatReport, type Metrics, runEvalWith } from './run';

// stub 首次实跑的真实值（见 README）。stub 完全确定，余量只吸收四位小数的舍入，
// 小于任何一条用例名次 / 噪声变化带来的最小波动（如 MRR 4→5 名 ≈ 0.003）：退一点就会红。
// 指标变好时请同步上调，别让基线停在旧值。
const MARGIN = 0.001;
type Baseline = Pick<Metrics, 'recall5' | 'recall10' | 'mrr' | 'noise'>;
const OVERALL: Baseline = { recall5: 0.6875, recall10: 0.6875, mrr: 0.625, noise: 0.0286 };
// semantic / crossLingual 不进断言：stub 只编码字面重合，这两维在 stub 下恒为 0，断言 ≥0 没有意义
const BY_DIMENSION: Partial<Record<EvalDimension, Baseline>> = {
  exact: { recall5: 1, recall10: 1, mrr: 1, noise: null },
  temporal: { recall5: 1, recall10: 1, mrr: 1, noise: 0.05 },
  entity: { recall5: 1, recall10: 1, mrr: 1, noise: 0 },
  typeFilter: { recall5: 0.5, recall10: 0.5, mrr: 0.25, noise: 0 },
  spaceIsolation: { recall5: 1, recall10: 1, mrr: 1, noise: 0 },
  distractor: { recall5: 1, recall10: 1, mrr: 0.75, noise: 0.1 },
};

function expectAtLeast(actual: Metrics, base: Baseline) {
  expect(actual.recall5).toBeGreaterThanOrEqual(base.recall5 - MARGIN);
  expect(actual.recall10).toBeGreaterThanOrEqual(base.recall10 - MARGIN);
  expect(actual.mrr).toBeGreaterThanOrEqual(base.mrr - MARGIN);
  if (base.noise === null) expect(actual.noise).toBeNull();
  else expect(actual.noise).toBeLessThanOrEqual(base.noise + MARGIN);
}

describe('memory retrieval eval — stub baseline', () => {
  let report: EvalReport;
  beforeAll(async () => {
    report = await runEvalWith('stub');
    if (process.env.ENSO_MEMORY_EVAL === 'stub') console.log(formatReport(report));
  });

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
});

// 手动：ENSO_MEMORY_EVAL=real pnpm vitest run src/main/services/memory/eval
describe.runIf(process.env.ENSO_MEMORY_EVAL === 'real')('memory retrieval eval — real', () => {
  it('输出报告', async () => {
    const report = await runEvalWith('real');
    console.log(formatReport(report));
    expect(report.cases.length).toBeGreaterThan(0);
  }, 600_000);
});
