import { describe, expect, it } from 'vitest';
import { aggregateUsage, type SessionActivity } from './aggregate';
import type { PricingTable } from './pricing';
import type { UsageRecord } from './types';

// 固定 now：本地时间 2026-09-03 15:00，today 的本地零点是 2026-09-03 00:00
const NOW = new Date(2026, 8, 3, 15, 0, 0, 0).getTime();
const TODAY_START = new Date(2026, 8, 3, 0, 0, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

function dayStart(daysAgo: number): number {
  return TODAY_START - daysAgo * DAY_MS;
}

function record(overrides: Partial<UsageRecord> & { ts: number }): UsageRecord {
  return {
    id: `r-${overrides.ts}`,
    model: 'claude-opus-5',
    provider: 'enso-anthropic',
    project: 'demo',
    sessionId: 's1',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    ...overrides,
  };
}

const PRICING: PricingTable = {
  'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
};

describe('aggregateUsage — 区间边界', () => {
  it('days=1 表示今天：今天零点及之后、明天零点之前的记录计入', () => {
    const records = [
      record({ ts: dayStart(0), model: 'claude-opus-5', input: 1_000_000 }), // 恰好今天零点，含
      record({ ts: dayStart(0) + DAY_MS - 1, model: 'claude-opus-5', input: 1_000_000 }), // 今天最后一毫秒，含
      record({ ts: dayStart(0) - 1, model: 'claude-opus-5', input: 1_000_000 }), // 昨天最后一毫秒，不含
      record({ ts: dayStart(0) + DAY_MS, model: 'claude-opus-5', input: 1_000_000 }), // 明天零点，不含
    ];
    const summary = aggregateUsage(records, [], PRICING, { days: 1, now: NOW });
    expect(summary.totals.messages).toBe(2);
  });

  it('days=7 覆盖今天在内的最近 7 天', () => {
    const records = [
      record({ ts: dayStart(6), input: 1 }), // 区间起点，含
      record({ ts: dayStart(7) - 1, input: 1 }), // 区间起点前一毫秒，不含
      record({ ts: dayStart(0), input: 1 }), // 今天，含
    ];
    const summary = aggregateUsage(records, [], PRICING, { days: 7, now: NOW });
    expect(summary.totals.messages).toBe(2);
    expect(summary.rangeStart).toBe(dayStart(6));
    expect(summary.rangeEnd).toBe(dayStart(0) + DAY_MS);
  });
});

describe('aggregateUsage — 上一周期', () => {
  it('previous 是紧邻当前周期之前的等长区间', () => {
    const records = [
      record({ ts: dayStart(0), input: 1_000_000 }), // 当前周期
      record({ ts: dayStart(0) - 1000, input: 2_000_000 }), // 上一周期（days=1 时上一周期是昨天 23:59:59）
      record({ ts: dayStart(1) - 1, input: 4_000_000 }), // 上一周期起点前一毫秒，不含
    ];
    const summary = aggregateUsage(records, [], PRICING, { days: 1, now: NOW });
    expect(summary.totals.tokens).toBe(1_000_000);
    expect(summary.previous.tokens).toBe(2_000_000);
  });

  it('上一周期没有数据时 totals 归零、cost 为 null', () => {
    const summary = aggregateUsage([record({ ts: dayStart(0), input: 1 })], [], PRICING, {
      days: 1,
      now: NOW,
    });
    expect(summary.previous.tokens).toBe(0);
    expect(summary.previous.cost).toBeNull();
  });
});

describe('aggregateUsage — daily', () => {
  it('恰好 days 个点，按日期升序，无数据日补零', () => {
    const records = [record({ ts: dayStart(0), input: 100 })]; // 只有今天有数据
    const summary = aggregateUsage(records, [], PRICING, { days: 7, now: NOW });
    expect(summary.daily).toHaveLength(7);
    const days = summary.daily.map((point) => point.day);
    expect(days).toEqual([...days].sort());
    const emptyDays = summary.daily.slice(0, 6);
    for (const point of emptyDays) {
      expect(point.input).toBe(0);
      expect(point.output).toBe(0);
      expect(point.cache).toBe(0);
      expect(point.cost).toBeNull();
    }
    const lastPoint = summary.daily[summary.daily.length - 1];
    expect(lastPoint.input).toBe(100);
  });

  it('day 字段格式为本地 YYYY-MM-DD', () => {
    const summary = aggregateUsage([], [], PRICING, { days: 1, now: NOW });
    expect(summary.daily[0].day).toBe('2026-09-03');
  });
});

describe('aggregateUsage — heatmap', () => {
  it('形状固定为 7×24', () => {
    const summary = aggregateUsage([], [], PRICING, { days: 1, now: NOW });
    expect(summary.heatmap).toHaveLength(7);
    for (const row of summary.heatmap) {
      expect(row).toHaveLength(24);
    }
  });

  it('按记录本地时间的星期与小时落桶，值为 tokens', () => {
    const ts = dayStart(0) + 10 * 60 * 60 * 1000 + 30 * 60 * 1000; // 今天 10:30
    const weekday = new Date(ts).getDay();
    const summary = aggregateUsage([record({ ts, input: 500 })], [], PRICING, {
      days: 1,
      now: NOW,
    });
    expect(summary.heatmap[weekday][10]).toBe(500);
  });
});

describe('aggregateUsage — byModel', () => {
  it('按 tokens 降序排列，share 为占比', () => {
    const records = [
      record({ ts: dayStart(0), model: 'model-a', input: 1000 }),
      record({ ts: dayStart(0), model: 'model-b', input: 3000 }),
    ];
    const summary = aggregateUsage(records, [], {}, { days: 1, now: NOW });
    expect(summary.byModel.map((row) => row.model)).toEqual(['model-b', 'model-a']);
    expect(summary.byModel[0].share).toBeCloseTo(0.75);
    expect(summary.byModel[1].share).toBeCloseTo(0.25);
  });

  it('totals.tokens 为 0 时 share 为 0', () => {
    const summary = aggregateUsage([], [], {}, { days: 1, now: NOW });
    expect(summary.byModel).toHaveLength(0);
  });
});

describe('aggregateUsage — byProject', () => {
  it('按 tokens 降序排列', () => {
    const records = [
      record({ ts: dayStart(0), project: 'proj-a', input: 100 }),
      record({ ts: dayStart(0), project: 'proj-b', input: 900 }),
    ];
    const summary = aggregateUsage(records, [], {}, { days: 1, now: NOW });
    expect(summary.byProject.map((row) => row.project)).toEqual(['proj-b', 'proj-a']);
  });
});

describe('aggregateUsage — sessions', () => {
  it('sessions 为周期内出现过的 distinct sessionId 数', () => {
    const records = [
      record({ ts: dayStart(0), sessionId: 's1' }),
      record({ ts: dayStart(0), sessionId: 's1' }),
      record({ ts: dayStart(0), sessionId: 's2' }),
    ];
    const summary = aggregateUsage(records, [], {}, { days: 1, now: NOW });
    expect(summary.totals.sessions).toBe(2);
  });
});

// days=1: rangeStart=dayStart(0), rangeEnd=dayStart(0)+DAY_MS；previous=[dayStart(1), dayStart(0))
describe('aggregateUsage — activeMs（span 裁剪求和，与是否有记录无关）', () => {
  it('span 完全落在周期内时整段计入', () => {
    const activity: SessionActivity[] = [
      { sessionId: 's1', spans: [{ start: dayStart(0) + 1_000, end: dayStart(0) + 61_000 }] },
    ];
    const summary = aggregateUsage([], activity, {}, { days: 1, now: NOW });
    expect(summary.totals.activeMs).toBe(60_000);
  });

  it('span 跨越 rangeStart 时只计入落在周期内的部分', () => {
    const activity: SessionActivity[] = [
      { sessionId: 's1', spans: [{ start: dayStart(0) - 30_000, end: dayStart(0) + 30_000 }] },
    ];
    const summary = aggregateUsage([], activity, {}, { days: 1, now: NOW });
    expect(summary.totals.activeMs).toBe(30_000);
  });

  it('span 完全落在上一周期时计入 previous.activeMs 而非 totals.activeMs', () => {
    const activity: SessionActivity[] = [
      { sessionId: 's1', spans: [{ start: dayStart(1) + 1_000, end: dayStart(1) + 21_000 }] },
    ];
    const summary = aggregateUsage([], activity, {}, { days: 1, now: NOW });
    expect(summary.totals.activeMs).toBe(0);
    expect(summary.previous.activeMs).toBe(20_000);
  });

  it('同一 sessionId 重复出现的 activity 条目去重，先到的一条为准', () => {
    const activity: SessionActivity[] = [
      { sessionId: 's1', spans: [{ start: dayStart(0) + 1_000, end: dayStart(0) + 11_000 }] },
      { sessionId: 's1', spans: [{ start: dayStart(0) + 50_000, end: dayStart(0) + 150_000 }] },
    ];
    const summary = aggregateUsage([], activity, {}, { days: 1, now: NOW });
    expect(summary.totals.activeMs).toBe(10_000);
  });
});

describe('aggregateUsage — cost', () => {
  it('周期内没有任何可定价记录时 cost 为 null', () => {
    const summary = aggregateUsage(
      [record({ ts: dayStart(0), model: 'unknown-model', input: 1000 })],
      [],
      {},
      {
        days: 1,
        now: NOW,
      }
    );
    expect(summary.totals.cost).toBeNull();
  });

  it('存在可定价记录时 cost 为数字之和', () => {
    const records = [record({ ts: dayStart(0), model: 'claude-opus-5', input: 1_000_000 })];
    const summary = aggregateUsage(records, [], PRICING, { days: 1, now: NOW });
    expect(summary.totals.cost).toBeCloseTo(15);
  });
});

describe('aggregateUsage — unpricedModels', () => {
  it('列出周期内出现过但无定价的模型，去重且只统计区间内的', () => {
    const records = [
      record({ ts: dayStart(0), model: 'unpriced-a', input: 10 }),
      record({ ts: dayStart(0), model: 'unpriced-a', input: 20 }),
      record({ ts: dayStart(0), model: 'unpriced-b', output: 5 }),
      record({ ts: dayStart(0) - 1, model: 'unpriced-out-of-range', input: 10 }),
    ];
    const summary = aggregateUsage(records, [], {}, { days: 1, now: NOW });
    expect(summary.unpricedModels.sort()).toEqual(['unpriced-a', 'unpriced-b']);
  });

  it('零 token 的 imported 或其它未定价记录不进入 unpricedModels，但有 token 的未知模型仍进入', () => {
    const records = [
      // 真实场景：导入外部会话生成的虚拟 imported 记录，token 全为 0
      record({
        ts: dayStart(0),
        model: 'imported',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
      // 零 token 的普通未知模型也不报缺价
      record({ ts: dayStart(0), model: 'zero-token-unknown', input: 0, output: 0 }),
      // 有 token 消耗的真实未知模型必须进入 unpricedModels 告警
      record({ ts: dayStart(0), model: 'real-unknown-model', input: 500 }),
    ];
    const summary = aggregateUsage(records, [], {}, { days: 1, now: NOW });
    expect(summary.unpricedModels).not.toContain('imported');
    expect(summary.unpricedModels).not.toContain('zero-token-unknown');
    expect(summary.unpricedModels).toContain('real-unknown-model');

    // 防回归强化：imported 仍保留在 byModel，且 messages=1、tokens=0、cost=null
    const importedRow = summary.byModel.find((row) => row.model === 'imported');
    expect(importedRow).toMatchObject({
      model: 'imported',
      messages: 1,
      tokens: 0,
      cost: null,
    });

    // totals.messages 与 totals.sessions 仍计入零 token 记录
    expect(summary.totals.messages).toBe(3);
    expect(summary.totals.sessions).toBe(1);

    // 真实有 token 未知模型在 byModel 中正常展示
    const realRow = summary.byModel.find((row) => row.model === 'real-unknown-model');
    expect(realRow).toMatchObject({
      model: 'real-unknown-model',
      messages: 1,
      tokens: 500,
      cost: null,
    });
  });
});

describe('aggregateUsage — 空输入', () => {
  it('空记录返回归零的 summary', () => {
    const summary = aggregateUsage([], [], {}, { days: 30, now: NOW });
    expect(summary.totals).toEqual({
      cost: null,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokens: 0,
      sessions: 0,
      messages: 0,
      activeMs: 0,
    });
    expect(summary.byModel).toEqual([]);
    expect(summary.byProject).toEqual([]);
    expect(summary.unpricedModels).toEqual([]);
    expect(summary.daily).toHaveLength(30);
  });
});
